import { assert, describe, it } from "@effect/vitest";

import {
  isUsageLimitReply,
  limitReplyTurnFailure,
  usageLimitReplyFailure,
} from "./acpLimitReply.ts";

const COPILOT_QUOTA_REPLY =
  "Error: You have exceeded your monthly quota (Request ID: E1F2:3A4B:5C6D:7E8F:9A0B1C2D)";

describe("usage limit replies", () => {
  it("reads Copilot's monthly quota reply as a usage limit", () => {
    const failure = usageLimitReplyFailure(COPILOT_QUOTA_REPLY);
    assert.deepStrictEqual(failure, {
      class: "usage_limit",
      message: COPILOT_QUOTA_REPLY,
      code: null,
      retryable: null,
    });
  });

  it("reads other short limit notices", () => {
    for (const reply of [
      "Error: rate limit exceeded",
      "Error: Quota exceeded for this account.",
      "API Error: You've hit your session limit · resets 5:30am (America/New_York)",
      "Error 429: usage limit reached",
      "[Error] insufficient_quota",
      "Error - You have run out of credits.",
      "Error: Your premium request allowance has been exhausted.",
      "Error: 429 RESOURCE_EXHAUSTED",
      `  ${COPILOT_QUOTA_REPLY}\n`,
      "Error: You have exceeded your monthly quota\n(Request ID: E1F2:3A4B)",
    ])
      assert.isTrue(isUsageLimitReply(reply), reply);
  });

  it("leaves real answers and other errors alone", () => {
    for (const reply of [
      "",
      "Done. The PR is merged.",
      // Talks about quotas, but is an answer.
      "The GitHub API rate limit is 5,000 requests per hour; we used 12 so far.",
      "Copilot has a monthly quota of premium requests. You have exceeded your quota twice this year, so plan ahead.\nNext steps follow.",
      "Here is what happened:\nError: You have exceeded your monthly quota (Request ID: X)",
      "I checked the logs. Error: rate limit exceeded appears 3 times in the worker output.",
      // Errors that are no usage limit: another provider would not help.
      "Error: maximum context length exceeded",
      "Error: recursion limit reached",
      "Error: token limit exceeded for this request",
      "Error: file not found",
      // A single line that only mentions a limit.
      "Usage limits reset weekly on Monday.",
      // No error prefix: a coordinator answering why a thread stopped.
      "You have exceeded your monthly quota",
      "You've hit your Claude session limit; it resets at 5:00 PM.",
      "You have reached your weekly limit on Codex, so I moved the thread to Claude.",
      "You've hit your Codex weekly limit, so I moved this thread to Copilot. It resets Friday at 9 AM.",
      "You have exceeded your monthly quota on Copilot; the disk audit thread is waiting for it to reset.",
      "You've reached your weekly limit on Claude. Want me to switch the coordinator to Codex?",
      "You ran out of credits on the Claude API key, so the thread stopped.",
      "You have exceeded the GitHub API rate limit; wait an hour or set GITHUB_TOKEN.",
      "Rate limit exceeded on the npm registry, so the publish didn't go through.",
      "Rate limit exceeded on the GitHub API; I'll retry the PR check in a minute.",
      "Quota exceeded for the Gemini key in .env",
      'Both failures hit the usage limit, and each already got a "Continue".',
      // An error prefix, but a third-party limit or the agent's own report.
      "Error: GitHub API rate limit exceeded while listing PRs. I'll retry in an hour.",
      "Error: rate limit exceeded while listing PRs. I'll retry in an hour.",
      "Error: the npm registry quota was exceeded, so the publish failed.",
      "Error: You have exceeded the GitHub API rate limit.",
      // Long enough to be an answer, even opening like an error.
      `Error: ${"The deploy failed because the rate limit was exceeded on the registry. ".repeat(8)}`,
    ])
      assert.isFalse(isUsageLimitReply(reply), reply);
    assert.isNull(usageLimitReplyFailure("Done."));
  });

  it("rejects third-party reports even when they open with a limit notice", () => {
    for (const reply of [
      "Error: rate limit exceeded on the GitHub API. Retry when the API limit resets.",
      "Error: rate limit exceeded while listing PRs. Retry in an hour.",
      "Error: Quota exceeded for the Gemini key in .env.",
      "Error: You have exceeded your monthly quota on the npm registry.",
      "Error: You have exceeded your GitHub API rate limit.",
      "Error: Your npm registry quota has been exhausted.",
      "Error: rate limit exceeded. The deployment completed before the API check failed.",
      `${COPILOT_QUOTA_REPLY}\nThat is the error in the supplied log.`,
    ]) {
      assert.isFalse(isUsageLimitReply(reply), reply);
      assert.isNull(
        limitReplyTurnFailure({
          messageText: "Summarize the supplied API error and say when to retry.",
          continuation: false,
          didWork: false,
          assistantText: [reply],
        }),
        reply,
      );
    }
  });

  it("reads a limit reply only from a prompt the agent answered without working", () => {
    const turn = {
      messageText: "Continue where you left off.",
      continuation: false,
      didWork: false,
      assistantText: [COPILOT_QUOTA_REPLY],
    };
    assert.strictEqual(limitReplyTurnFailure(turn)?.class, "usage_limit");
    // A wake continuation reports work an earlier turn started.
    assert.isNull(
      limitReplyTurnFailure({
        ...turn,
        continuation: true,
        assistantText: ["Error: rate limit exceeded"],
      }),
    );
    assert.isNull(limitReplyTurnFailure({ ...turn, didWork: true }));
    // A slash command's reply describes the account.
    assert.isNull(limitReplyTurnFailure({ ...turn, messageText: "/usage" }));
    assert.isNull(limitReplyTurnFailure({ ...turn, assistantText: ["Checking.", "Done."] }));
    assert.isNull(
      limitReplyTurnFailure({
        ...turn,
        assistantText: ["Error: rate limit exceeded", "The GitHub API check failed."],
      }),
    );
  });
});
