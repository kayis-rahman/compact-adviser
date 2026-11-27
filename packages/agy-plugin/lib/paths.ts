import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/** Settings, per-session cooldowns, verdicts, and request logs. `COMPACT_ADVISER_AGY_HOME` moves it. */
export function dataDir(env: Env = process.env): string {
  const override = env.COMPACT_ADVISER_AGY_HOME?.trim();
  return override
    ? override.replace(/[\\/]+$/, "")
    : join(homedir(), ".gemini", "antigravity-cli", "compact-adviser");
}

export function settingsPath(env: Env = process.env): string {
  return join(dataDir(env), "settings.json");
}

export function sessionStatePath(sessionId: string, env: Env = process.env): string {
  return join(dataDir(env), "sessions", `${safeId(sessionId)}.json`);
}

export function verdictPath(sessionId: string, env: Env = process.env): string {
  return join(dataDir(env), "verdicts", `${safeId(sessionId)}.json`);
}

/** A conversation id is a UUID in practice, but it reaches us from a payload, so never trust it. */
export function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "session";
}
