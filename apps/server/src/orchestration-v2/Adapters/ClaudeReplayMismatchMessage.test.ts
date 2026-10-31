import { assert, describe, it } from "@effect/vitest";

import { ClaudeReplayFrameMismatchError } from "./ClaudeAdapterV2.testkit.ts";

describe("ClaudeReplayFrameMismatchError message", () => {
  it("names the differing frame paths with expected and actual values", () => {
    const error = new ClaudeReplayFrameMismatchError({
      scenario: "claude_idle_resume",
      cursor: 10,
      label: "query.open:2",
      expected: {
        type: "query.open",
        options: { model: "claude-sonnet-4-6", settings: { showThinkingSummaries: true } },
      },
      actual: {
        type: "query.open",
        options: {
          model: "claude-sonnet-4-6",
          settings: { showThinkingSummaries: true, permissions: { deny: ["Read(/x)"] } },
        },
      },
    });
    assert.include(error.message, "cursor 10");
    assert.include(error.message, "options.settings.permissions");
    assert.include(error.message, "Read(/x)");
    // One line, so CI one-line failure summaries keep the diagnosis.
    assert.notInclude(error.message, "\n");
  });
});
