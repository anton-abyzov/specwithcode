import { ProviderDriverKind, type ServerProviderUsageLimits } from "@specweave-studio/contracts";
import { limitsNotice } from "@specweave-studio/shared/usageLimits";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: "12-hour" }) => unknown) =>
    select({ timestampFormat: "12-hour" }),
}));

import { RunOutNotice, runOutWindowsOf } from "./RunOutNotice";
import { LimitWindows } from "./UsageLimits";

const HOUR = 3_600_000;
const now = new Date(2026, 10, 1, 12, 0).getTime();
const claude = ProviderDriverKind.make("claudeAgent");

// Weekly only, as Claude reports an account with no 5-hour limit. 92 of 168
// hours left and 70% used: at this pace it empties in about 32h, before its reset.
const limits: ServerProviderUsageLimits = {
  checkedAt: new Date(now).toISOString(),
  windows: [
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 70,
      windowDurationMins: 10080,
      resetsAt: new Date(now + 92 * HOUR).toISOString(),
    },
  ],
};

describe("Claude limits without a 5-hour window", () => {
  it("draws the weekly row in the composer panel and no 5-hour row or placeholder", () => {
    expect(limitsNotice(limits)).toBeNull();
    const html = renderToStaticMarkup(
      <LimitWindows compact driver={claude} windows={limits.windows} now={now} />,
    );
    expect(html).toContain("Weekly");
    expect(html).toContain("30% left");
    expect(html).not.toMatch(/5-hour|Session/);
  });

  it("bases the pace warning on the weekly limit alone", () => {
    const html = renderToStaticMarkup(
      <RunOutNotice driver={claude} windows={runOutWindowsOf(limits.windows)} now={now} />,
    );
    expect(html).toContain("you&#x27;ll hit your weekly limit in");
    expect(html).not.toContain("5-hour");
  });
});
