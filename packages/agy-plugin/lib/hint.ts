// What the person is told, and the name of the hooks.json spec that tells them.

/** The one hint, worded as on every other host. */
export const HINT =
  "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
/** The hook spec's name in `.agents/hooks.json`; `install` owns this key and no other. */
export const HOOK_NAME = "compact-adviser";

/**
 * The hint as a hook result. `systemMessage` is empty on purpose: the model is sent nothing,
 * and the UI renders `metadata.user_markdown` inline for the person.
 */
export function hintResult(): string {
  return JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage: "", metadata: { user_markdown: HINT } } }],
  });
}
