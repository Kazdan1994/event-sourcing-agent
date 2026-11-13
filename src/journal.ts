import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Event, RunId, type EventBody } from "./schema.ts";

const DEFAULT_RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));
const SUFFIX = ".jsonl";

export class JournalError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_id" | "unknown" | "corrupt",
  ) {
    super(message);
  }
}

export const runsDir = () => process.env.S15_RUNS_DIR ?? DEFAULT_RUNS_DIR;

const pathFor = (runId: string, extension: string) => {
  const parsed = RunId.safeParse(runId);
  if (!parsed.success) throw new JournalError(`Invalid run id "${runId}"`, "invalid_id");
  return join(runsDir(), `${parsed.data}${extension}`);
};

export const journalExists = (runId: string) =>
  existsSync(pathFor(runId, SUFFIX));

export const append = (
  runId: string,
  seq: number,
  body: EventBody,
): Event => {
  const path = pathFor(runId, SUFFIX);
  const event = Event.parse({
    runId,
    seq,
    at: new Date().toISOString(),
    ...body,
  });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return event;
};

export type ReadResult = { events: Event[]; tornTail: boolean };

export const parseJournal = (runId: string, text: string): ReadResult => {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const events: Event[] = [];
  let tornTail = false;
  lines.forEach((line, index) => {
    const expectedSeq = events.length + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = undefined;
    }
    const parsed = Event.safeParse(raw);
    const isLast = index === lines.length - 1;
    if (!parsed.success) {
      if (isLast) {
        tornTail = true;
        return;
      }
      throw new JournalError(
        `Run ${runId}: invalid event at seq ${expectedSeq}`,
        "corrupt",
      );
    }
    if (parsed.data.runId !== runId || parsed.data.seq !== expectedSeq) {
      throw new JournalError(
        `Run ${runId}: expected seq ${expectedSeq}, found seq ${parsed.data.seq} of run ${parsed.data.runId}`,
        "corrupt",
      );
    }
    events.push(parsed.data);
  });
  return { events, tornTail };
};

export const read = (runId: string): ReadResult => {
  const path = pathFor(runId, SUFFIX);
  if (!existsSync(path)) throw new JournalError(`Unknown run ${runId}`, "unknown");
  return parseJournal(runId, readFileSync(path, "utf8"));
};

const writeDurably = (path: string, text: string) => {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const syncDir = (dir: string) => {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const dropTornTail = (runId: string, events: readonly Event[]) => {
  const path = pathFor(runId, SUFFIX);
  const temp = `${path}.${process.pid}.tmp`;
  writeDurably(temp, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  renameSync(temp, path);
  syncDir(runsDir());
};

export const listRuns = (): RunId[] => {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .filter((file) => file.endsWith(SUFFIX))
    .map((file) => file.slice(0, -SUFFIX.length))
    .filter((id) => RunId.safeParse(id).success)
    .sort();
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isErrno = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException).code === code;

const pidIn = (path: string): number | undefined => {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  const pid = Number(text);
  return text !== "" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

const lockPid = (runId: string) => pidIn(pathFor(runId, ".lock"));

export const isLocked = (runId: string) => {
  const pid = lockPid(runId);
  return pid !== undefined && isAlive(pid);
};

export type Lock =
  | { ok: true; staleLockPid?: number }
  | { ok: false; heldBy: number };

const createLock = (path: string): boolean => {
  const temp = `${path}.${process.pid}.tmp`;
  writeDurably(temp, String(process.pid));
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
};

const evictStale = (path: string, stalePid: number | undefined): Lock | undefined => {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const moved = pidIn(aside);
  if (moved !== undefined && moved !== stalePid && isAlive(moved)) {
    createLockFrom(aside, path);
    return { ok: false, heldBy: moved };
  }
  rmSync(aside, { force: true });
  return undefined;
};

const createLockFrom = (source: string, path: string) => {
  try {
    linkSync(source, path);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  } finally {
    rmSync(source, { force: true });
  }
};

const MAX_LOCK_ATTEMPTS = 3;

export const acquire = (runId: string, attempt = 1): Lock => {
  const path = pathFor(runId, ".lock");
  if (createLock(path)) return { ok: true };
  const holder = lockPid(runId);
  if (holder !== undefined && isAlive(holder)) {
    return { ok: false, heldBy: holder };
  }
  const refused = evictStale(path, holder);
  if (refused) return refused;
  if (createLock(path)) {
    return holder === undefined ? { ok: true } : { ok: true, staleLockPid: holder };
  }
  if (attempt < MAX_LOCK_ATTEMPTS) return acquire(runId, attempt + 1);
  const winner = lockPid(runId);
  if (winner === undefined) {
    throw new Error(`Run ${runId}: lock contended, gave up after ${attempt} attempts`);
  }
  return { ok: false, heldBy: winner };
};

export const release = (runId: string) => {
  const path = pathFor(runId, ".lock");
  if (lockPid(runId) === process.pid) rmSync(path);
};
