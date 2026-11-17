// The usage ring panel's "Used before reset" summary over fictional accounts,
// with a frozen clock (Tuesday November 17, 2026, 10 AM). Query: ?theme=light|dark
import { ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import { ArrowRightIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { EffectivenessSummaryView } from "~/components/usage/subscriptions/EffectivenessSummary";
import { effectivenessIndex } from "~/components/usage/subscriptions/effectivenessIndex";
import type { SubscriptionRow } from "~/components/usage/subscriptions/subscriptionRows";
import { Button } from "~/components/ui/button";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 17, 10, 0).getTime();
const at = (month: number, day: number) => new Date(2026, month, day, 12).getTime();
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const grok = ProviderDriverKind.make("grok");

const period = (accountKey: string, driver: ProviderDriverKind, endedAt: number, used: number) =>
  ({
    accountKey,
    driver,
    windowId: "weekly",
    windowKind: "weekly",
    endedAt: new Date(endedAt).toISOString(),
    lastReadAt: new Date(endedAt - HOUR).toISOString(),
    usedPercentAtReset: used,
    lostPercent: 100 - used,
    cause: "scheduled",
  }) as UsageResetPeriod;

const periods = [
  period("claude:one@example.com", claude, at(10, 6), 100),
  period("claude:one@example.com", claude, at(10, 13), 69),
  period("claude:two@example.com", claude, at(10, 7), 97),
  period("claude:three@example.com", claude, at(10, 11), 99),
  period("claude:four@example.com", claude, at(10, 14), 88),
  period("codex:one@example.com", codex, at(10, 4), 98),
];

const row = (
  driver: ProviderDriverKind,
  leftPercent: number,
  resetsAt: number,
): SubscriptionRow => ({
  key: `${driver}`,
  accountKey: `${driver}:one@example.com`,
  driver,
  displayName: null,
  plan: null,
  email: null,
  machines: [],
  offline: false,
  checkedAt: now,
  windows: [
    {
      id: "weekly",
      title: "Weekly",
      leftPercent,
      resetsAt,
      expiring: false,
      long: true,
      scoped: false,
      durationMs: 7 * DAY,
    },
  ],
  renewal: null,
  credits: null,
  lastLoss: null,
});

const index = effectivenessIndex(
  [row(claude, 30, now + 11 * HOUR), row(codex, 60, now + 3 * DAY), row(grok, 72, now + 7 * HOUR)],
  periods,
  now,
);

createRoot(document.getElementById("root")!).render(
  <main className="flex min-h-screen items-start justify-center p-6">
    <div
      className="sws-usage-popover flex w-[344px] max-w-full flex-col gap-3 rounded-xl border bg-popover p-3 text-xs shadow-lg"
      data-fixture-panel=""
    >
      <h2 className="m-0 text-[length:var(--text-compact)] font-medium">Limits by account</h2>
      <EffectivenessSummaryView index={index} now={now} />
      <footer className="flex gap-2 border-t pt-2">
        <Button variant="outline" size="xs">
          Effectiveness <ArrowRightIcon aria-hidden />
        </Button>
        <Button variant="outline" size="xs">
          All accounts <ArrowRightIcon aria-hidden />
        </Button>
      </footer>
    </div>
  </main>,
);
