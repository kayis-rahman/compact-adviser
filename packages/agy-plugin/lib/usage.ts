// Context usage, read from the transcript. Antigravity's hook payloads carry no usage, but
// every model step in `transcript_full.jsonl` records `input_tokens` (uncached input) and
// `cache_read_tokens`; their sum on the newest model step is what the conversation occupied
// on that call. The model's window is not exposed anywhere a hook can read, so it is
// reported as unknown: the hint floor then follows the context budget when one is saved and
// otherwise takes the contract's strictest floor rather than a guess.

import { contextPressure } from "./judge.ts";

export interface ContextUsage {
  /** Tokens the conversation occupies right now, or undefined when nothing could read it. */
  tokens?: number;
  /** The model's context window; Antigravity does not expose it, so always undefined. */
  window?: number;
  source: "transcript" | "unknown";
}

export const UNKNOWN_USAGE: ContextUsage = { source: "unknown" };

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Context tokens over the budget; NaN when unknown (strictest floor). */
export function usageFraction(usage: ContextUsage, budget: number): number {
  if (usage.tokens === undefined) return Number.NaN;
  return contextPressure(usage.tokens, usage.window ?? Number.NaN, budget);
}

/** From one model step record: uncached plus cached input tokens, or undefined. */
export function stepUsage(record: Record<string, unknown>): number | undefined {
  const input = count(record.input_tokens);
  if (input === undefined) return undefined;
  return input + (count(record.cache_read_tokens) ?? 0);
}
