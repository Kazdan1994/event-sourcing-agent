import type { Catalog } from "./catalog.ts";
import {
  MAX_ARG_RETRIES,
  MAX_TURNS,
  NO_PROGRESS_LIMIT,
  RESULT_MAX_CHARS,
} from "./config.ts";
import type { CallModel, Message, ToolCall } from "./model.ts";
import {
  FINAL_ANSWER,
  FinalAnswerArgs,
  toOllamaTools,
  TOOLS,
  type ToolDefinition,
  type ToolOutcome,
  unseenAmounts,
} from "./tools.ts";

export type TurnRequest =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "text"; content: string };

export type Turn = {
  index: number;
  request: TurnRequest;
  outcome: ToolOutcome | "nudged";
  truncated: boolean;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
};

export type StopReason =
  | { type: "success"; answer: string; amounts: number[] }
  | {
      type: "budget_exhausted";
      cause: "turns" | "no_progress" | "tokens" | "time";
    }
  | {
      type: "tool_error";
      tool: string;
      args: Record<string, unknown>;
      message: string;
    }
  | { type: "model_error"; message: string };

export type Run = {
  question: string;
  maxTurns: number;
  turns: Turn[];
  stop: StopReason;
  totals: {
    turns: number;
    toolCalls: number;
    retries: number;
    promptTokens: number;
    outputTokens: number;
    durationMs: number;
  };
};

export type Budget = { maxPromptTokens?: number; maxDurationMs?: number };

export type RunOptions = {
  maxTurns?: number;
  tools?: readonly ToolDefinition[];
  systemPrompt?: string;
  budget?: Budget;
  maxNudges?: number;
};

export const SYSTEM_PROMPT = `You answer questions about SaaS pricing using the tools.
- Call get_plans directly with the product named in the question, in lowercase ("Notion" -> "notion"). Never replace it with another product.
- Use list_products only when the question does not name a product.
- Never compute prices yourself: use price_for_seats for every amount.
- Call one tool at a time.
- Finish with final_answer. Its amounts must be numbers returned by earlier tools.`;

const NUDGE = "Call a tool, or final_answer if you have the answer.";

export const capResult = (text: string, max = RESULT_MAX_CHARS) =>
  text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, max)} [truncated]`, truncated: true };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const requestKey = (request: TurnRequest) =>
  request.kind === "tool"
    ? `${request.name}:${canonical(request.args)}`
    : `text`;

export const isNoProgress = (
  turns: readonly Turn[],
  limit = NO_PROGRESS_LIMIT,
) => {
  if (turns.length < limit) return false;
  const last = turns.slice(-limit).map((turn) => turn.request);
  return (
    last[0]?.kind === "tool" &&
    last.every((request) => requestKey(request) === requestKey(last[0]!))
  );
};

export const nudgeStreak = (turns: readonly Turn[]) => {
  const lastTool = turns.findLastIndex((turn) => turn.outcome !== "nudged");
  return turns.length - 1 - lastTool;
};

const invalidArgs = (message: string): ToolOutcome => ({
  ok: false,
  kind: "invalid_args",
  message,
});

export const executeCall = (
  call: ToolCall,
  catalog: Catalog,
  priorResults: readonly unknown[],
  tools: readonly ToolDefinition[] = TOOLS,
): ToolOutcome => {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return invalidArgs(
      `Unknown tool "${call.name}". Valid tools: ${tools.map((t) => t.name).join(", ")}.`,
    );
  }
  const parsed = tool.args.safeParse(call.arguments);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    return invalidArgs(
      `Invalid arguments for ${call.name}: ${issues.join("; ")}`,
    );
  }
  if (call.name === FINAL_ANSWER) {
    const unseen = unseenAmounts(
      FinalAnswerArgs.parse(parsed.data).amounts,
      priorResults,
    );
    if (unseen.length > 0) {
      return invalidArgs(
        `Amounts ${unseen.join(", ")} were not returned by any tool. Use price_for_seats first.`,
      );
    }
  }
  return tool.handler(parsed.data, catalog);
};

const sumTotals = (turns: readonly Turn[]): Run["totals"] => ({
  turns: turns.length,
  toolCalls: turns.filter((turn) => turn.request.kind === "tool").length,
  retries: turns.filter(
    (turn) =>
      turn.outcome !== "nudged" &&
      !turn.outcome.ok &&
      turn.outcome.kind === "invalid_args",
  ).length,
  promptTokens: turns.reduce((sum, turn) => sum + turn.promptTokens, 0),
  outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
  durationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
});

export const budgetCause = (
  totals: Run["totals"],
  budget: Budget,
): "tokens" | "time" | undefined => {
  if (
    budget.maxPromptTokens !== undefined &&
    totals.promptTokens > budget.maxPromptTokens
  )
    return "tokens";
  if (
    budget.maxDurationMs !== undefined &&
    totals.durationMs > budget.maxDurationMs
  )
    return "time";
  return undefined;
};

type Step = {
  base: Pick<Turn, "request" | "outcome" | "truncated">;
  messages: Message[];
  stop?: StopReason;
  streak: number;
  result?: unknown;
};

const stepFromTool = (
  call: ToolCall,
  text: string,
  catalog: Catalog,
  priorResults: readonly unknown[],
  streak: number,
  tools: readonly ToolDefinition[],
): Step => {
  const outcome = executeCall(call, catalog, priorResults, tools);
  const payload = outcome.ok
    ? JSON.stringify(outcome.data)
    : `Error (${outcome.kind}): ${outcome.message}`;
  const capped = capResult(payload);
  const messages: Message[] = [
    { role: "assistant", content: text, tool_calls: [{ function: call }] },
    { role: "tool", content: capped.text, tool_name: call.name },
  ];
  const base: Step["base"] = {
    request: { kind: "tool", name: call.name, args: call.arguments },
    outcome,
    truncated: capped.truncated,
  };
  if (outcome.ok) {
    const stop: StopReason | undefined =
      call.name === FINAL_ANSWER
        ? { type: "success", ...FinalAnswerArgs.parse(outcome.data) }
        : undefined;
    return { base, messages, stop, streak: 0, result: outcome.data };
  }
  const nextStreak = outcome.kind === "invalid_args" ? streak + 1 : streak;
  const fatal = outcome.kind === "not_found" || nextStreak > MAX_ARG_RETRIES;
  const stop: StopReason | undefined = fatal
    ? {
        type: "tool_error",
        tool: call.name,
        args: call.arguments,
        message: outcome.message,
      }
    : undefined;
  return { base, messages, stop, streak: nextStreak };
};

export const runAgent = async (
  question: string,
  options: RunOptions,
  callModel: CallModel,
  catalog: Catalog,
): Promise<Run> => {
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  if (
    options.maxNudges !== undefined &&
    !(Number.isInteger(options.maxNudges) && options.maxNudges >= 1)
  )
    throw new RangeError(
      `maxNudges must be a positive integer, got ${options.maxNudges}`,
    );
  const toolset = options.tools ?? TOOLS;
  const tools = toOllamaTools(toolset);
  let messages: Message[] = [
    { role: "system", content: options.systemPrompt ?? SYSTEM_PROMPT },
    { role: "user", content: question },
  ];
  let turns: Turn[] = [];
  let results: unknown[] = [];
  let streak = 0;
  const finish = (stop: StopReason): Run => ({
    question,
    maxTurns,
    turns,
    stop,
    totals: sumTotals(turns),
  });

  for (let index = 1; index <= maxTurns; index++) {
    const reply = await callModel(messages, tools);
    if (!reply.ok)
      return finish({ type: "model_error", message: reply.message });
    const call = reply.toolCalls[0];
    const step: Step = call
      ? stepFromTool(call, reply.text, catalog, results, streak, toolset)
      : {
          base: {
            request: { kind: "text", content: reply.text },
            outcome: "nudged",
            truncated: false,
          },
          messages: [
            { role: "assistant", content: reply.text },
            { role: "user", content: NUDGE },
          ],
          streak,
        };
    turns = [...turns, { index, ...step.base, ...reply.usage }];
    messages = [...messages, ...step.messages];
    results = step.result === undefined ? results : [...results, step.result];
    streak = step.streak;
    if (step.stop) return finish(step.stop);
    const nudgeCapped =
      options.maxNudges !== undefined &&
      nudgeStreak(turns) >= options.maxNudges;
    if (isNoProgress(turns) || nudgeCapped)
      return finish({ type: "budget_exhausted", cause: "no_progress" });
    const cause = budgetCause(sumTotals(turns), options.budget ?? {});
    if (cause) return finish({ type: "budget_exhausted", cause });
  }
  return finish({ type: "budget_exhausted", cause: "turns" });
};
