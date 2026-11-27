// A lab for driving the real adviser entry point: a temporary data directory, a transcript
// shaped the way Antigravity writes `transcript_full.jsonl`, and a loopback TypeSafe fixture.
// Nothing here stubs the package's own code.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const ENTRY = join(import.meta.dirname, "..", "bin", "adviser.ts");
export const PACKAGE_ROOT = join(import.meta.dirname, "..");

export interface Lab {
  home: string;
  cwd: string;
  conversationId: string;
  transcriptPath: string;
  dataDir: string;
}

export function lab(t: TestContext, conversationId = "ae68ae95-7c7a-4f38-8623-c690f1d35160"): Lab {
  const home = mkdtempSync(join(tmpdir(), "compact-adviser-agy-"));
  const cwd = join(home, "project");
  const logs = join(home, "brain", conversationId, ".system_generated", "logs");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(logs, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    cwd,
    conversationId,
    transcriptPath: join(logs, "transcript_full.jsonl"),
    dataDir: join(home, "compact-adviser"),
  };
}

/** One `transcript_full.jsonl` record, in the shapes agy 1.5.15 actually writes. */
export type Step = Record<string, unknown>;

export function writeTranscript(lab: Lab, steps: readonly Step[]): void {
  writeFileSync(lab.transcriptPath, `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`);
}

function user(i: number, text: string): Step {
  return {
    step_index: i,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-26T20:09:29Z.\n</ADDITIONAL_METADATA>`,
  };
}

/** A transcript large enough to clear the conversation-token floor, ending on a finished unit. */
export function workedTranscript(marker = "one", tokens = { input: 21226, cache: 25923 }): Step[] {
  const bulk = `Traced the parser through its callers and wrote the fix. ${marker} `.repeat(2200);
  return [
    user(0, `Fix the parser bug ${marker}, run the tests, and commit.`),
    {
      step_index: 1,
      source: "SYSTEM_SDK",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      content: "Injected by a SessionStart hook: not the person's words.",
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      model: "claude-sonnet-5-5-medium",
      input_tokens: 39255,
      cache_read_tokens: 7695,
      output_tokens: 116,
      content: `Working on it. ${bulk}`,
      tool_calls: [
        { name: "write_to_file", args: { TargetFile: `/repo/src/parser-${marker}.ts` } },
        { name: "run_command", args: { CommandLine: `echo done > notes-${marker}.txt` } },
      ],
    },
    { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", content: "created file" },
    { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", content: "exit 0" },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      input_tokens: tokens.input,
      cache_read_tokens: tokens.cache,
      output_tokens: 90,
      content: `Done: the parser bug ${marker} is fixed, 12 of 12 tests pass, and it is committed. Nothing is pending.`,
    },
  ];
}

export interface Fixture {
  url: string;
  bodies: string[];
  paths: string[];
  close: () => void;
  /** Probabilities the next judgment answers with. */
  verdict: { finished: number; handsOn: number };
  /** When set, every request answers with this status instead of a judgment. */
  status?: number;
  /** When true, the body is larger than MAX_RESPONSE_BYTES. */
  oversize: boolean;
  /** When true, the request is accepted and never answered. */
  hang: boolean;
  /** Runs after a request body arrives and before it is answered. */
  onRequest?: () => void | Promise<void>;
}

export function typesafeFixture(t: TestContext): Promise<Fixture> {
  const bodies: string[] = [];
  const paths: string[] = [];
  const state: Fixture = {
    url: "",
    bodies,
    paths,
    close: () => undefined,
    verdict: { finished: 0.97, handsOn: 0.96 },
    oversize: false,
    hang: false,
  };
  const choice = (name: string, p: number, others: [string, string]) => ({
    type: "choice",
    choice: name,
    confidence: p,
    probabilities: { [name]: p, [others[0]]: (1 - p) / 2, [others[1]]: (1 - p) / 2 },
  });
  const decideChoice = (
    name: string,
    questionName: string,
    p: number,
    others: [string, string],
  ) => ({
    type: "choice",
    name: questionName,
    choice: name,
    confidence: p,
    probabilities: [
      { value: name, probability: p },
      { value: others[0], probability: (1 - p) / 2 },
      { value: others[1], probability: (1 - p) / 2 },
    ],
  });
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      void (async () => {
        bodies.push(body);
        paths.push(request.url ?? "");
        await state.onRequest?.();
        if (state.hang) return;
        if (state.status !== undefined) {
          response.writeHead(state.status, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (state.oversize) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("x".repeat(32768 + 1));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        if ((request.url ?? "") !== "/v1/systemone") {
          response.end(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: [
                decideChoice("finished", "done", state.verdict.finished, [
                  "not_finished",
                  "unclear",
                ]),
                decideChoice("hands_on", "shape", state.verdict.handsOn, [
                  "coordinating",
                  "unclear",
                ]),
              ],
              usage: { input_tokens: 2500, output_tokens: 40 },
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              done: choice("finished", state.verdict.finished, ["not_finished", "unclear"]),
              shape: choice("hands_on", state.verdict.handsOn, ["coordinating", "unclear"]),
            },
            usage: { input_tokens: 2500, output_tokens: 40 },
          }),
        );
      })();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      state.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1/systemone`;
      state.close = () => server.close();
      t.after(() => server.close());
      resolve(state);
    });
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(
  args: readonly string[],
  options: { lab?: Lab; stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const { lab, stdin = "", env = {} } = options;
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: lab?.cwd ?? process.cwd(),
    env: {
      ...process.env,
      TYPESAFE_API_KEY: undefined,
      TYPESAFE_BASE: undefined,
      TYPESAFE_PATH: undefined,
      COMPACT_ADVISER_DISABLE: undefined,
      COMPACT_ADVISER_EVENT_FILE: undefined,
      ...(lab ? { COMPACT_ADVISER_AGY_HOME: lab.dataDir } : {}),
      NO_COLOR: "1",
      ...env,
    } as NodeJS.ProcessEnv,
  });
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs a hook `command` string the way agy does: `sh -c`, from the hooks.json directory. */
export function runShell(
  command: string,
  options: { cwd: string; stdin: string; env: Record<string, string | undefined> },
): Promise<RunResult> {
  const child = spawn("sh", ["-c", command], {
    cwd: options.cwd,
    env: {
      ...process.env,
      TYPESAFE_API_KEY: undefined,
      TYPESAFE_BASE: undefined,
      TYPESAFE_PATH: undefined,
      COMPACT_ADVISER_DISABLE: undefined,
      COMPACT_ADVISER_EVENT_FILE: undefined,
      NO_COLOR: "1",
      ...options.env,
    } as NodeJS.ProcessEnv,
  });
  child.stdin.end(options.stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The payload agy 1.5.15 sends a Stop hook, measured with a real run. */
export function stopPayload(lab: Lab, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    artifactDirectoryPath: join(lab.home, "brain", lab.conversationId),
    continuationActive: false,
    conversationId: lab.conversationId,
    cwd: lab.cwd,
    error: "",
    executionNum: 0,
    fullyIdle: true,
    hookEventName: "Stop",
    lastUserInput: "Fix the parser bug",
    modelName: "claude-sonnet-5-5-medium",
    terminationReason: "NO_TOOL_CALL",
    transcriptPath: lab.transcriptPath,
    workspacePaths: [lab.cwd],
    ...patch,
  });
}

export function preInvocationPayload(lab: Lab, patch: Record<string, unknown> = {}): string {
  return stopPayload(lab, {
    hookEventName: "PreInvocation",
    initialNumSteps: 6,
    invocationNum: 0,
    terminationReason: undefined,
    continuationActive: undefined,
    ...patch,
  });
}
