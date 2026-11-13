import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempRunsDir } from "./fixtures.test.ts";
import {
  acquire,
  append,
  dropTornTail,
  isLocked,
  JournalError,
  listRuns,
  read,
  release,
} from "./journal.ts";

const RUN = "20261029-120000-abcd";
const START = {
  kind: "run_started",
  question: "q",
  maxTurns: 8,
  model: "m",
} as const;

describe("journal", () => {
  const dir = useTempRunsDir();

  test("append then read round trip", () => {
    append(RUN, 1, START);
    append(RUN, 2, { kind: "turn_started", turn: 1 });
    const { events, tornTail } = read(RUN);
    expect(events.map((event) => event.kind)).toEqual([
      "run_started",
      "turn_started",
    ]);
    expect(tornTail).toBe(false);
    expect(listRuns()).toEqual([RUN]);
  });

  test("a torn last line is dropped and reported", () => {
    append(RUN, 1, START);
    appendFileSync(join(dir(), `${RUN}.jsonl`), '{"runId":"2026');
    const { events, tornTail } = read(RUN);
    expect(events).toHaveLength(1);
    expect(tornTail).toBe(true);
  });

  test("an invalid middle line throws with its seq", () => {
    append(RUN, 1, START);
    appendFileSync(join(dir(), `${RUN}.jsonl`), "garbage\n");
    append(RUN, 3, { kind: "turn_started", turn: 1 });
    expect(() => read(RUN)).toThrow("invalid event at seq 2");
  });

  test("a seq gap throws", () => {
    append(RUN, 1, START);
    append(RUN, 3, { kind: "turn_started", turn: 1 });
    expect(() => read(RUN)).toThrow("expected seq 2");
  });

  test("an invalid run id is rejected before any file access", () => {
    expect(() => read("../../etc/passwd")).toThrow(JournalError);
    expect(() => append("../x", 1, START)).toThrow(JournalError);
  });

  test("a live lock refuses, a dead lock is taken over", () => {
    expect(acquire(RUN)).toEqual({ ok: true });
    expect(isLocked(RUN)).toBe(true);
    expect(acquire(RUN)).toEqual({ ok: false, heldBy: process.pid });
    release(RUN);
    writeFileSync(join(dir(), `${RUN}.lock`), "999999");
    expect(acquire(RUN)).toEqual({ ok: true, staleLockPid: 999999 });
    release(RUN);
  });

  test("an empty or garbage lock file is stale, not held by pid 0", () => {
    for (const content of ["", "garbage", "0", "-1"]) {
      writeFileSync(join(dir(), `${RUN}.lock`), content);
      expect(isLocked(RUN)).toBe(false);
      expect(acquire(RUN)).toEqual({ ok: true });
      release(RUN);
    }
  });

  test("release leaves a lock held by another pid", () => {
    writeFileSync(join(dir(), `${RUN}.lock`), "999999");
    release(RUN);
    expect(existsSync(join(dir(), `${RUN}.lock`))).toBe(true);
  });

  test("dropTornTail rewrites the journal without the torn line", () => {
    append(RUN, 1, START);
    appendFileSync(join(dir(), `${RUN}.jsonl`), '{"runId":"2026');
    dropTornTail(RUN, read(RUN).events);
    expect(read(RUN)).toMatchObject({ tornTail: false, events: [{ seq: 1 }] });
    expect(readdirSync(dir())).toEqual([`${RUN}.jsonl`]);
  });

  test("journal errors carry a code", () => {
    expect(() => read("../x")).toThrow(expect.objectContaining({ code: "invalid_id" }));
    expect(() => read(RUN)).toThrow(expect.objectContaining({ code: "unknown" }));
    append(RUN, 1, START);
    append(RUN, 3, { kind: "turn_started", turn: 1 });
    expect(() => read(RUN)).toThrow(expect.objectContaining({ code: "corrupt" }));
  });
});
