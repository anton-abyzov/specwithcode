import { EnvironmentId, ProviderDriverKind } from "@specweave-studio/contracts";
import type { LimitAccount } from "@specweave-studio/shared/usageLimits";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../studio/shell/Tip", () => ({
  Tip: ({ children }: { readonly children: unknown }) => children,
}));

import { SubscriptionRow, formatDateTime } from "./SubscriptionRow";
import { subscriptionRows } from "./subscriptionRows";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 14, 20, 0).getTime();
const iso = (at: number) => new Date(at).toISOString();

const account = (overrides: Partial<LimitAccount> & Pick<LimitAccount, "limits">): LimitAccount => ({
  key: "env-m1:cursor",
  driver: ProviderDriverKind.make("cursor"),
  displayName: null,
  email: "me@example.com",
  plan: "Pro",
  accentColor: undefined,
  environments: [{ environmentId: EnvironmentId.make("env-m1"), label: "m1" }],
  sourceLabel: null,
  offline: false,
  redeem: null,
  ...overrides,
});

const renderAccount = (
  overrides: Partial<LimitAccount> & Pick<LimitAccount, "limits">,
  renewalDays: Record<string, number> = {},
) => {
  const [row] = subscriptionRows([account(overrides)], [], renewalDays, now);
  return renderToStaticMarkup(
    <SubscriptionRow row={row!} color="teal" now={now} onSetDay={() => undefined} />,
  );
};

describe("SubscriptionRow windows and notes", () => {
  it("shows each window's reset as a countdown and a local date and time, then the note", () => {
    const resetsAt = now + 2 * DAY;
    const html = renderAccount({
      limits: {
        checkedAt: iso(now),
        windows: [
          {
            id: "includedPool",
            kind: "weekly",
            label: "Included usage",
            windowDurationMins: 10_080,
            usedPercent: 30,
            resetsAt: iso(resetsAt),
          },
        ],
      },
    });
    expect(html).toContain(`70% left · 2d 0h · ${formatDateTime(resetsAt)}`);
    expect(html).toContain('data-subscription-note="cursor-weekly-pool"');
    expect(html).toContain("One weekly pool. No hourly limit.");
  });

  it("draws no note when no rule covers the reading", () => {
    const html = renderAccount({
      driver: ProviderDriverKind.make("claudeAgent"),
      limits: {
        checkedAt: iso(now),
        windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 10 }],
      },
    });
    expect(html).not.toContain("data-subscription-note");
  });
});

describe("SubscriptionRow renewal", () => {
  const windows = [{ id: "includedPool", kind: "weekly" as const, label: "Included usage", usedPercent: 10 }];

  it("shows the day the person set as theirs, with Change", () => {
    const html = renderAccount(
      { limits: { checkedAt: iso(now), windows, renewsAt: iso(now + 20 * DAY) } },
      { "cursor:me@example.com": 17 },
    );
    expect(html).toContain("Renews Nov 17 (set by you)");
    expect(html).toContain("Change");
    expect(html).not.toContain("reported by");
  });

  it("shows a reported date as the vendor's and still offers Set day", () => {
    const html = renderAccount({
      limits: {
        checkedAt: iso(now),
        windows: [{ id: "autoPercentUsed", kind: "monthly", label: "Cursor Models", usedPercent: 10 }],
        renewsAt: iso(new Date(2026, 11, 2, 12).getTime()),
      },
    });
    expect(html).toContain("Renews Dec 2 (reported by Cursor)");
    expect(html).toContain("Set day");
    expect(html).toContain("Usage resets monthly with your billing cycle.");
  });

  it("says a reading with nothing to key a day by cannot hold one", () => {
    const html = renderAccount({
      driver: ProviderDriverKind.make("acpRegistry"),
      email: undefined,
      limits: { checkedAt: iso(now), windows },
    });
    expect(html).toContain("No renewal day: this account reports nothing to save it under.");
    expect(html).not.toContain("Set day");
  });
});

describe("SubscriptionRow amounts", () => {
  it("shows Copilot's amounts beside the percent", () => {
    const html = renderAccount({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Copilot",
      email: undefined,
      limits: {
        checkedAt: iso(now),
        subscriptionKey: `copilot:sha256:${"c".repeat(64)}`,
        windows: [
          {
            id: "premium_interactions",
            kind: "monthly",
            label: "Premium requests",
            usedPercent: 59,
            used: 885,
            limit: 1500,
            unit: "premium requests",
          },
        ],
      },
    });
    expect(html).toContain("41% left (885 of 1,500 premium requests)");
  });
});
