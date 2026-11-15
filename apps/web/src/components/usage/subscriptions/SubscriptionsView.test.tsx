import { EnvironmentId, ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import type { LimitAccount } from "@specweave-studio/shared/usageLimits";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../studio/shell/Tip", () => ({
  Tip: ({ children }: { readonly children: unknown }) => children,
}));

import { ResetReport } from "./ResetReport";
import { SubscriptionRow } from "./SubscriptionRow";
import { resetReport } from "./resetReportModel";
import { subscriptionRows } from "./subscriptionRows";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 14, 20, 0).getTime();
const iso = (at: number) => new Date(at).toISOString();
const codex = ProviderDriverKind.make("codex");

const account = (overrides: Partial<LimitAccount> & Pick<LimitAccount, "limits">): LimitAccount => ({
  key: "env-m1:codex",
  driver: codex,
  displayName: null,
  email: "pro@example.com",
  plan: "Pro",
  accentColor: undefined,
  environments: [{ environmentId: EnvironmentId.make("env-m1"), label: "m1" }],
  sourceLabel: null,
  offline: false,
  redeem: null,
  ...overrides,
});

const weekly = (usedPercent: number, resetsIn: number) => ({
  id: "secondary",
  kind: "weekly" as const,
  label: "Weekly",
  windowDurationMins: 10_080,
  usedPercent,
  resetsAt: iso(now + resetsIn),
});

const lost = (endedAt: number, lostPercent: number, lastReadBefore = HOUR): UsageResetPeriod => ({
  accountKey: "codex:pro@example.com",
  driver: codex,
  windowId: "secondary",
  windowKind: "weekly",
  startedAt: iso(endedAt - 7 * DAY),
  endedAt: iso(endedAt),
  lastReadAt: iso(endedAt - lastReadBefore),
  usedPercentAtReset: 100 - lostPercent,
  lostPercent,
  cause: "scheduled",
});

const renderRow = (limits: LimitAccount["limits"], periods: UsageResetPeriod[] = [], extra = {}) => {
  const [row] = subscriptionRows([account({ limits, ...extra })], periods, {}, now);
  return renderToStaticMarkup(
    <SubscriptionRow row={row!} color="teal" now={now} onSetDay={() => undefined} />,
  );
};

describe("SubscriptionRow", () => {
  it("shows the plan, machine, what is left and the countdown, with the expiring window marked", () => {
    const html = renderRow({
      checkedAt: iso(now),
      windows: [weekly(38, 9 * HOUR)],
      resetCredits: { availableCount: 2, nextExpiresAt: iso(new Date(2026, 10, 21).getTime()) },
    });
    expect(html).toContain("Pro");
    expect(html).toContain("pro@example.com");
    expect(html).toContain(">m1<");
    expect(html).toContain("62% left · 9h 0m");
    expect(html).toContain('data-expiring=""');
    expect(html).toContain("2 banked resets, next expires Nov 21");
  });

  it("says Not reported for an unknown renewal and loss, and offers to set the day", () => {
    const html = renderRow({ checkedAt: iso(now), windows: [weekly(10, 3 * DAY)] });
    expect(html).toContain("Renewal: Not reported");
    expect(html).toContain("Set day");
    expect(html).toContain("Lost at last reset: Not reported");
    expect(html).not.toContain("data-expiring");
  });

  it("shows the provider's renewal date, and the last loss as an upper bound when read long before", () => {
    const html = renderRow(
      {
        checkedAt: iso(now),
        windows: [weekly(10, 3 * DAY)],
        renewsAt: iso(new Date(2026, 11, 2, 12).getTime()),
      },
      [lost(now - 4 * DAY, 41, 9 * HOUR)],
    );
    expect(html).toContain("Renews Dec 2");
    expect(html).not.toContain("Set day");
    expect(html).toContain("up to 41%");
  });

  it("keeps an offline machine's last reading and says how old it is", () => {
    const html = renderRow(
      { checkedAt: iso(now - 3 * HOUR), windows: [weekly(60, 4 * DAY)] },
      [],
      { offline: true },
    );
    expect(html).toContain("offline, read 3h 0m ago");
    expect(html).toContain("40% left");
  });
});

describe("ResetReport", () => {
  it("draws the weeks and lists used, lost and an unmeasurable token figure in words", () => {
    const report = resetReport([lost(now - 4 * DAY, 41), lost(now - 11 * DAY, 45)], now);
    const html = renderToStaticMarkup(
      <ResetReport report={report} labelOf={() => "Codex Pro · m1"} colorOf={() => "teal"} />,
    );
    expect(html).toContain("Lost this week: <span");
    expect(html).toContain("Codex Pro · m1");
    expect(html).toContain("43% over 2 resets");
    expect(html).toContain("Not measurable");
    expect(html).toContain("Nov 9");
  });

  it("says so when no reset was recorded yet", () => {
    const html = renderToStaticMarkup(
      <ResetReport report={resetReport([], now)} labelOf={String} colorOf={String} />,
    );
    expect(html).toContain('data-reset-report="empty"');
    expect(html).toContain("No reset recorded yet");
  });
});
