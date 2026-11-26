// The product, driven through the real CLI the agy hooks run.
//
// Every case starts from an Antigravity-shaped transcript and a loopback TypeSafe fixture and
// asserts what the hooks print: the hint on PreInvocation, and nothing the model could read.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HINT, HOOK_NAME } from "../lib/hint.ts";
import {
  lab,
  preInvocationPayload,
  runCli,
  runShell,
  stopPayload,
  typesafeFixture,
  workedTranscript,
  writeTranscript,
} from "./support.ts";

function keyed(fixture: { url: string }) {
  return { COMPACT_ADVISER_TEST_ENDPOINT: fixture.url, TYPESAFE_API_KEY: "tsk-test-key" };
}

async function judgeTurn(t: Parameters<typeof lab>[0], marker = "one") {
  const l = lab(t);
  const fixture = await typesafeFixture(t);
  writeTranscript(l, workedTranscript(marker));
  return { l, fixture };
}

function userMarkdown(stdout: string): string | undefined {
  const result = JSON.parse(stdout) as {
    injectSteps?: {
      systemMessage: { systemMessage: string; metadata: { user_markdown: string } };
    }[];
  };
  const step = result.injectSteps?.[0];
  if (step) assert.equal(step.systemMessage.systemMessage, "", "the model must be sent nothing");
  return step?.systemMessage.metadata.user_markdown;
}

test("a qualifying checkpoint shows the hint once, to the person only, and Stop stays silent", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: keyed(fixture),
  });
  assert.equal(stop.code, 0);
  // Stop's only non-empty answer keeps the agent working and puts a reason in the model's
  // context, so it must say nothing.
  assert.equal(stop.stdout.trim(), "{}");
  assert.equal(fixture.bodies.length, 1);

  const shown = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(userMarkdown(shown.stdout), HINT);
  const again = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(again.stdout.trim(), "{}");
});

test("the judge sees the person's words and the files agy wrote, not agy's envelopes", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const body = JSON.parse(fixture.bodies[0] ?? "{}") as {
    state: { userConstraints: { text: string }[]; savedArtifacts: string[] };
  };
  assert.deepEqual(
    body.state.userConstraints.map((entry) => entry.text),
    ["Fix the parser bug one, run the tests, and commit."],
  );
  assert.deepEqual(body.state.savedArtifacts, ["/repo/src/parser-one.ts", "notes-one.txt"]);
});

test("a judgment below the floor leaves no hint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.verdict = { finished: 0.2, handsOn: 0.2 };
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const shown = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(shown.stdout.trim(), "{}");
});

test("only a settled model answer is a checkpoint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  for (const patch of [
    { terminationReason: "USER_CANCELED" },
    { terminationReason: "ERROR" },
    { terminationReason: "MAX_INVOCATIONS" },
    { continuationActive: true },
  ]) {
    const stop = await runCli(["hook", "stop"], {
      lab: l,
      stdin: stopPayload(l, patch),
      env: keyed(fixture),
    });
    assert.equal(stop.stdout.trim(), "{}");
  }
  assert.equal(fixture.bodies.length, 0);
});

test("the same checkpoint is not judged twice", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  for (let i = 0; i < 2; i++) {
    await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  }
  assert.equal(fixture.bodies.length, 1);
});

test("below the minimum context nothing is judged, and the transcript's own token counts decide", async (t) => {
  const l = lab(t);
  const fixture = await typesafeFixture(t);
  writeTranscript(l, workedTranscript("one", { input: 1000, cache: 2000 }));
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 0);
});

test("no TypeSafe key means no request at all", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: { COMPACT_ADVISER_TEST_ENDPOINT: fixture.url },
  });
  assert.equal(stop.code, 0);
  assert.equal(fixture.bodies.length, 0);
});

test("a cwd .env supplies the key when the environment does not", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  writeFileSync(join(l.cwd, ".env"), "TYPESAFE_API_KEY=tsk-from-dotenv\n");
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: { COMPACT_ADVISER_TEST_ENDPOINT: fixture.url },
  });
  assert.equal(fixture.bodies.length, 1);
});

test("mode off and COMPACT_ADVISER_DISABLE do nothing, and a refused judgment is silent", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const disabled = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: { ...keyed(fixture), COMPACT_ADVISER_DISABLE: "1" },
  });
  assert.equal(disabled.stdout.trim(), "{}");
  assert.equal(fixture.bodies.length, 0);

  fixture.status = 401;
  const refused = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: keyed(fixture),
  });
  assert.equal(refused.code, 0);
  assert.equal(refused.stdout.trim(), "{}");
  const shown = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(shown.stdout.trim(), "{}");

  assert.equal((await runCli(["mode", "off"], { lab: l })).code, 0);
  fixture.status = undefined;
  writeTranscript(l, [...workedTranscript("one"), ...workedTranscript("two").slice(1)]);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1, "only the refused request was made");
});

test("a compaction since the hint was earned retires it", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  writeTranscript(l, [...workedTranscript("one", { input: 3000, cache: 1000 })]);
  const shown = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(shown.stdout.trim(), "{}");
});

test("every hook prints valid JSON even for garbage input", async (t) => {
  const l = lab(t);
  for (const event of ["stop", "pre-invocation", "session-start", "nonsense"]) {
    const run = await runCli(["hook", event], { lab: l, stdin: "not json" });
    assert.equal(run.code, 0);
    assert.deepEqual(JSON.parse(run.stdout), {});
  }
});

test("install merges into an existing hooks.json, and uninstall removes only its own spec", async (t) => {
  const l = lab(t);
  const hooksPath = join(l.cwd, ".agents", "hooks.json");
  mkdirSync(join(l.cwd, ".agents"), { recursive: true });
  const firstmate = {
    SessionStart: [{ type: "command", command: "./firstmate-start.sh", timeout: 10 }],
  };
  writeFileSync(hooksPath, JSON.stringify({ firstmate, other: { enabled: false } }));

  const installed = await runCli(["install", l.cwd], { lab: l });
  assert.equal(installed.code, 0);
  assert.match(installed.stdout, /Left alone: firstmate, other/);
  const merged = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(merged.firstmate, firstmate);
  assert.deepEqual(merged.other, { enabled: false });
  const spec = merged[HOOK_NAME] as Record<string, { command: string; timeout: number }[]>;
  assert.deepEqual(Object.keys(spec).sort(), ["PreInvocation", "SessionStart", "Stop"]);
  assert.match(spec.Stop?.[0]?.command ?? "", /adviser\.ts' hook stop$/);
  assert.match(spec.PreInvocation?.[0]?.command ?? "", /adviser\.ts' hook pre-invocation$/);

  // Twice is the same file: re-running install replaces its own spec, never duplicates it.
  await runCli(["install", l.cwd], { lab: l });
  assert.deepEqual(JSON.parse(readFileSync(hooksPath, "utf8")), merged);

  const removed = await runCli(["uninstall", l.cwd], { lab: l });
  assert.equal(removed.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(hooksPath, "utf8")), {
    firstmate,
    other: { enabled: false },
  });
});

test("install creates hooks.json, and refuses to overwrite one it cannot parse", async (t) => {
  const l = lab(t);
  const hooksPath = join(l.cwd, ".agents", "hooks.json");
  assert.equal((await runCli(["install", l.cwd], { lab: l })).code, 0);
  assert.ok(existsSync(hooksPath));

  writeFileSync(hooksPath, "{ not json");
  const broken = await runCli(["install", l.cwd], { lab: l });
  assert.equal(broken.code, 1);
  assert.equal(readFileSync(hooksPath, "utf8"), "{ not json");
});

test("the installed hook command runs from another directory and the judgment lands", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["install", l.cwd], { lab: l });
  const spec = JSON.parse(readFileSync(join(l.cwd, ".agents", "hooks.json"), "utf8"))[HOOK_NAME];
  const run = await runShell(spec.Stop[0].command, {
    cwd: join(l.cwd, ".agents"),
    stdin: stopPayload(l),
    env: { COMPACT_ADVISER_AGY_HOME: l.dataDir, ...keyed(fixture) },
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), "{}");
  assert.equal(fixture.bodies.length, 1);
});

test("settings commands, status, and a refused auto mode", async (t) => {
  const l = lab(t);
  assert.match((await runCli(["threshold", "60000"], { lab: l })).stdout, /60,?000|60k/i);
  const auto = await runCli(["mode", "auto"], { lab: l });
  assert.equal(auto.code, 1);
  assert.match(auto.stderr, /not available on Antigravity/);
  const status = await runCli(["status", l.conversationId], { lab: l });
  assert.match(status.stdout, /hint-only/);
  assert.match(status.stdout, /Key: missing/);
  assert.ok(!status.stdout.includes("tsk-"));
  assert.match((await runCli(["snooze", l.conversationId], { lab: l })).stdout, /snoozed/);
  assert.equal((await runCli(["snooze"], { lab: l })).code, 1);
});

test("missing or torn transcripts do not inflate completed exchanges before settling", async (t) => {
  const l = lab(t);
  const fixture = await typesafeFixture(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.match(
    (await runCli(["status", l.conversationId], { lab: l })).stdout,
    /0 completed exchange/,
  );

  const torn = `${workedTranscript("one")
    .map((step) => JSON.stringify(step))
    .join("\n")}\n{"step_index":6`;
  writeFileSync(l.transcriptPath, torn);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 0);
  assert.match(
    (await runCli(["status", l.conversationId], { lab: l })).stdout,
    /0 completed exchange/,
  );

  writeTranscript(l, workedTranscript("one"));
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1);
  assert.match(
    (await runCli(["status", l.conversationId], { lab: l })).stdout,
    /1 completed exchange/,
  );
  const shown = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(userMarkdown(shown.stdout), HINT);
});

test("a concurrent snooze or mode off during an in-flight judgment suppresses the verdict", async (t) => {
  const snoozed = await judgeTurn(t);
  snoozed.fixture.onRequest = async () => {
    await runCli(["snooze", snoozed.l.conversationId], { lab: snoozed.l });
  };
  await runCli(["hook", "stop"], {
    lab: snoozed.l,
    stdin: stopPayload(snoozed.l),
    env: keyed(snoozed.fixture),
  });
  const afterSnooze = await runCli(["hook", "pre-invocation"], {
    lab: snoozed.l,
    stdin: preInvocationPayload(snoozed.l),
  });
  assert.equal(afterSnooze.stdout.trim(), "{}");
  assert.match(
    (await runCli(["status", snoozed.l.conversationId], { lab: snoozed.l })).stdout,
    /Pending hint: none/,
  );

  const turnedOff = await judgeTurn(t, "two");
  turnedOff.fixture.onRequest = async () => {
    await runCli(["mode", "off"], { lab: turnedOff.l });
  };
  await runCli(["hook", "stop"], {
    lab: turnedOff.l,
    stdin: stopPayload(turnedOff.l),
    env: keyed(turnedOff.fixture),
  });
  const afterOff = await runCli(["hook", "pre-invocation"], {
    lab: turnedOff.l,
    stdin: preInvocationPayload(turnedOff.l),
  });
  assert.equal(afterOff.stdout.trim(), "{}");
});

test("TYPESAFE_BASE and TYPESAFE_PATH=/api/v1/decide adapt the wire format and deliver the hint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const base = fixture.url.replace(/\/v1\/systemone$/, "");
  await runCli(["log", "on"], { lab: l });
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: {
      TYPESAFE_API_KEY: "tsk-test-key",
      TYPESAFE_BASE: base,
      TYPESAFE_PATH: "/api/v1/decide",
    },
  });
  assert.deepEqual(fixture.paths, ["/api/v1/decide"]);
  const sent = JSON.parse(fixture.bodies[0] ?? "{}") as {
    model: string;
    input: string;
    questions: { name: string; choices: { value: string; description: string }[] }[];
  };
  assert.equal(sent.model, "jev-latest");
  assert.equal(typeof sent.input, "string");
  assert.deepEqual(
    sent.questions.map((q) => q.name),
    ["done", "shape"],
  );
  const shown = await runCli(["hook", "pre-invocation"], {
    lab: l,
    stdin: preInvocationPayload(l),
  });
  assert.equal(userMarkdown(shown.stdout), HINT);
});
