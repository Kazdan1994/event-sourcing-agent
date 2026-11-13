import { z } from "zod";
import {
  EXTRACT_MODEL,
  NUM_CTX,
  OLLAMA_URL,
  REQUEST_TIMEOUT_MS,
} from "./config.ts";

export type ToolCall = { name: string; arguments: Record<string, unknown> };

export type Message =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: { function: ToolCall }[];
    }
  | { role: "tool"; content: string; tool_name: string };

export type Usage = {
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
};

export type ModelReply =
  | { ok: true; text: string; toolCalls: ToolCall[]; usage: Usage }
  | { ok: false; message: string };

export type CallModel = (
  messages: readonly Message[],
  tools: readonly unknown[],
) => Promise<ModelReply>;

const OllamaReply = z.object({
  done: z.literal(true),
  message: z.object({
    content: z.string().default(""),
    tool_calls: z
      .array(
        z.object({
          function: z.object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()).default({}),
          }),
        }),
      )
      .default([]),
  }),
  prompt_eval_count: z.number().default(0),
  eval_count: z.number().default(0),
});

export const callOllama: CallModel = async (messages, tools) => {
  const started = performance.now();
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages,
        tools,
        stream: false,
        think: false,
        options: { temperature: 0, num_ctx: NUM_CTX },
      }),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `Ollama chat failed (${response.status}): ${await response.text()}`,
      };
    }
    const parsed = OllamaReply.safeParse(await response.json());
    if (!parsed.success)
      return {
        ok: false,
        message: `Unexpected Ollama reply: ${parsed.error.message}`,
      };
    const { message, prompt_eval_count, eval_count } = parsed.data;
    return {
      ok: true,
      text: message.content,
      toolCalls: message.tool_calls.map((call) => call.function),
      usage: {
        promptTokens: prompt_eval_count,
        outputTokens: eval_count,
        durationMs: Math.round(performance.now() - started),
      },
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    return { ok: false, message: reason };
  }
};
