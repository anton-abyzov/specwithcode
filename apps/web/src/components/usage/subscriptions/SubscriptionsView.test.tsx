import { EnvironmentId, ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import type { LimitAccount } from "@specweave-studio/shared/usageLimits";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../studio/shell/Tip", () => ({
  Tip: ({ children }: { readonly children: unknown }) => children,
}));

import { SubscriptionsDashboard } from "./SubscriptionsDashboard";
import { SubscriptionRow } from "./SubscriptionRow";
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

const dashboard = (ledger: UsageResetPeriod[] | null) =>
  renderToStaticMarkup(
    <SubscriptionsDashboard
      ledger={ledger}
      rows={[]}
      history={null}
      now={now}
      targets={{}}
      prices={{}}
      labelOf={() => "Codex Pro · m1"}
      colorOf={() => "teal"}
      providerOf={() => "Codex"}
      providerColorOf={() => "teal"}
      machinesOf={() => ["m1"]}
      tokensLostOf={() => null}
      onSetPlan={() => undefined}
    />,
  );

describe("SubscriptionsDashboard", () => {
  it("leads with the score and lists the resets behind it, newest first", () => {
    const html = dashboard([lost(now - 4 * DAY, 41), lost(now - 11 * DAY, 45)]);
    // 59% and 55% used: the mean is 57.
    expect(html).toContain('data-efficiency-score="">57%');
    expect(html).toContain("average over 2 resets");
    expect(html).toContain("Codex Pro · m1");
    expect(html).toContain("1 to 2 of 2 resets");
    const table = html.slice(html.indexOf("data-resets-table"));
    expect(table.indexOf("59%")).toBeLessThan(table.indexOf("55%"));
    expect(html).toContain("At its scheduled time");
  });

  it("gives no score from one reset, and says the loss is an upper bound", () => {
    const html = dashboard([lost(now - 4 * DAY, 90, 9 * HOUR)]);
    expect(html).toContain("Not enough history yet");
    expect(html).not.toContain("data-efficiency-score");
    expect(html).toContain("up to 90%");
    expect(html).toContain("at least</span>10%");
    // One reset is drawn, and said to be one reading, not an average.
    expect(html).toContain("at least 10% at its one reset");
  });

  it("marks a score that holds a reset read long before it happened", () => {
    const html = dashboard([lost(now - 4 * DAY, 41), lost(now - 11 * DAY, 45, 9 * HOUR)]);
    expect(html).toContain('data-efficiency-floor="">at least');
    expect(html).toContain("at least 55% at its one reset");
  });

  it("keeps a week with no reset reachable by keyboard", () => {
    const html = dashboard([lost(now - 4 * DAY, 41), lost(now - 11 * DAY, 45)]);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]*data-efficiency-column[^>]* disabled/);
  });

  it("says so before the first read and when nothing was recorded", () => {
    expect(dashboard(null)).toContain("Reading the reset history");
    const empty = dashboard([]);
    expect(empty).toContain('data-efficiency-chart="empty"');
    expect(empty).toContain('data-resets-table="empty"');
    expect(empty).not.toMatch(/\b0%/);
  });
});
