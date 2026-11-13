import { z } from "zod";

export const RunId = z.string().regex(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
export type RunId = z.infer<typeof RunId>;

const Args = z.record(z.string(), z.unknown());
const TurnNumber = z.number().int().min(1);

export const ToolCallSchema = z.object({ name: z.string(), arguments: Args });

export const UsageSchema = z.object({
  promptTokens: z.number(),
  outputTokens: z.number(),
  durationMs: z.number(),
});

export const Stop = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    answer: z.string(),
    amounts: z.array(z.number()),
  }),
  z.object({
    type: z.literal("budget_exhausted"),
    cause: z.enum(["turns", "no_progress"]),
  }),
  z.object({
    type: z.literal("tool_error"),
    tool: z.string(),
    args: Args,
    message: z.string(),
  }),
]);
export type Stop = z.infer<typeof Stop>;

export const EventBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run_started"),
    question: z.string(),
    maxTurns: TurnNumber,
    model: z.string(),
  }),
  z.object({ kind: z.literal("turn_started"), turn: TurnNumber }),
  z.object({
    kind: z.literal("model_decision"),
    turn: TurnNumber,
    text: z.string(),
    toolCall: ToolCallSchema.optional(),
    usage: UsageSchema,
  }),
  z.object({
    kind: z.literal("model_failed"),
    turn: TurnNumber,
    message: z.string(),
  }),
  z.object({
    kind: z.literal("tool_called"),
    turn: TurnNumber,
    name: z.string(),
    arguments: Args,
  }),
  z.object({
    kind: z.literal("tool_result"),
    turn: TurnNumber,
    name: z.string(),
    data: z.unknown(),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("tool_error"),
    turn: TurnNumber,
    name: z.string(),
    errorKind: z.enum(["invalid_args", "not_found"]),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("run_resumed"),
    fromSeq: z.number().int().min(0),
    pid: z.number().int(),
    staleLockPid: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("run_ended"), stop: Stop }),
]);
export type EventBody = z.infer<typeof EventBody>;

const Meta = z.object({
  runId: RunId,
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
});

export const Event = z.intersection(Meta, EventBody);
export type Event = z.infer<typeof Event>;

const pad = (value: number) => String(value).padStart(2, "0");

export const newRunId = (now = new Date()): RunId => {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = crypto.getRandomValues(new Uint8Array(2));
  const hex = [...suffix].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${date}-${time}-${hex.join("")}`;
};
