import { describe, expect, test } from "bun:test";
import type { Event, EventBody } from "./schema.ts";
import { fold, nextAction, status } from "./state.ts";
import { usage } from "./fixtures.test.ts";

const RUN = "20261029-120000-abcd";

const events = (...bodies: EventBody[]): Event[] =>
  bodies.map(
    (body, index) =>
      ({ runId: RUN, seq: index + 1, at: "2026-10-29T12:00:00.000Z", ...body }) as Event,
  );

const start: EventBody = {
  kind: "run_started",
  question: "q",
  maxTurns: 3,
  model: "m",
};
const call = (turn: number, name: string, args = {}): EventBody[] => [
  { kind: "turn_started", turn },
  {
    kind: "model_decision",
    turn,
    text: "",
    toolCall: { name, arguments: args },
    usage,
  },
  { kind: "tool_called", turn, name, arguments: args },
];
const result = (turn: number, name: string, data: unknown): EventBody => ({
  kind: "tool_result",
  turn,
  name,
  data,
  truncated: false,
});

describe("fold", () => {
  test("a full success run folds into an ending and summed totals", () => {
    const state = fold(
      RUN,
      events(
        start,
        ...call(1, "get_plans", { product: "notion" }),
        result(1, "get_plans", { plans: [] }),
        { kind: "run_resumed", fromSeq: 5, pid: 1 },
        ...call(2, "final_answer", { answer: "a", amounts: [] }),
        result(2, "final_answer", { answer: "a", amounts: [] }),
        { kind: "run_ended", stop: { type: "success", answer: "a", amounts: [] } },
      ),
    );
    expect(state.ending?.type).toBe("success");
    expect(state.totals).toMatchObject({
      turns: 2,
      toolCalls: 2,
      resumes: 1,
      promptTokens: 20,
    });
    expect(state.messages).toHaveLength(6);
    expect(status(state, false)).toBe("finished:success");
  });

  test("an interrupted turn counts toward the budget", () => {
    const state = fold(RUN, events(start, { kind: "turn_started", turn: 1 }));
    expect(state.turnsUsed).toBe(1);
    expect(nextAction(state)).toEqual({ type: "turn", turn: 2 });
    expect(status(state, false)).toBe("interrupted");
  });
});

describe("nextAction", () => {
  test("after run_started, start turn 1", () => {
    expect(nextAction(fold(RUN, events(start)))).toEqual({ type: "turn", turn: 1 });
  });

  test("a decision without tool_called calls the tool", () => {
    const state = fold(RUN, events(start, ...call(1, "list_products").slice(0, 2)));
    expect(state.open?.kind).toBe("awaiting_call");
    expect(nextAction(state)).toMatchObject({ type: "call_tool", turn: 1 });
  });

  test("a tool_called without result re-runs the tool", () => {
    const state = fold(RUN, events(start, ...call(1, "list_products")));
    expect(state.open?.kind).toBe("awaiting_result");
    expect(nextAction(state)).toMatchObject({ type: "call_tool", turn: 1 });
  });

  test("a final_answer result ends with success", () => {
    const answer = { answer: "a", amounts: [] };
    const state = fold(
      RUN,
      events(start, ...call(1, "final_answer", answer), result(1, "final_answer", answer)),
    );
    expect(nextAction(state)).toEqual({
      type: "end",
      stop: { type: "success", ...answer },
    });
  });

  test("a not_found error ends with tool_error", () => {
    const state = fold(
      RUN,
      events(start, ...call(1, "get_plans", { product: "x" }), {
        kind: "tool_error",
        turn: 1,
        name: "get_plans",
        errorKind: "not_found",
        message: "nope",
      }),
    );
    expect(nextAction(state)).toMatchObject({
      type: "end",
      stop: { type: "tool_error", tool: "get_plans" },
    });
  });

  test("the turn budget ends with budget_exhausted", () => {
    const turns = [1, 2, 3].flatMap((turn): EventBody[] => [
      { kind: "turn_started", turn },
      { kind: "model_failed", turn, message: "down" },
    ]);
    expect(nextAction(fold(RUN, events(start, ...turns)))).toEqual({
      type: "end",
      stop: { type: "budget_exhausted", cause: "turns" },
    });
  });

  test("a finished run stays finished", () => {
    const state = fold(
      RUN,
      events(start, { kind: "run_ended", stop: { type: "budget_exhausted", cause: "turns" } }),
    );
    expect(nextAction(state).type).toBe("finished");
  });
});
