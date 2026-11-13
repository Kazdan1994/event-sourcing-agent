import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CallModel,
  ModelReply,
} from "./agent-loop/model.ts";

export const usage = { promptTokens: 10, outputTokens: 2, durationMs: 5 };

export const toolReply = (
  name: string,
  args: Record<string, unknown> = {},
): ModelReply => ({
  ok: true,
  text: "",
  toolCalls: [{ name, arguments: args }],
  usage,
});

export const textReply = (text: string): ModelReply => ({
  ok: true,
  text,
  toolCalls: [],
  usage,
});

export const PRICE_ARGS = {
  product: "notion",
  plan: "Plus",
  seats: 5,
  billing: "monthly",
};

export const HAPPY: readonly ModelReply[] = [
  toolReply("get_plans", { product: "notion" }),
  toolReply("price_for_seats", PRICE_ARGS),
  toolReply("final_answer", { answer: "570 EUR per year", amounts: [570] }),
];

export const scripted = (replies: readonly ModelReply[]) => {
  let calls = 0;
  const callModel: CallModel = async () =>
    replies[Math.min(calls++, replies.length - 1)]!;
  return { callModel, calls: () => calls };
};

export const useTempRunsDir = () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s15-"));
    process.env.S15_RUNS_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.S15_RUNS_DIR;
  });
  return () => dir;
};
