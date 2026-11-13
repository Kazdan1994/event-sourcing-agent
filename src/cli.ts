import { loadCatalog } from "./agent-loop/catalog.ts";
import { callOllama } from "./agent-loop/model.ts";
import { resumeRun, RunError, startRun, type RunResult } from "./agent.ts";
import { isLocked, journalExists, JournalError, listRuns, read } from "./journal.ts";
import { replayEvents } from "./replay.ts";
import type { Event } from "./schema.ts";
import { fold, status } from "./state.ts";

const USAGE = `usage: bun run src/cli.ts <command>
  run "<question>" [--max-turns N]
  resume <runId>
  list
  show <runId>
  replay <runId> [--live-tools]`;

const EXIT = {
  ok: 0,
  modelFailed: 1,
  usage: 2,
  finished: 3,
  locked: 4,
  invalidJournal: 5,
  diverged: 6,
} as const;

const SUMMARY_CHARS = 100;

const summarize = (event: Event): string => {
  switch (event.kind) {
    case "run_started":
      return `run ${event.runId}: ${JSON.stringify(event.question)} (max ${event.maxTurns} turns, ${event.model})`;
    case "turn_started":
      return `turn ${event.turn}`;
    case "model_decision":
      return event.toolCall
        ? `decide ${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`
        : `decide text ${JSON.stringify(event.text.slice(0, 60))}`;
    case "model_failed":
      return `model failed: ${JSON.stringify(event.message)}`;
    case "tool_called":
      return `call ${event.name}`;
    case "tool_result":
      return `result ${JSON.stringify(event.data).slice(0, SUMMARY_CHARS)}${event.truncated ? " [truncated]" : ""}`;
    case "tool_error":
      return `error (${event.errorKind}) ${JSON.stringify(event.message)}`;
    case "run_resumed":
      return `resumed from seq ${event.fromSeq} by pid ${event.pid}${event.staleLockPid ? ` (stale lock ${event.staleLockPid})` : ""}`;
    case "run_ended":
      return `ended ${event.stop.type}${event.stop.type === "success" ? `: ${JSON.stringify(event.stop.answer)}` : ""}`;
  }
};

const printEvent = (event: Event) =>
  console.log(`${String(event.seq).padStart(3)} ${event.at.slice(11, 23)} ${event.kind.padEnd(14)} ${summarize(event)}`);

const printTotals = (result: RunResult) => {
  const { turns, toolCalls, retries, resumes, promptTokens, outputTokens, durationMs } =
    result.state.totals;
  console.log(
    `turns ${turns}/${result.state.maxTurns} | tool calls ${toolCalls} | retries ${retries} | resumes ${resumes} | tokens ${promptTokens}+${outputTokens} | model ${(durationMs / 1000).toFixed(1)} s`,
  );
};

const finish = (result: RunResult) => {
  if (result.tornTail) console.error(`warning: run ${result.runId}: dropped a torn last line`);
  printTotals(result);
  if (result.outcome === "interrupted") {
    console.error(`run ${result.runId} interrupted; resume with: resume ${result.runId}`);
    return EXIT.modelFailed;
  }
  return EXIT.ok;
};

const journalExit = (error: JournalError) =>
  error.code === "corrupt" ? EXIT.invalidJournal : EXIT.usage;

const readOrExit = (runId: string | undefined): Event[] | number => {
  if (!runId) return EXIT.usage;
  try {
    if (!journalExists(runId)) {
      console.error(`Unknown run ${runId}`);
      return EXIT.usage;
    }
    const { events, tornTail } = read(runId);
    if (tornTail) console.error(`warning: run ${runId}: torn last line ignored`);
    return events;
  } catch (error) {
    if (!(error instanceof JournalError)) throw error;
    console.error(error.message);
    return journalExit(error);
  }
};

const commands: Record<string, (args: string[]) => Promise<number>> = {
  run: async ([question, ...rest]) => {
    if (!question || question.startsWith("--")) return EXIT.usage;
    const flag = rest.indexOf("--max-turns");
    const maxTurns = flag === -1 ? undefined : Number(rest[flag + 1]);
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
      console.error(`--max-turns must be a positive integer, got "${rest[flag + 1]}"`);
      return EXIT.usage;
    }
    const catalog = await loadCatalog();
    return finish(
      await startRun(question, { maxTurns }, { callModel: callOllama, catalog, afterAppend: printEvent }),
    );
  },
  resume: async ([runId]) => {
    if (!runId) return EXIT.usage;
    const catalog = await loadCatalog();
    try {
      return finish(await resumeRun(runId, { callModel: callOllama, catalog, afterAppend: printEvent }));
    } catch (error) {
      if (error instanceof JournalError) {
        console.error(error.message);
        return journalExit(error);
      }
      if (!(error instanceof RunError)) throw error;
      console.error(error.message);
      return { unknown: EXIT.usage, finished: EXIT.finished, locked: EXIT.locked }[error.code];
    }
  },
  list: async () => {
    listRuns().forEach((runId) => {
      try {
        const state = fold(runId, read(runId).events);
        console.log(`${runId}  ${status(state, isLocked(runId)).padEnd(26)} turns ${state.turnsUsed}/${state.maxTurns}  ${JSON.stringify(state.question)}`);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        console.log(`${runId}  invalid: ${error.message}`);
      }
    });
    return EXIT.ok;
  },
  show: async ([runId]) => {
    const events = readOrExit(runId);
    if (typeof events === "number") return events;
    events.forEach(printEvent);
    return EXIT.ok;
  },
  replay: async ([runId, ...rest]) => {
    const events = readOrExit(runId);
    if (typeof events === "number") return events;
    const liveTools = rest.includes("--live-tools");
    const report = await replayEvents(runId!, events, {
      liveTools,
      catalog: liveTools ? await loadCatalog() : undefined,
    });
    console.log(`replay ${report.runId}: ${report.status} after ${report.steps} steps, model calls ${report.modelCalls}`);
    if (report.divergence) {
      console.log(`first divergence at seq ${report.divergence.seq}`);
      console.log(`  expected ${JSON.stringify(report.divergence.expected)}`);
      console.log(`  observed ${JSON.stringify(report.divergence.observed)}`);
      return EXIT.diverged;
    }
    return EXIT.ok;
  },
};

const [name, ...args] = Bun.argv.slice(2);
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(USAGE);
  process.exit(EXIT.usage);
}
const code = await command(args);
if (code === EXIT.usage && name !== "resume" && name !== "show" && name !== "replay") {
  console.error(USAGE);
}
process.exit(code);
