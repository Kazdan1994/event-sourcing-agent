export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "qwen3:8b";

// Fixed window so overflow is a controlled variable (same value as S6)
export const NUM_CTX = 12_288;
export const OUTPUT_TOKEN_BUDGET = 2_048;
// Rough estimate for mixed English/Markdown text
export const CHARS_PER_TOKEN = 3.5;
export const MAX_RETRIES = 2;
export const REQUEST_TIMEOUT_MS = 180_000;

const DEFAULT_ATTEMPT_TIMEOUT_MS = 50_000;

const positiveMs = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds, got "${raw}"`);
  }
  return value;
};

export const ATTEMPT_TIMEOUT_MS = positiveMs(
  "EXTRACT_ATTEMPT_TIMEOUT_MS",
  process.env.EXTRACT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
);
export const FALLBACK_MODEL = process.env.EXTRACT_FALLBACK_MODEL || "qwen3:4b";

export const RAG_TOP_K = 6;
export const RAG_QUERY = "plans, prices, billing period, limits";
export const CHUNK_MAX_CHARS = 1500;
export const CHUNK_OVERLAP_CHARS = 200;

