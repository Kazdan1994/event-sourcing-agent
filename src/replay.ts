import type { Catalog } from "./agent-loop/catalog.ts";
import type { ToolOutcome } from "./agent-loop/tools.ts";
import {
  catalogTools,
  drive,
  type Decision,
  type ExecuteTool,
  type Sink,
} from "./agent.ts";
import type { Event, EventBody } from "./schema.ts";

type Comparable = Partial<EventBody>;

export type ReplayReport = {
  runId: string;
  status: "match" | "diverged";
  steps: number;
  divergence?: { seq: number; expected?: Comparable; observed?: Comparable };
  modelCalls: 0;
};

const comparable = (event: Event): Comparable => {
  const { runId, seq, at, ...body } = event;
  if (body.kind !== "model_decision") return body;
  const { usage, ...rest } = body;
  return rest;
};

const recordedDecisions = (events: readonly Event[]) =>
  events.reduce((decisions, event) => {
    if (event.kind === "turn_started") {
      return new Map(decisions).set(event.turn, { type: "interrupted" });
    }
    if (event.kind === "model_decision") {
      return new Map(decisions).set(event.turn, {
        type: "decided",
        text: event.text,
        toolCall: event.toolCall,
        usage: event.usage,
      });
    }
    if (event.kind === "model_failed") {
      return new Map(decisions).set(event.turn, {
        type: "failed",
        message: event.message,
      });
    }
    return decisions;
  }, new Map<number, Decision>());

const recordedOutcomes = (events: readonly Event[]): ToolOutcome[] =>
  events.flatMap((event): ToolOutcome[] => {
    if (event.kind === "tool_result") return [{ ok: true, data: event.data }];
    if (event.kind === "tool_error") {
      return [{ ok: false, kind: event.errorKind, message: event.message }];
    }
    return [];
  });

class Diverged extends Error {}

export const replayEvents = async (
  runId: string,
  original: readonly Event[],
  options: { liveTools?: boolean; catalog?: Catalog } = {},
): Promise<ReplayReport> => {
  const expected = original.filter((event) => event.kind !== "run_resumed");
  const decisions = recordedDecisions(expected);
  const outcomes = recordedOutcomes(expected);
  let produced = 0;
  let toolRuns = 0;
  let divergence: ReplayReport["divergence"];
  const report = (): ReplayReport => ({
    runId,
    status: divergence ? "diverged" : "match",
    steps: produced,
    divergence,
    modelCalls: 0,
  });

  const sink: Sink = (seq, body) => {
    const event = { runId, seq, at: new Date().toISOString(), ...body } as Event;
    const want = expected[produced];
    produced += 1;
    if (!want || !Bun.deepEquals(comparable(want), comparable(event))) {
      divergence = {
        seq: want?.seq ?? (original.at(-1)?.seq ?? 0) + 1,
        expected: want && comparable(want),
        observed: comparable(event),
      };
      throw new Diverged();
    }
    return event;
  };
  const recordedTool: ExecuteTool = () =>
    outcomes[toolRuns++] ?? {
      ok: false,
      kind: "not_found",
      message: "no recorded tool result",
    };
  const executeTool =
    options.liveTools && options.catalog
      ? catalogTools(options.catalog)
      : recordedTool;

  const first = expected[0];
  if (!first || first.kind !== "run_started") {
    return { ...report(), status: "diverged", divergence: { seq: 1 } };
  }
  try {
    let events = [sink(1, comparable(first) as EventBody)];
    while (produced < expected.length) {
      const result = await drive(runId, events, {
        decide: async (state) =>
          decisions.get(state.turnsUsed) ?? { type: "interrupted" },
        executeTool,
        sink,
      });
      events = result.events;
      if (result.outcome === "ended") break;
    }
  } catch (error) {
    if (!(error instanceof Diverged)) throw error;
    return report();
  }
  const leftover = expected[produced];
  if (leftover) {
    divergence = { seq: leftover.seq, expected: comparable(leftover) };
  }
  return report();
};
