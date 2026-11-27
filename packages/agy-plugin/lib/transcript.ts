// Antigravity's `transcript_full.jsonl` read as the bounded message list snapshot.ts expects.
//
// One JSON record per step: `USER_INPUT` (source `USER_EXPLICIT`, the person's words wrapped in
// `<USER_REQUEST>` plus harness metadata), `PLANNER_RESPONSE` (source `MODEL`: `content`,
// `tool_calls: [{name, args}]`, and per-call token counts), and `GENERIC` model steps that carry
// a tool's result as `content`. Tool results have no call id, so they pair with the calls of the
// preceding planner step in order. Every other step type (system messages, hook injections) is
// ignored, which is also what a schema change looks like: unreadable records are skipped, never
// guessed at.

import { readFileSync } from "node:fs";
import { MESSAGE_LIMIT, type MessageLike, type ToolUseLike } from "./snapshot.ts";
import { type ContextUsage, stepUsage, UNKNOWN_USAGE } from "./usage.ts";

export interface Transcript {
  messages: MessageLike[];
  /** A step carried a non-text part, which the snapshot cannot show Jev. */
  hasImages: boolean;
  /** A line in the file was not readable JSON; the snapshot says its coverage is partial. */
  unreadableLines: number;
  /** Number of records read: a fingerprint of how far the conversation has gone. */
  steps: number;
  usage: ContextUsage;
}

const EMPTY: Transcript = {
  messages: [],
  hasImages: false,
  unreadableLines: 0,
  steps: 0,
  usage: UNKNOWN_USAGE,
};

const REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/g;
const ENVELOPES = [
  /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g,
  /<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g,
];

/** The person's own words: the `<USER_REQUEST>` payload, else the message minus the envelopes. */
export function userText(raw: string): string {
  const requests: string[] = [];
  for (const match of raw.matchAll(REQUEST)) {
    const inner = match[1]?.trim();
    if (inner) requests.push(inner);
  }
  if (requests.length) return requests.join("\n\n");
  let rest = raw;
  for (const envelope of ENVELOPES) rest = rest.replace(envelope, "");
  return rest.trim();
}

function input(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseTranscript(text: string): Transcript {
  const messages: MessageLike[] = [];
  let unreadableLines = 0;
  let steps = 0;
  let tokens: number | undefined;
  let pending: ToolUseLike[] = [];
  let answered = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines++;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      unreadableLines++;
      continue;
    }
    steps++;
    const record = parsed as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (record.type === "USER_INPUT" && record.source === "USER_EXPLICIT") {
      pending = [];
      answered = 0;
      const own = userText(content);
      if (own) messages.push({ role: "user", text: own, toolUses: [] });
    } else if (record.type === "PLANNER_RESPONSE" && record.source === "MODEL") {
      const used = stepUsage(record);
      if (used !== undefined) tokens = used;
      const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      const toolUses: ToolUseLike[] = [];
      for (const call of calls) {
        const c = call as { name?: unknown; args?: unknown } | null;
        if (!c || typeof c.name !== "string") continue;
        toolUses.push({ tool: c.name, input: input(c.args), text: "" });
      }
      pending = toolUses;
      answered = 0;
      if (!content && !toolUses.length) continue;
      messages.push({ role: "assistant", text: content, toolUses });
    } else if (record.type === "GENERIC" && record.source === "MODEL") {
      const use = pending[answered++];
      if (use) {
        use.text = content;
        if (record.status !== "DONE") use.isError = true;
      }
    }
  }
  return {
    messages: messages.slice(-MESSAGE_LIMIT),
    hasImages: false,
    unreadableLines,
    steps,
    usage: tokens === undefined ? UNKNOWN_USAGE : { tokens, source: "transcript" },
  };
}

/** Reads the `transcriptPath` a hook payload names; a missing file is an empty transcript. */
export function readTranscript(path: string | undefined): Transcript {
  if (!path) return EMPTY;
  try {
    return parseTranscript(readFileSync(path, "utf8"));
  } catch {
    return EMPTY;
  }
}
