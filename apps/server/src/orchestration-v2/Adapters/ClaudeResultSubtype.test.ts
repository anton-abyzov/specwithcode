import { assert, it } from "@effect/vitest";

import { claudeResultSubtypeMessage } from "./ClaudeAdapterV2.ts";

it("names the reason for a Claude error result that lists no errors", () => {
  assert.include(claudeResultSubtypeMessage("error_max_turns") ?? "", "maximum number of steps");
  assert.include(claudeResultSubtypeMessage("error_max_budget_usd") ?? "", "spending limit");
  assert.include(
    claudeResultSubtypeMessage("error_during_execution") ?? "",
    "error while running this turn",
  );
});

it("leaves unknown subtypes to the class fallback", () => {
  assert.isUndefined(claudeResultSubtypeMessage("error_something_new"));
});
