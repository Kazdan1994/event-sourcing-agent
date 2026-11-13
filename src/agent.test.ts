import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeCall } from "./agent-loop/loop.ts";
import type { ModelReply } from "./agent-loop/model.ts";
import { CATALOG } from "./agent-loop/tools.test.ts";
import { resumeRun, startRun, type ExecuteTool } from "./agent.ts";
import {
  HAPPY,
  scripted,
  textReply,
  toolReply,
  useTempRunsDir,
} from "./fixtures.test.ts";
import { acquire, read, release } from "./journal.ts";
import type { Event } from "./schema.ts";

const kinds = (events: readonly Event[]) => events.map((event) => event.kind);

const counting = () => {
  const calls: string[] = [];
  const executeTool: ExecuteTool = (call, prior) => {
    calls.push(JSON.stringify(call));
    return executeCall(call, CATALOG, prior);
  };
  return { executeTool, calls };
};

const crashAfter = (n: number) => (event: Event) => {
  if (event.seq === n) throw new Error(`crash after seq ${n}`);
};

describe("US1: every step is an event", () => {
  useTempRunsDir();

  test("success journals each turn, call and result, then one end", async () => {
    const run = await startRun("q", {}, { callModel: scripted(HAPPY).callModel, catalog: CATALOG });
    const step = [
      "turn_started",
      "model_decision",
      "tool_called",
      "tool_result",
    ] as const;
    expect(kinds(read(run.runId).events)).toEqual([
      "run_started",
      ...step,
      ...step,
      ...step,
      "run_ended",
    ]);
    expect(run.state.ending).toEqual({
      type: "success",
      answer: "570 EUR per year",
      amounts: [570],
    });
  });

  test("turn budget ends with budget_exhausted (turns)", async () => {
    const run = await startRun(
      "q",
      { maxTurns: 2 },
      { callModel: scripted([textReply("hmm")]).callModel, catalog: CATALOG },
    );
    expect(run.state.ending).toEqual({ type: "budget_exhausted", cause: "turns" });
    expect(kinds(run.events).filter((kind) => kind === "run_ended")).toHaveLength(1);
  });

  test("repeated identical calls end with budget_exhausted (no_progress)", async () => {
    const run = await startRun(
      "q",
      {},
      { callModel: scripted([toolReply("list_products")]).callModel, catalog: CATALOG },
    );
    expect(run.state.ending).toEqual({ type: "budget_exhausted", cause: "no_progress" });
  });

  test("an unknown product ends with tool_error", async () => {
    const run = await startRun(
      "q",
      {},
      {
        callModel: scripted([toolReply("get_plans", { product: "zzz" })]).callModel,
        catalog: CATALOG,
      },
    );
    expect(run.state.ending?.type).toBe("tool_error");
    expect(kinds(run.events).at(-2)).toBe("tool_error");
  });

  test("a model failure leaves the run interrupted, with no end event", async () => {
    const failing: ModelReply = { ok: false, message: "down" };
    const run = await startRun("q", {}, { callModel: scripted([failing]).callModel, catalog: CATALOG });
    expect(run.outcome).toBe("interrupted");
    expect(kinds(run.events)).toEqual(["run_started", "turn_started", "model_failed"]);
  });
});

describe("US2: resume after a crash", () => {
  const dir = useTempRunsDir();
  const TOTAL_EVENTS = 1 + 3 * 4 + 1;

  for (let n = 1; n < TOTAL_EVENTS; n++) {
    test(`crash after seq ${n}, resume, same ending, no recorded call re-run`, async () => {
      const first = counting();
      const model = scripted(HAPPY);
      const crash = await startRun("q", {}, {
        callModel: model.callModel,
        catalog: CATALOG,
        executeTool: first.executeTool,
        afterAppend: crashAfter(n),
      }).catch((error: Error) => error);
      expect(crash).toBeInstanceOf(Error);
      const [file] = new Bun.Glob("*.jsonl").scanSync(dir());
      const runId = file!.replace(".jsonl", "");

      const before = read(runId).events;
      const decided = before.filter((event) => event.kind === "model_decision").length;
      const answered = before.filter((event) => event.kind === "tool_result").length;
      const second = counting();
      const resumed = await resumeRun(runId, {
        callModel: scripted(HAPPY.slice(decided)).callModel,
        catalog: CATALOG,
        executeTool: second.executeTool,
      });
      expect(resumed.state.ending?.type).toBe("success");
      expect(second.calls).toHaveLength(3 - answered);
      expect(first.calls.length).toBeGreaterThanOrEqual(answered);
      expect(kinds(resumed.events)).toContain("run_resumed");
    });
  }

  test("a finished run is refused", async () => {
    const run = await startRun("q", {}, { callModel: scripted(HAPPY).callModel, catalog: CATALOG });
    await expect(resumeRun(run.runId, { callModel: scripted(HAPPY).callModel, catalog: CATALOG })).rejects.toThrow(
      "already finished",
    );
  });

  test("an unknown run is refused", async () => {
    await expect(
      resumeRun("20261029-120000-ffff", { callModel: scripted(HAPPY).callModel, catalog: CATALOG }),
    ).rejects.toThrow("Unknown run");
  });

  test("a run held by a live process is refused; a stale lock is taken over", async () => {
    const failing: ModelReply = { ok: false, message: "down" };
    const run = await startRun("q", {}, { callModel: scripted([failing]).callModel, catalog: CATALOG });
    acquire(run.runId);
    await expect(resumeRun(run.runId, { callModel: scripted(HAPPY).callModel, catalog: CATALOG })).rejects.toThrow(
      "held by live process",
    );
    release(run.runId);
    writeFileSync(join(dir(), `${run.runId}.lock`), "999999");
    const resumed = await resumeRun(run.runId, { callModel: scripted(HAPPY).callModel, catalog: CATALOG });
    expect(resumed.events.find((event) => event.kind === "run_resumed")).toMatchObject({
      staleLockPid: 999999,
    });
  });

  test("an interrupted turn still consumes the budget", async () => {
    const failing: ModelReply = { ok: false, message: "down" };
    const run = await startRun(
      "q",
      { maxTurns: 2 },
      { callModel: scripted([failing]).callModel, catalog: CATALOG },
    );
    const resumed = await resumeRun(run.runId, {
      callModel: scripted([textReply("hmm")]).callModel,
      catalog: CATALOG,
    });
    expect(resumed.state.turnsUsed).toBe(2);
    expect(resumed.state.ending).toEqual({ type: "budget_exhausted", cause: "turns" });
  });

  test("a torn last line is dropped on resume and the journal stays contiguous", async () => {
    const failing: ModelReply = { ok: false, message: "down" };
    const run = await startRun("q", {}, { callModel: scripted([failing]).callModel, catalog: CATALOG });
    appendFileSync(join(dir(), `${run.runId}.jsonl`), '{"runId":"2026');
    const resumed = await resumeRun(run.runId, { callModel: scripted(HAPPY).callModel, catalog: CATALOG });
    expect(resumed.tornTail).toBe(true);
    const { events, tornTail } = read(run.runId);
    expect(tornTail).toBe(false);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(resumed.state.ending?.type).toBe("success");
  });

  test("a refused resume leaves no lock behind", async () => {
    const run = await startRun("q", {}, { callModel: scripted(HAPPY).callModel, catalog: CATALOG });
    await expect(resumeRun(run.runId, { callModel: scripted(HAPPY).callModel, catalog: CATALOG })).rejects.toThrow(
      "already finished",
    );
    expect(existsSync(join(dir(), `${run.runId}.lock`))).toBe(false);
  });
});
