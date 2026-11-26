#!/usr/bin/env node
// compact-adviser for Antigravity CLI (`agy`): the one process behind every hook and command.
//
// Antigravity runs `<workspace>/.agents/hooks.json` handlers as short-lived processes with a
// JSON payload on stdin. `hook stop` judges a completed turn and records a verdict;
// `hook pre-invocation` shows that verdict as a hint, once, before the model's next call.
// The judgment, the scoring and the usage-dependent floor are the shared product
// (../lib/judge.ts); everything in this file is Antigravity's own glue.
//
// Three host facts shape it (measured on agy 1.5.15, recorded in docs/product-contract.md):
//   - The Stop payload carries `transcriptPath` (a jsonl of every step, with per-step token
//     counts) but no usage and no conversation text, so the transcript is the input.
//   - Stop's own output can only keep the agent going (`decision: "continue"`, whose `reason`
//     becomes a model-visible system message) - it has no user-only channel. The user-only
//     channel is a hook's `injectSteps` system message with `metadata.user_markdown` and an
//     empty `systemMessage`, honoured on `PreInvocation`.
//   - Nothing outside a session can trigger `/compact`, so this host is hint-only.
//
// Two rules shape it:
//   - Nothing here ever writes to the model's context: `hook stop` always prints `{}`, and the
//     hint is an empty `systemMessage` carrying only `user_markdown`.
//   - Every path fails open. A hook is on the turn's critical path, so an unreadable transcript,
//     an absent key, or a refused judgment leaves the turn alone.
//
// This file runs through Node's own type stripping, so it and ../lib carry no build step and
// no dependencies.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_MINIMUM,
  formatTokens,
  parseBudget,
  parseMinimum,
  parseMode,
  parseSavedApiKey,
  readSettings,
  type Settings,
  SettingsError,
  writeSettings,
} from "../lib/config.ts";
import { DISABLE_ENV, disabledByEnv } from "../lib/disable.ts";
import { formatKeyStatus, parseDotenvKey, resolveTypesafeApiKey } from "../lib/env.ts";
import { HOOK_NAME, hintResult } from "../lib/hint.ts";
import {
  effectiveBudget,
  floorFor,
  JudgeError,
  judge,
  MAX_RESPONSE_BYTES,
  qualifies,
  requestBody,
  score,
  typesafeEndpoint,
} from "../lib/judge.ts";
import {
  errorLogLine,
  loggedJudgeErrorKind,
  requestLogLine,
  requestLogPath,
  responseLogLine,
} from "../lib/log.ts";
import { dataDir, type Env, sessionStatePath, settingsPath, verdictPath } from "../lib/paths.ts";
import { parseProfile } from "../lib/profile.ts";
import { snapshot } from "../lib/snapshot.ts";
import { backoff, completeExchange, cooldownReason, SESSION_RETENTION_MS } from "../lib/state.ts";
import {
  clearDiagnostic,
  clearVerdict,
  diagnosticPath,
  loadDiagnostic,
  loadSessionState,
  loadVerdict,
  saveDiagnostic,
  saveSessionState,
  saveVerdict,
  verdictApplies,
} from "../lib/store.ts";
import { readTranscript } from "../lib/transcript.ts";
import { usageFraction } from "../lib/usage.ts";

const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\x21-\x7e]*$/;
/** The conversation's own tokens, below which there is nothing worth judging yet. */
const MINIMUM_CONVERSATION_TOKENS = 20000;
const USAGE = `compact-adviser (Antigravity)

  status                     what the adviser would do right now
  mode hint|off              hint shows advice; off disables it (agy has no way to auto-compact)
  threshold <tokens|default> minimum context tokens before a checkpoint is judged
  budget <tokens|off>        relax the hint floor toward this context size (agy exposes no window)
  key <value>|key clear      save or clear the TypeSafe API key from a shell (TYPESAFE_API_KEY still wins)
  log on|off                 TypeSafe request logging, off by default
  snooze <conversationId>    no advice for three more completed exchanges in that conversation
  dismiss <conversationId>   drop the pending hint of that conversation
  install [workspace]        merge the "${HOOK_NAME}" hooks into <workspace>/.agents/hooks.json
  uninstall [workspace]      remove only the "${HOOK_NAME}" spec from it`;

// --- small helpers ------------------------------------------------------------------

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function env(): Env {
  return process.env;
}

function settingsOrThrow(): Settings {
  return readSettings(settingsPath(env()));
}

function updateSettings(patch: Partial<Settings>): Settings {
  const current = settingsOrThrow();
  const next: Settings = { ...current, ...patch, version: 1 };
  writeSettings(settingsPath(env()), next);
  return next;
}

function dotenvKey(cwd: string): string | undefined {
  try {
    return parseDotenvKey(readFileSync(join(cwd, ".env"), "utf8"), "TYPESAFE_API_KEY");
  } catch {
    return undefined;
  }
}

function resolveKey(settings: Settings, cwd: string) {
  return resolveTypesafeApiKey(
    process.env.TYPESAFE_API_KEY,
    settings.typesafeApiKey,
    dotenvKey(cwd),
  );
}

function testEndpoint(): string | undefined {
  const value = process.env.COMPACT_ADVISER_TEST_ENDPOINT;
  return value !== undefined && LOOPBACK_ENDPOINT.test(value) ? value : undefined;
}

/** The live regression's fixture, else TypeSafe under `TYPESAFE_BASE` and `TYPESAFE_PATH`. */
function resolveEndpoint(): string | undefined {
  return testEndpoint() ?? typesafeEndpoint(process.env.TYPESAFE_BASE, process.env.TYPESAFE_PATH);
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return "x".repeat(MAX_RESPONSE_BYTES + 1);
      chunks.push(next.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function cancellableJudgeTransport(): {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number; ok: boolean; text: string }>;
  sleep: (ms: number) => Promise<void>;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    fetch: async (url, init) => {
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await readBoundedText(response);
        stopTimer();
        return { status: response.status, ok: response.ok, text };
      } catch (error) {
        stopTimer();
        if (controller.signal.aborted) {
          return await new Promise<{ status: number; ok: boolean; text: string }>(() => undefined);
        }
        throw error;
      }
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          resolve();
          controller.abort();
        }, ms);
      }),
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendLog(sessionId: string, line: string): void {
  try {
    const path = requestLogPath(dataDir(env()), sessionId);
    mkdirSync(dataDir(env()), { recursive: true });
    // O_APPEND: each hook run is its own process, so a whole-file rewrite would lose lines.
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Logging must never replace or delay a judgment.
  }
}

function checkpointKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
// --- hook payloads ------------------------------------------------------------------

interface HookPayload {
  hookEventName?: string;
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  cwd?: string;
  terminationReason?: string;
  continuationActive?: boolean;
}

function hookPayload(): HookPayload {
  try {
    const value = JSON.parse(readStdin()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as HookPayload)
      : {};
  } catch {
    return {};
  }
}

function sessionIdOf(payload: HookPayload): string | undefined {
  const id = payload.conversationId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function cwdOf(payload: HookPayload): string {
  return payload.cwd ?? payload.workspacePaths?.[0] ?? process.cwd();
}

/** What every hook prints unless it has a hint: an empty, valid hook result that changes nothing. */
const NOTHING = "{}";

// --- the judgment -------------------------------------------------------------------

/**
 * A completed checkpoint. Every outcome is a file write: this hook's stdout can only keep the
 * agent going, which would put the advice in the model's context, so it always prints `{}`.
 */
async function runStop(payload: HookPayload): Promise<void> {
  // Only a model that finished without calling a tool is a checkpoint; errors, cancellations
  // and budget stops are not.
  if (payload.terminationReason !== "NO_TOOL_CALL") return;
  // Another Stop hook kept the agent working this turn, so the turn is not over.
  if (payload.continuationActive === true) return;
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  const cwd = cwdOf(payload);
  const now = Date.now();

  let settings: Settings;
  try {
    settings = settingsOrThrow();
  } catch {
    return;
  }
  const statePath = sessionStatePath(sessionId, env());
  const verdict = verdictPath(sessionId, env());

  const transcript = readTranscript(payload.transcriptPath);
  if (transcript.unreadableLines !== 0 || !transcript.messages.length) {
    if (settings.mode === "off") clearVerdict(verdict);
    return;
  }
  const promptId = String(transcript.steps);
  const stored = loadSessionState(statePath, now);
  // This checkpoint has already been through the gate: a re-fire must not count the exchange
  // twice or ask TypeSafe twice for it.
  if (transcript.steps > 0 && stored.lastPromptId === promptId) return;

  const usage = transcript.usage;
  const state = { ...completeExchange(stored, usage.tokens, now), lastPromptId: promptId };
  saveSessionState(statePath, state);

  if (settings.mode === "off") {
    clearVerdict(verdict);
    return;
  }
  const key = resolveKey(settings, cwd);
  const activeKey = key.value?.trim() ?? "";
  if (!activeKey) return;

  const view = snapshot(transcript.messages, [activeKey], transcript.hasImages);
  if (view.conversationTokens <= MINIMUM_CONVERSATION_TOKENS) return;

  // The transcript's own token counts are the honest number; the local estimate stands in
  // when they are missing, so a schema change weakens the gate, not the product.
  const tokens = usage.tokens ?? view.conversationTokens;
  if (tokens < settings.minContextTokens) return;
  if (cooldownReason(state, tokens, now) !== undefined) return;

  const profile = parseProfile(settings.profile);
  const fingerprint = checkpointKey(view.checkpointText);
  if (state.lastHintKey === fingerprint) return;

  const endpoint = resolveEndpoint();
  let loggedBody: string | undefined;
  if (settings.logRequests) {
    try {
      loggedBody = requestBody(view.state, profile, endpoint);
      appendLog(sessionId, requestLogLine(loggedBody));
    } catch {
      // A body too large to send is reported by `judge` below; logging does not decide.
    }
  }
  let judgment: Awaited<ReturnType<typeof judge>>;
  try {
    if (endpoint === undefined) throw new JudgeError("configuration");
    judgment = await judge(
      view.state,
      activeKey,
      {
        ...cancellableJudgeTransport(),
        endpoint,
      },
      profile,
    );
  } catch (error) {
    const nowAfter = Date.now();
    if (settings.logRequests) {
      appendLog(sessionId, errorLogLine(loggedJudgeErrorKind(error), loggedBody));
    }
    const current = loadSessionState(statePath, nowAfter);
    saveSessionState(statePath, backoff(current, nowAfter));
    saveDiagnostic(diagnosticPath(dataDir(env()), sessionId), loggedJudgeErrorKind(error));
    clearVerdict(verdict);
    return;
  }

  const nowAfter = Date.now();
  const fraction = usageFraction(usage, settings.contextBudgetTokens);
  if (settings.logRequests) {
    appendLog(
      sessionId,
      responseLogLine(
        loggedBody ?? requestBody(view.state, profile, endpoint),
        judgment,
        fraction,
        undefined,
        profile,
        effectiveBudget(usage.window ?? Number.NaN, settings.contextBudgetTokens),
      ),
    );
  }
  clearDiagnostic(diagnosticPath(dataDir(env()), sessionId));
  let latest: Settings | undefined;
  try {
    latest = settingsOrThrow();
  } catch {
    latest = undefined;
  }
  const current = loadSessionState(statePath, nowAfter);
  const settled = { ...current, failures: 0, retryAfter: 0, updatedAt: nowAfter };
  if (
    latest === undefined ||
    latest.mode === "off" ||
    tokens < latest.minContextTokens ||
    cooldownReason(current, tokens, nowAfter) !== undefined ||
    latest.profile !== settings.profile ||
    latest.contextBudgetTokens !== settings.contextBudgetTokens ||
    !qualifies(judgment, fraction, profile)
  ) {
    saveSessionState(statePath, settled);
    clearVerdict(verdict);
    return;
  }
  saveSessionState(statePath, {
    ...settled,
    lastHintAt: settled.completed,
    lastHintKey: fingerprint,
  });
  saveVerdict(verdict, {
    version: 1,
    sessionId,
    promptId,
    at: nowAfter,
    tokens: usage.tokens ?? null,
    score: score(judgment, profile),
    floor: floorFor(fraction, profile),
  });
}

// --- the other hooks ----------------------------------------------------------------

/**
 * Shows a pending hint, once. PreInvocation fires before every model call, so the verdict is
 * consumed the moment it is shown: the next call of the same turn finds nothing.
 */
function runPreInvocation(payload: HookPayload): string {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return NOTHING;
  const path = verdictPath(sessionId, env());
  const verdict = loadVerdict(path);
  if (verdict === undefined) return NOTHING;
  clearVerdict(path);
  let enabled = false;
  try {
    enabled = settingsOrThrow().mode !== "off";
  } catch {}
  if (!enabled) return NOTHING;
  // A compaction since the hint was earned (context dropped) makes it untrue.
  const usage = readTranscript(payload.transcriptPath).usage;
  return verdictApplies(verdict, Date.now(), undefined, usage.tokens) ? hintResult() : NOTHING;
}

function pruneStale(): void {
  const now = Date.now();
  for (const kind of ["sessions", "verdicts", "diagnostics"]) {
    const dir = join(dataDir(env()), kind);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > SESSION_RETENTION_MS) rmSync(path, { force: true });
      } catch {
        // A file that cannot be read is a file that cannot be pruned; leave it.
      }
    }
  }
}

// --- install ------------------------------------------------------------------------

export function hooksFilePath(workspace: string): string {
  return join(resolve(workspace), ".agents", "hooks.json");
}

/** The named spec: flat handler lists, absolute entry path (hooks run in the hooks.json directory). */
export function hookSpec(entry: string): Record<string, unknown> {
  const command = (event: string) => `node ${shellQuote(entry)} hook ${event}`;
  return {
    SessionStart: [{ type: "command", command: command("session-start"), timeout: 5 }],
    PreInvocation: [{ type: "command", command: command("pre-invocation"), timeout: 5 }],
    Stop: [{ type: "command", command: command("stop"), timeout: 30 }],
  };
}

function readHooksFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw new SettingsError(`Cannot read ${path}; nothing was changed.`);
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON; nothing was changed.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError(`${path} is not a JSON object; nothing was changed.`);
  }
  return parsed as Record<string, unknown>;
}

function writeHooksFile(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Adds or replaces the `compact-adviser` spec; every other named spec is kept as it was. */
function install(workspace: string): string {
  const path = hooksFilePath(workspace);
  const existing = readHooksFile(path);
  const entry = join(import.meta.dirname, "adviser.ts");
  writeHooksFile(path, { ...existing, [HOOK_NAME]: hookSpec(entry) });
  const others = Object.keys(existing).filter((name) => name !== HOOK_NAME);
  return [
    `Registered the "${HOOK_NAME}" hooks in ${path}.`,
    others.length ? `Left alone: ${others.join(", ")}.` : "No other hook specs there.",
    "Restart agy in that workspace to load them. hooks.json is per workspace: run this once in",
    "each workspace you want the adviser in.",
  ].join("\n");
}

function uninstall(workspace: string): string {
  const path = hooksFilePath(workspace);
  const existing = readHooksFile(path);
  if (!(HOOK_NAME in existing)) return `No "${HOOK_NAME}" spec in ${path}.`;
  const { [HOOK_NAME]: _removed, ...rest } = existing;
  writeHooksFile(path, rest);
  return `Removed the "${HOOK_NAME}" spec from ${path}; other specs were kept.`;
}

// --- the person-facing commands -----------------------------------------------------

function statusText(sessionId: string | undefined): string {
  const settings = settingsOrThrow();
  const key = resolveKey(settings, process.cwd());
  const lines = [
    `Mode: ${settings.mode} (Antigravity is hint-only; nothing outside a session can run /compact).`,
    `Minimum context: ${formatTokens(settings.minContextTokens)} tokens.`,
    `Budget: ${settings.contextBudgetTokens > 0 ? `${formatTokens(settings.contextBudgetTokens)} tokens` : "off"}.`,
    `${formatKeyStatus(key.source)}.`,
    `Request log: ${settings.logRequests ? requestLogPath(dataDir(env()), "<conversation-id>") : "off"}.`,
    `Settings file: ${settingsPath(env())}.`,
  ];
  if (sessionId) {
    const state = loadSessionState(sessionStatePath(sessionId, env()), Date.now());
    const verdict = loadVerdict(verdictPath(sessionId, env()));
    lines.push(
      `Conversation ${sessionId}: ${state.completed} completed exchange(s).`,
      `Pending hint: ${verdict ? "yes, shown before the next model call" : "none"}.`,
    );
    const diagnostic = loadDiagnostic(diagnosticPath(dataDir(env()), sessionId));
    if (diagnostic) lines.push(`Last TypeSafe outcome: ${diagnostic}.`);
  }
  return lines.join("\n");
}

function needConversation(value: string): string {
  if (!value)
    throw new SettingsError("Pass the conversation id (agy prints it, and hooks log it).");
  return value;
}

function snooze(sessionId: string): string {
  const path = sessionStatePath(sessionId, env());
  const state = loadSessionState(path, Date.now());
  saveSessionState(path, { ...state, snoozeUntil: state.completed + 4, updatedAt: Date.now() });
  clearVerdict(verdictPath(sessionId, env()));
  return "Advice snoozed for three completed exchanges.";
}

function runCommand(argv: readonly string[]): string {
  const [command = "", ...rest] = argv;
  const value = rest.join(" ").trim();
  switch (command) {
    case "status":
      return statusText(value || undefined);
    case "mode":
      return `Mode saved: ${updateSettings({ mode: parseMode(value) }).mode}.`;
    case "threshold": {
      const count = value === "default" ? DEFAULT_MINIMUM : parseMinimum(value);
      return `Minimum context saved: ${formatTokens(updateSettings({ minContextTokens: count }).minContextTokens)} tokens.`;
    }
    case "budget": {
      const count = updateSettings({ contextBudgetTokens: parseBudget(value) }).contextBudgetTokens;
      return count > 0
        ? `Context budget saved: ${formatTokens(count)} tokens.`
        : "Context budget off: agy exposes no window, so the strictest hint floor applies.";
    }
    case "key":
      if (value === "clear") {
        updateSettings({ typesafeApiKey: "" });
        return "Saved TypeSafe API key cleared. TYPESAFE_API_KEY and a cwd .env still apply.";
      }
      updateSettings({ typesafeApiKey: parseSavedApiKey(value) });
      return "TypeSafe API key saved. Status shows the source, never the value.";
    case "log": {
      if (value !== "on" && value !== "off") throw new SettingsError("Choose on or off.");
      updateSettings({ logRequests: value === "on" });
      return `TypeSafe request logging ${value}.`;
    }
    case "snooze":
      return snooze(needConversation(value));
    case "dismiss":
      clearVerdict(verdictPath(needConversation(value), env()));
      return "Hint dismissed.";
    case "install":
      return install(value || process.cwd());
    case "uninstall":
      return uninstall(value || process.cwd());
    case "":
    case "help":
    case "--help":
    case "-h":
      return USAGE;
    default:
      throw new SettingsError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

// --- entry point --------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<void> {
  const [command = "", ...rest] = argv;
  if (disabledByEnv(process.env[DISABLE_ENV])) {
    if (command === "hook") {
      out(NOTHING);
      process.exit(0);
    }
    fail("COMPACT_ADVISER_DISABLE is set; compact-adviser is taking no action.");
  }
  if (command === "hook") {
    // Every hook path is fail-open: the turn must not notice this process at all.
    let result = NOTHING;
    try {
      const payload = hookPayload();
      const event = rest[0] ?? "";
      if (event === "stop") await runStop(payload);
      else if (event === "pre-invocation") result = runPreInvocation(payload);
      else if (event === "session-start") pruneStale();
    } catch {
      // Recorded nowhere on purpose: a hook failure is scrollback noise, not advice.
    }
    out(result);
    process.exit(0);
  }
  try {
    out(runCommand([command, ...rest]));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not run that command.");
  }
}

await main(process.argv.slice(2));
