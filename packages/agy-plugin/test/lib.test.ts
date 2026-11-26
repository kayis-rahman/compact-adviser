// The Antigravity-specific glue, exercised directly: the transcript reader against the record
// shapes agy actually writes, and the usage it reads from them.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ENDPOINT,
  isDecideEndpoint,
  parseJudgment,
  requestBody,
  typesafeEndpoint,
} from "../lib/judge.ts";
import { snapshot } from "../lib/snapshot.ts";
import { parseTranscript, userText } from "../lib/transcript.ts";
import { usageFraction } from "../lib/usage.ts";
import { workedTranscript } from "./support.ts";

const lines = (steps: readonly unknown[]) => steps.map((step) => JSON.stringify(step)).join("\n");

test("the reader pairs each tool result with the call that made it, in order", () => {
  const t = parseTranscript(lines(workedTranscript("one")));
  assert.equal(t.unreadableLines, 0);
  assert.equal(t.steps, 6);
  assert.deepEqual(
    t.messages.map((m) => m.role),
    ["user", "assistant", "assistant"],
  );
  const calls = t.messages[1]?.toolUses ?? [];
  assert.deepEqual(
    calls.map((c) => [c.tool, c.text]),
    [
      ["write_to_file", "created file"],
      ["run_command", "exit 0"],
    ],
  );
});

test("a tool step that did not finish is reported as an error and adds no artifact", () => {
  const steps = workedTranscript("one");
  (steps[3] as Record<string, unknown>).status = "ERROR";
  const t = parseTranscript(lines(steps));
  assert.equal(t.messages[1]?.toolUses[0]?.isError, true);
  assert.deepEqual(snapshot(t.messages).state.savedArtifacts, ["notes-one.txt"]);
});

test("context usage is uncached plus cached input of the newest model step", () => {
  const t = parseTranscript(lines(workedTranscript("one", { input: 21226, cache: 25923 })));
  assert.deepEqual(t.usage, { tokens: 47149, source: "transcript" });
  assert.equal(usageFraction(t.usage, 0), Number.NaN);
  assert.equal(usageFraction(t.usage, 94298), 0.5);
});

test("missing token counts are unknown usage, which takes the strictest floor", () => {
  const t = parseTranscript(
    lines([{ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", content: "hi" }]),
  );
  assert.deepEqual(t.usage, { source: "unknown" });
  assert.ok(Number.isNaN(usageFraction(t.usage, 100000)));
});

test("a record the reader cannot use is skipped, not guessed at", () => {
  const t = parseTranscript(
    [
      JSON.stringify(workedTranscript("one")[0]),
      "{ torn line",
      JSON.stringify({ type: "SOMETHING_NEW", source: "MODEL", content: "from a later agy" }),
      "42",
    ].join("\n"),
  );
  assert.equal(t.unreadableLines, 2);
  assert.equal(t.messages.length, 1);
});

test("the person's words are what Jev reads, not the harness envelopes around them", () => {
  assert.equal(
    userText(
      "<USER_REQUEST>\nship it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>",
    ),
    "ship it",
  );
  assert.equal(
    userText("plain\n<USER_SETTINGS_CHANGE>\nmodel changed\n</USER_SETTINGS_CHANGE>"),
    "plain",
  );
});

test("shell redirection through run_command feeds the saved-artifact list", () => {
  const t = parseTranscript(
    lines([
      {
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        content: "Writing.",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "echo hi > out.txt && tee log.txt" } },
          { name: "run_command", args: { CommandLine: "cat <<EOF\nfake > nope.txt\nEOF" } },
        ],
      },
    ]),
  );
  assert.deepEqual(snapshot(t.messages).state.savedArtifacts, ["out.txt", "log.txt"]);
});

test("TYPESAFE_BASE and TYPESAFE_PATH keep TypeSafe by default and validate overrides", () => {
  assert.equal(typesafeEndpoint(undefined), ENDPOINT);
  assert.equal(
    typesafeEndpoint("https://example.com"),
    `https://example.com${new URL(ENDPOINT).pathname}`,
  );
  assert.equal(
    typesafeEndpoint("https://jevtypesafeai.com", "/api/v1/decide"),
    "https://jevtypesafeai.com/api/v1/decide",
  );
  assert.equal(typesafeEndpoint("http://evil.example.com"), undefined);
  assert.equal(typesafeEndpoint("https://jevtypesafeai.com", "/api/../decide"), undefined);
  const decide = "https://jevtypesafeai.com/api/v1/decide";
  assert.equal(isDecideEndpoint(ENDPOINT), false);
  assert.equal(isDecideEndpoint(decide), true);
  const body = JSON.parse(requestBody({ note: "ok" }, undefined, decide)) as {
    model: string;
    input: string;
    questions: { name: string }[];
  };
  assert.equal(body.model, "jev-latest");
  assert.equal(body.input, JSON.stringify({ note: "ok" }));
  assert.deepEqual(
    body.questions.map((q) => q.name),
    ["done", "shape"],
  );
  const parsed = parseJudgment(
    {
      model: "jev-1.13.0",
      answers: [
        {
          type: "choice",
          name: "done",
          choice: "finished",
          confidence: 0.9,
          probabilities: [
            { value: "finished", probability: 0.95 },
            { value: "not_finished", probability: 0.05 },
            { value: "unclear", probability: 0 },
          ],
        },
        {
          type: "choice",
          name: "shape",
          choice: "hands_on",
          confidence: 0.9,
          probabilities: [
            { value: "hands_on", probability: 0.95 },
            { value: "coordinating", probability: 0.05 },
            { value: "unclear", probability: 0 },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    decide,
  );
  assert.equal(parsed.done.choice, "finished");
  assert.equal(parsed.shape.choice, "hands_on");
});
