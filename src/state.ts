import { MAX_ARG_RETRIES } from "./agent-loop/config.ts";
import {
  capResult,
  isNoProgress,
  SYSTEM_PROMPT,
  type Turn,
  type TurnRequest,
} from "./agent-loop/loop.ts";
import type {
  Message,
  ToolCall,
} from "./agent-loop/model.ts";
import {
  FINAL_ANSWER,
  FinalAnswerArgs,
} from "./agent-loop/tools.ts";
import type { Event, Stop } from "./schema.ts";

export const NUDGE = "Call a tool, or final_answer if you have the answer.";

type DecisionEvent = Extract<Event, { kind: "model_decision" }>;

export type OpenStep =
  | { kind: "awaiting_decision"; turn: number }
  | { kind: "awaiting_call"; decision: DecisionEvent; call: ToolCall }
  | { kind: "awaiting_result"; decision: DecisionEvent; call: ToolCall };

type ToolStep = Exclude<OpenStep, { kind: "awaiting_decision" }>;

export type Totals = {
  turns: number;
  toolCalls: number;
  retries: number;
  resumes: number;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
};

export type AgentState = {
  runId: string;
  question: string;
  maxTurns: number;
  messages: Message[];
  turns: Turn[];
  turnsUsed: number;
  results: unknown[];
  argStreak: number;
  open?: OpenStep;
  ending?: Stop;
  lastSeq: number;
  totals: Totals;
};

const EMPTY_TOTALS: Totals = {
  turns: 0,
  toolCalls: 0,
  retries: 0,
  resumes: 0,
  promptTokens: 0,
  outputTokens: 0,
  durationMs: 0,
};

const requestOf = (decision: DecisionEvent): TurnRequest =>
  decision.toolCall
    ? {
        kind: "tool",
        name: decision.toolCall.name,
        args: decision.toolCall.arguments,
      }
    : { kind: "text", content: decision.text };

const completeTurn = (
  state: AgentState,
  decision: DecisionEvent,
  outcome: Turn["outcome"],
  toolText: string | undefined,
  truncated: boolean,
): AgentState => {
  const turn: Turn = {
    index: decision.turn,
    request: requestOf(decision),
    outcome,
    truncated,
    ...decision.usage,
  };
  const messages: Message[] = decision.toolCall
    ? [
        {
          role: "assistant",
          content: decision.text,
          tool_calls: [{ function: decision.toolCall }],
        },
        {
          role: "tool",
          content: toolText ?? "",
          tool_name: decision.toolCall.name,
        },
      ]
    : [
        { role: "assistant", content: decision.text },
        { role: "user", content: NUDGE },
      ];
  return {
    ...state,
    turns: [...state.turns, turn],
    messages: [...state.messages, ...messages],
    open: undefined,
  };
};

const toolStepOf = (state: AgentState, kind: string): ToolStep => {
  if (
    state.open?.kind !== "awaiting_result" &&
    state.open?.kind !== "awaiting_call"
  ) {
    throw new Error(`Run ${state.runId}: ${kind} without a model decision`);
  }
  return state.open;
};

export const applyEvent = (state: AgentState, event: Event): AgentState => {
  const next = { ...state, lastSeq: event.seq };
  switch (event.kind) {
    case "run_started":
      return {
        ...next,
        question: event.question,
        maxTurns: event.maxTurns,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: event.question },
        ],
      };
    case "turn_started":
      return {
        ...next,
        turnsUsed: next.turnsUsed + 1,
        open: { kind: "awaiting_decision", turn: event.turn },
        totals: { ...next.totals, turns: next.totals.turns + 1 },
      };
    case "model_decision": {
      const totals = {
        ...next.totals,
        toolCalls: next.totals.toolCalls + (event.toolCall ? 1 : 0),
        promptTokens: next.totals.promptTokens + event.usage.promptTokens,
        outputTokens: next.totals.outputTokens + event.usage.outputTokens,
        durationMs: next.totals.durationMs + event.usage.durationMs,
      };
      const withTotals = { ...next, totals };
      return event.toolCall
        ? {
            ...withTotals,
            open: { kind: "awaiting_call", decision: event, call: event.toolCall },
          }
        : completeTurn(withTotals, event, "nudged", undefined, false);
    }
    case "model_failed":
      return { ...next, open: undefined };
    case "tool_called":
      return {
        ...next,
        open: { ...toolStepOf(next, event.kind), kind: "awaiting_result" },
      };
    case "tool_result": {
      const { decision } = toolStepOf(next, event.kind);
      const capped = capResult(JSON.stringify(event.data));
      return {
        ...completeTurn(
          next,
          decision,
          { ok: true, data: event.data },
          capped.text,
          event.truncated,
        ),
        results: [...next.results, event.data],
        argStreak: 0,
      };
    }
    case "tool_error": {
      const { decision } = toolStepOf(next, event.kind);
      const capped = capResult(`Error (${event.errorKind}): ${event.message}`);
      const invalid = event.errorKind === "invalid_args";
      return {
        ...completeTurn(
          next,
          decision,
          { ok: false, kind: event.errorKind, message: event.message },
          capped.text,
          capped.truncated,
        ),
        argStreak: invalid ? next.argStreak + 1 : next.argStreak,
        totals: {
          ...next.totals,
          retries: next.totals.retries + (invalid ? 1 : 0),
        },
      };
    }
    case "run_resumed":
      return {
        ...next,
        totals: { ...next.totals, resumes: next.totals.resumes + 1 },
      };
    case "run_ended":
      return { ...next, ending: event.stop };
  }
};

export const fold = (runId: string, events: readonly Event[]): AgentState =>
  events.reduce(applyEvent, {
    runId,
    question: "",
    maxTurns: 0,
    messages: [],
    turns: [],
    turnsUsed: 0,
    results: [],
    argStreak: 0,
    lastSeq: 0,
    totals: EMPTY_TOTALS,
  });

const stopAfterLastTurn = (state: AgentState): Stop | undefined => {
  const last = state.turns.at(-1);
  if (!last || last.outcome === "nudged" || last.request.kind !== "tool") {
    return undefined;
  }
  if (last.outcome.ok) {
    return last.request.name === FINAL_ANSWER
      ? { type: "success", ...FinalAnswerArgs.parse(last.outcome.data) }
      : undefined;
  }
  const fatal =
    last.outcome.kind === "not_found" || state.argStreak > MAX_ARG_RETRIES;
  return fatal
    ? {
        type: "tool_error",
        tool: last.request.name,
        args: last.request.args,
        message: last.outcome.message,
      }
    : undefined;
};

export const decideStop = (state: AgentState): Stop | undefined => {
  const afterTurn = stopAfterLastTurn(state);
  if (afterTurn) return afterTurn;
  if (isNoProgress(state.turns)) {
    return { type: "budget_exhausted", cause: "no_progress" };
  }
  return state.turnsUsed >= state.maxTurns
    ? { type: "budget_exhausted", cause: "turns" }
    : undefined;
};

export type NextAction =
  | { type: "finished"; stop: Stop }
  | { type: "end"; stop: Stop }
  | { type: "turn"; turn: number }
  | { type: "call_tool"; turn: number; call: ToolCall };

export const nextAction = (state: AgentState): NextAction => {
  if (state.ending) return { type: "finished", stop: state.ending };
  const open = state.open;
  if (open?.kind === "awaiting_call" || open?.kind === "awaiting_result") {
    return {
      type: "call_tool",
      turn: open.decision.turn,
      call: open.call,
    };
  }
  const stop = decideStop(state);
  return stop
    ? { type: "end", stop }
    : { type: "turn", turn: state.turnsUsed + 1 };
};

export type RunStatus = "running" | "interrupted" | `finished:${Stop["type"]}`;

export const status = (state: AgentState, lockAlive: boolean): RunStatus =>
  state.ending
    ? `finished:${state.ending.type}`
    : lockAlive
      ? "running"
      : "interrupted";
