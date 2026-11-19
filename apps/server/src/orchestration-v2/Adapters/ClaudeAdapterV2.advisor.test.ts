import { assert, it } from "@effect/vitest";

import { claudeAdvisorItemTitle, claudeAdvisorModelFromUsage } from "./ClaudeAdapterV2.ts";

it("reads the model that answered from the advisor entry in usage", () => {
  assert.equal(
    claudeAdvisorModelFromUsage({
      input_tokens: 10,
      iterations: [
        { type: "message", input_tokens: 10 },
        { type: "advisor_message", model: "claude-fable-5-2", output_tokens: 40 },
        { type: "message", input_tokens: 12 },
      ],
    }),
    "claude-fable-5-2",
  );
});

it("takes the latest advisor entry when one message holds several", () => {
  assert.equal(
    claudeAdvisorModelFromUsage({
      iterations: [
        { type: "advisor_message", model: "claude-opus-5-5" },
        { type: "advisor_message", model: " claude-fable-5-2 " },
      ],
    }),
    "claude-fable-5-2",
  );
});

it("finds nothing in usage without an advisor entry", () => {
  for (const usage of [
    undefined,
    null,
    "usage",
    { input_tokens: 1 },
    { iterations: "none" },
    { iterations: [null, 4, { type: "message", model: "claude-fable-5-2" }] },
    { iterations: [{ type: "advisor_message" }, { type: "advisor_message", model: "  " }] },
  ]) {
    assert.isUndefined(claudeAdvisorModelFromUsage(usage));
  }
});

it("names the model in the consult title only when it is known", () => {
  assert.equal(claudeAdvisorItemTitle("claude-fable-5-2"), "Asked the advisor (claude-fable-5-2)");
  assert.equal(claudeAdvisorItemTitle(undefined), "Asked the advisor");
  assert.equal(
    claudeAdvisorItemTitle("claude-fable-5-2", true),
    "Asked the advisor (claude-fable-5-2) from Claude's settings",
  );
  assert.equal(claudeAdvisorItemTitle(undefined, true), "Asked the advisor");
});
