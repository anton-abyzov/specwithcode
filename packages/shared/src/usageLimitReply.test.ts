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
