import { describe, expect, it } from "vite-plus/test";

import {
  isUsageLimitReply,
  usageLimitReplyNotice,
  usageLimitReplyResetAt,
} from "./usageLimitReply.ts";

const COPILOT =
  "Error: You have exceeded your monthly quota (Request ID: E4AC:14943D:5809C3F:5DC09B6:6ADA0356)";

describe("usage limit replies", () => {
  it("reads Copilot's monthly quota reply as a limit with a short notice", () => {
    expect(isUsageLimitReply(COPILOT)).toBe(true);
    expect(usageLimitReplyNotice(COPILOT)).toBe("Monthly quota used up on this provider.");
    expect(usageLimitReplyNotice("Error: rate limit exceeded")).toBe(
      "Usage limit reached on this provider.",
    );
    expect(
      usageLimitReplyNotice("The GitHub API returned a rate limit exceeded error."),
    ).toBeNull();
  });

  it("reads a quota notice that ends with the provider's billing link", () => {
    const devin =
      "Error: Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";
    expect(isUsageLimitReply(devin)).toBe(true);
    expect(usageLimitReplyNotice(devin)).toBe("Weekly limit used up on this provider.");
    expect(usageLimitReplyResetAt(devin, Date.parse("2026-11-12T14:29:00Z"))).toBeNull();
    // Anything after that one sentence, a plain http link or another reason to visit is an answer.
    for (const text of [
      `${devin} I'll retry with another model.`,
      `${devin} The build also failed.`,
      "Error: Your weekly usage quota has been exhausted. Visit http://example.com to purchase more.",
      "Error: Your weekly usage quota has been exhausted. Visit https://example.com to read the docs.",
      "Error: Your disk quota has been exhausted. Visit https://example.com to purchase more.",
    ])
      expect(isUsageLimitReply(text), text).toBe(false);
  });

  it("dates a monthly quota's reset to the 1st of next month, UTC", () => {
    expect(usageLimitReplyResetAt(COPILOT, Date.parse("2026-10-22T12:35:30Z"))).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(usageLimitReplyResetAt(COPILOT, Date.parse("2026-12-31T23:59:00Z"))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(
      usageLimitReplyResetAt("Error: rate limit exceeded", Date.parse("2026-10-22T00:00:00Z")),
    ).toBeNull();
  });
});
