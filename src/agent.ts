import type { Catalog } from "./agent-loop/catalog.ts";
import {
  capResult,
  executeCall,
} from "./agent-loop/loop.ts";
import {
  EXTRACT_MODEL,
  MAX_TURNS,
} from "./agent-loop/config.ts";
import type {
  CallModel,
  ToolCall,
  Usage,
} from "./agent-loop/model.ts";
import {
  toOllamaTools,
  TOOLS,
  type ToolOutcome,
} from "./agent-loop/tools.ts";
import {
  acquire,
  append,
  dropTornTail,
  journalExists,
  read,
  release,
} from "./journal.ts";
import { newRunId, type Event, type EventBody } from "./schema.ts";
import { applyEvent, fold, nextAction, type AgentState } from "./state.ts";

export type Decision =
  | { type: "decided"; text: string; toolCall?: ToolCall; usage: Usage }
  | { type: "failed"; message: string }
  | { type: "interrupted" };

export type Decide = (state: AgentState) => Promise<Decision>;

export type ExecuteTool = (
  call: ToolCall,
  priorResults: readonly unknown[],
) => ToolOutcome;

export type Sink = (seq: number, body: EventBody) => Event;

export type DriveDeps = {
  decide: Decide;
  executeTool: ExecuteTool;
  sink: Sink;
  afterAppend?: (event: Event) => void;
};

export type DriveResult = {
  state: AgentState;
  events: Event[];
  outcome: "ended" | "interrupted";
};

const toolEvent = (
  turn: number,
  call: ToolCall,
  outcome: ToolOutcome,
): EventBody => {
  if (!outcome.ok) {
    return {
      kind: "tool_error",
      turn,
      name: call.name,
      errorKind: outcome.kind,
      message: outcome.message,
    };
  }
  const { truncated } = capResult(JSON.stringify(outcome.data));
  return {
    kind: "tool_result",
    turn,
    name: call.name,
    data: outcome.data,
    truncated,
  };
};

const decisionEvent = (
  turn: number,
  decision: Exclude<Decision, { type: "interrupted" }>,
): EventBody =>
  decision.type === "decided"
    ? {
        kind: "model_decision",
        turn,
        text: decision.text,
        toolCall: decision.toolCall,
        usage: decision.usage,
      }
    : {
        kind: "model_failed",
        turn,
        message: decision.message,
      };

export const drive = async (
  runId: string,
  initial: readonly Event[],
  deps: DriveDeps,
): Promise<DriveResult> => {
  let events = [...initial];
  let state = fold(runId, events);
  const emit = (body: EventBody) => {
    const event = deps.sink(events.length + 1, body);
    events = [...events, event];
    deps.afterAppend?.(event);
    state = applyEvent(state, event);
  };
  const done = (outcome: DriveResult["outcome"]) => ({
    state,
    events,
    outcome,
  });

  for (;;) {
    const action = nextAction(state);
    if (action.type === "finished") return done("ended");
    if (action.type === "end") {
      emit({ kind: "run_ended", stop: action.stop });
      return done("ended");
    }
    if (action.type === "call_tool") {
      if (state.open?.kind === "awaiting_call") {
        emit({
          kind: "tool_called",
          turn: action.turn,
          name: action.call.name,
          arguments: action.call.arguments,
        });
      }
      const outcome = deps.executeTool(action.call, state.results);
      emit(toolEvent(action.turn, action.call, outcome));
      continue;
    }
    emit({ kind: "turn_started", turn: action.turn });
    const decision = await deps.decide(state);
    if (decision.type === "interrupted") return done("interrupted");
    emit(decisionEvent(action.turn, decision));
    if (decision.type === "failed") return done("interrupted");
  }
};

export const liveDecide =
  (callModel: CallModel): Decide =>
  async (state) => {
    const reply = await callModel(state.messages, toOllamaTools(TOOLS));
    if (!reply.ok) return { type: "failed", message: reply.message };
    return {
      type: "decided",
      text: reply.text,
      toolCall: reply.toolCalls[0],
      usage: reply.usage,
    };
  };

export const catalogTools =
  (catalog: Catalog): ExecuteTool =>
  (call, priorResults) =>
    executeCall(call, catalog, priorResults);

export class RunError extends Error {
  constructor(
    message: string,
    readonly code: "unknown" | "finished" | "locked",
  ) {
    super(message);
  }
}

export type LiveDeps = {
  callModel: CallModel;
  catalog: Catalog;
  executeTool?: ExecuteTool;
  afterAppend?: (event: Event) => void;
};

export type RunResult = DriveResult & { runId: string; tornTail: boolean };

const journalSink =
  (runId: string): Sink =>
  (seq, body) =>
    append(runId, seq, body);

const driveLocked = async (
  runId: string,
  first: EventBody,
  existing: readonly Event[],
  deps: LiveDeps,
  tornTail: boolean,
): Promise<RunResult> => {
  const sink = journalSink(runId);
  const head = sink(existing.length + 1, first);
  deps.afterAppend?.(head);
  const result = await drive(runId, [...existing, head], {
    decide: liveDecide(deps.callModel),
    executeTool: deps.executeTool ?? catalogTools(deps.catalog),
    sink,
    afterAppend: deps.afterAppend,
  });
  return { ...result, runId, tornTail };
};

const lockOrThrow = (runId: string) => {
  const lock = acquire(runId);
  if (!lock.ok) {
    throw new RunError(
      `Run ${runId} is held by live process ${lock.heldBy}`,
      "locked",
    );
  }
  return lock;
};

export const startRun = async (
  question: string,
  options: { maxTurns?: number; model?: string },
  deps: LiveDeps,
): Promise<RunResult> => {
  const runId = newRunId();
  lockOrThrow(runId);
  try {
    return await driveLocked(
      runId,
      {
        kind: "run_started",
        question,
        maxTurns: options.maxTurns ?? MAX_TURNS,
        model: options.model ?? EXTRACT_MODEL,
      },
      [],
      deps,
      false,
    );
  } finally {
    release(runId);
  }
};

export const resumeRun = async (
  runId: string,
  deps: LiveDeps,
): Promise<RunResult> => {
  if (!journalExists(runId)) {
    throw new RunError(`Unknown run ${runId}`, "unknown");
  }
  const lock = lockOrThrow(runId);
  try {
    const { events, tornTail } = read(runId);
    if (fold(runId, events).ending) {
      throw new RunError(`Run ${runId} is already finished`, "finished");
    }
    if (tornTail) dropTornTail(runId, events);
    return await driveLocked(
      runId,
      {
        kind: "run_resumed",
        fromSeq: events.length,
        pid: process.pid,
        staleLockPid: lock.staleLockPid,
      },
      events,
      deps,
      tornTail,
    );
  } finally {
    release(runId);
  }
};
