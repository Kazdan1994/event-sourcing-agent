import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listRuns, runsDir } from "./journal.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const QUESTION =
  process.argv[2] ?? "How much is Notion Plus for 5 seats, billed monthly?";
const POLL_MS = 50;
const TIMEOUT_MS = 180_000;

const cli = (...args: string[]) =>
  Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "inherit" });

const waitFor = async (check: () => string | undefined) => {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() - started > TIMEOUT_MS) throw new Error("demo timed out");
    await Bun.sleep(POLL_MS);
  }
};

const journalText = (runId: string) => {
  const path = join(runsDir(), `${runId}.jsonl`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const runAndPrint = async (label: string, ...args: string[]) => {
  console.log(`\n$ cli ${args.join(" ")}   # ${label}`);
  const child = cli(...args);
  const output = await new Response(child.stdout).text();
  process.stdout.write(output);
  return { code: await child.exited, output };
};

const before = new Set(listRuns());
console.log(`$ cli run ${JSON.stringify(QUESTION)}   # killed after first tool_result`);
const child = cli("run", QUESTION);
const runId = await waitFor(() => listRuns().find((id) => !before.has(id)));
await waitFor(() => (journalText(runId).includes('"kind":"tool_result"') ? "ok" : undefined));
child.kill("SIGKILL");
await child.exited;
const linesAtKill = journalText(runId).trim().split("\n").length;
console.log(`SIGKILL sent to pid ${child.pid}; journal has ${linesAtKill} events`);

await runAndPrint("interrupted, stale lock left behind", "list");

const resumeStarted = Date.now();
const resume = cli("resume", runId);
await waitFor(() =>
  journalText(runId).trim().split("\n").length > linesAtKill + 1 ? "ok" : undefined,
);
const resumeLatencyMs = Date.now() - resumeStarted;
process.stdout.write(`\n$ cli resume ${runId}\n${await new Response(resume.stdout).text()}`);
const resumeCode = await resume.exited;

await runAndPrint("one continuous journal", "show", runId);
const replay = await runAndPrint("no model call", "replay", runId);
const again = await runAndPrint("refused", "resume", runId);

console.log(`
summary: resume exit ${resumeCode}, resume-to-next-event ${resumeLatencyMs} ms (SC-005 < 2000 ms), replay exit ${replay.code}, second resume exit ${again.code} (expect 3)`);
