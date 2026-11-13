import { describe, expect, test } from "bun:test";
import { CATALOG } from "./agent-loop/tools.test.ts";
import { resumeRun, startRun } from "./agent.ts";
import { HAPPY, scripted, useTempRunsDir } from "./fixtures.test.ts";
import { read } from "./journal.ts";
import { replayEvents } from "./replay.ts";
import type { Event } from "./schema.ts";

const recordRun = async () => {
  const run = await startRun("q", {}, { callModel: scripted(HAPPY).callModel, catalog: CATALOG });
  return { runId: run.runId, events: read(run.runId).events };
};

const editAt = (events: readonly Event[], seq: number, patch: Partial<Event>) =>
  events.map((event) => (event.seq === seq ? ({ ...event, ...patch } as Event) : event));

describe("US3: replay without the model", () => {
  useTempRunsDir();

  test("an unmodified journal replays as a match with zero model calls", async () => {
    const { runId, events } = await recordRun();
    const report = await replayEvents(runId, events);
    expect(report).toMatchObject({ status: "match", modelCalls: 0, steps: events.length });
  });

  test("an edited tool_called diverges at that seq", async () => {
    const { runId, events } = await recordRun();
    const called = events.find((event) => event.kind === "tool_called")!;
    const report = await replayEvents(
      runId,
      editAt(events, called.seq, { arguments: { product: "tally" } } as Partial<Event>),
    );
    expect(report.status).toBe("diverged");
    expect(report.divergence?.seq).toBe(called.seq);
  });

  test("an edited decision diverges downstream at the next derived event", async () => {
    const { runId, events } = await recordRun();
    const decision = events.find((event) => event.kind === "model_decision")!;
    const report = await replayEvents(
      runId,
      editAt(events, decision.seq, {
        toolCall: { name: "get_plans", arguments: { product: "tally" } },
      } as Partial<Event>),
    );
    expect(report.status).toBe("diverged");
    expect(report.divergence?.seq).toBe(decision.seq + 1);
  });

  test("an edited final result changes the ending and diverges at run_ended", async () => {
    const { runId, events } = await recordRun();
    const last = events.filter((event) => event.kind === "tool_result").at(-1)!;
    const report = await replayEvents(
      runId,
      editAt(events, last.seq, { data: { answer: "edited", amounts: [570] } } as Partial<Event>),
    );
    expect(report.status).toBe("diverged");
    expect(report.divergence?.seq).toBe(events.at(-1)!.seq);
  });

  test("live tools catch an edited tool result", async () => {
    const { runId, events } = await recordRun();
    const first = events.find((event) => event.kind === "tool_result")!;
    const report = await replayEvents(
      runId,
      editAt(events, first.seq, { data: { plans: [] } } as Partial<Event>),
      { liveTools: true, catalog: CATALOG },
    );
    expect(report.divergence?.seq).toBe(first.seq);
  });

  test("a crashed then resumed run replays as a match", async () => {
    const crash = await startRun("q", {}, {
      callModel: scripted(HAPPY).callModel,
      catalog: CATALOG,
      afterAppend: (event) => {
        if (event.seq === 7) throw new Error("crash");
      },
    }).catch(() => undefined);
    expect(crash).toBeUndefined();
    const [file] = new Bun.Glob("*.jsonl").scanSync(process.env.S15_RUNS_DIR!);
    const runId = file!.replace(".jsonl", "");
    const decided = read(runId).events.filter((event) => event.kind === "model_decision").length;
    await resumeRun(runId, { callModel: scripted(HAPPY.slice(decided)).callModel, catalog: CATALOG });
    const report = await replayEvents(runId, read(runId).events);
    expect(report.status).toBe("match");
  });

  test("an empty journal or one not starting with run_started diverges at seq 1", async () => {
    const { runId, events } = await recordRun();
    expect(await replayEvents(runId, [])).toMatchObject({ status: "diverged", divergence: { seq: 1 } });
    expect(await replayEvents(runId, events.slice(1))).toMatchObject({
      status: "diverged",
      divergence: { seq: 1 },
    });
  });

  test("a journal with extra events after the end diverges at the first extra one", async () => {
    const { runId, events } = await recordRun();
    const last = events.at(-1)!;
    const extra = { ...last, seq: last.seq + 1 };
    const report = await replayEvents(runId, [...events, extra]);
    expect(report).toMatchObject({ status: "diverged", divergence: { seq: extra.seq } });
  });
});
