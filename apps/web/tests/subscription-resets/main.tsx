// The real Subscriptions dashboard and rows over fictional accounts.
// `?case=empty` shows the states before any reading; `?theme=dark` the theme.
// The clock is the one the verifier freezes. Nothing here talks to a server.
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageWindow,
  type UsageResetPeriod,
} from "@specweave-studio/contracts";
import type { LimitAccount } from "@specweave-studio/shared/usageLimits";
import { limitAccountKey } from "@specweave-studio/shared/usageLimits";
import { quotaAlerts } from "@specweave-studio/shared/quotaAlerts";
import { barColor } from "../../src/components/usage/UsageLimits";
import { QuotaAlertBanner } from "../../src/components/usage/alerts/QuotaAlertBanner";
import { SubscriptionsDashboard } from "../../src/components/usage/subscriptions/SubscriptionsDashboard";
import { SubscriptionRow } from "../../src/components/usage/subscriptions/SubscriptionRow";
import { subscriptionLabel } from "../../src/components/usage/subscriptions/SubscriptionsView";
import { resetReport, tokensLostAtReset } from "../../src/components/usage/subscriptions/resetReportModel";
import { subscriptionRows } from "../../src/components/usage/subscriptions/subscriptionRows";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const empty = params.get("case") === "empty";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (at: number) => new Date(at).toISOString();
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  minutes: number,
  usedPercent: number,
  resetsIn: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  windowDurationMins: minutes,
  usedPercent,
  resetsAt: iso(now + resetsIn),
});

const account = (
  key: string,
  driver: LimitAccount["driver"],
  email: string,
  plan: string,
  machine: string,
  limits: Omit<LimitAccount["limits"], "checkedAt"> & { readonly checkedAt?: string },
  offline = false,
): LimitAccount => ({
  key,
  driver,
  displayName: null,
  email,
  plan,
  accentColor: undefined,
  environments: [{ environmentId: EnvironmentId.make(`env-${machine}`), label: machine }],
  sourceLabel: null,
  offline,
  redeem: null,
  limits: { checkedAt: iso(now - 4 * 60_000), ...limits },
});

const accounts: LimitAccount[] = empty
  ? []
  : [
      account("claude", claude, "ada@example.com", "Max 20x", "studio-mac", {
        windows: [
          window("five_hour", "session", "Session", 300, 29, 2 * HOUR + 10 * 60_000),
          window("seven_day", "weekly", "Weekly", 10_080, 82, 2 * DAY + 5 * HOUR),
        ],
        renewsAt: iso(now + 3 * DAY),
      }),
      account("codex", codex, "ada@example.com", "Pro", "mini", {
        windows: [window("secondary", "weekly", "Weekly", 10_080, 38, 9 * HOUR)],
        resetCredits: { availableCount: 2, nextExpiresAt: iso(now + 7 * DAY) },
      }),
      account(
        "codex-2",
        codex,
        "team@example.com",
        "Plus",
        "linux-box",
        {
          checkedAt: iso(now - 3 * HOUR),
          windows: [window("secondary", "weekly", "Weekly", 10_080, 60, 4 * DAY)],
        },
        true,
      ),
    ];

const period = (
  accountKey: string,
  driver: UsageResetPeriod["driver"],
  windowId: string,
  weeksAgo: number,
  used: number,
  lastReadBefore = HOUR,
): UsageResetPeriod => {
  const endedAt = now - weeksAgo * 7 * DAY - 2 * DAY;
  return {
    accountKey,
    driver,
    windowId,
    windowKind: "weekly",
    startedAt: iso(endedAt - 7 * DAY),
    endedAt: iso(endedAt),
    lastReadAt: iso(endedAt - lastReadBefore),
    usedPercentAtReset: used,
    lostPercent: 100 - used,
    cause: "scheduled",
  };
};

const periods: UsageResetPeriod[] = empty
  ? []
  : [
      ...[70, 74, 81, 77, 85, 88, 91, 86, 82, 95, 90, 96].map((used, index) =>
        period("claudeAgent:ada@example.com", claude, "seven_day", 11 - index, used),
      ),
      ...[22, 30, 28, 35, 41, 38, 46, 52, 40, 55, 48, 59].map((used, index) =>
        period("codex:ada@example.com", codex, "secondary", 11 - index, used),
      ),
      period("codex:team@example.com", codex, "secondary", 1, 27, 9 * HOUR),
    ];

const byKey = new Map(
  accounts.map((entry) => [limitAccountKey(entry.driver, entry.email, entry.limits) ?? "", entry]),
);
const labelOf = (key: string) => {
  const entry = byKey.get(key);
  return entry ? subscriptionLabel(entry) : key;
};
const colorOf = (key: string) => {
  const entry = byKey.get(key);
  return entry ? barColor(entry.driver) : "var(--foreground)";
};
const rows = subscriptionRows(accounts, periods, { "codex:ada@example.com": 2 }, now);
const report = resetReport(periods, now, {
  // 300M tokens behind Claude's used share; Codex has two accounts, so no estimate.
  tokensSpent: ({ driver }) => (driver === claude ? 300_000_000 : null),
});

// Readings through the newest Codex period, so its opened row draws use against an even pace.
const newest = now - 2 * DAY;
const history = new Map(
  empty
    ? []
    : [
        [
          "codex:ada@example.com|weekly:secondary",
          [0, 4, 9, 22, 25, 49, 55, 59].map((usedPercent, index) => ({
            at: newest - 7 * DAY + index * 0.99 * DAY,
            usedPercent,
            resetsAt: newest,
          })),
        ],
      ],
);

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-background text-foreground">
  <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4" data-fixture-ready="">
    {/* The banner at the sidebar's width, over the same accounts. */}
    <div className="w-64" data-fixture-banner="">
      <QuotaAlertBanner
        alerts={quotaAlerts(
          rows,
          empty
            ? []
            : [
                {
                  accountKey: "codex:team@example.com",
                  driver: "codex",
                  windowId: "secondary",
                  windowTitle: "Weekly",
                  endedAt: now - 2 * HOUR,
                },
              ],
          now,
        )}
        labelOf={(alert) => (byKey.get(alert.accountKey)?.plan ? `Codex ${byKey.get(alert.accountKey)?.plan}` : "Codex")}
        now={now}
        onOpen={() => undefined}
        onDismiss={() => undefined}
      />
    </div>
    <SubscriptionsDashboard
      ledger={periods}
      rows={rows}
      history={history}
      now={now}
      targets={{ "codex:team@example.com": 30 }}
      prices={{}}
      labelOf={labelOf}
      colorOf={colorOf}
      providerOf={(driver) => (driver === claude ? "Claude" : "Codex")}
      providerColorOf={barColor}
      machinesOf={(key) => byKey.get(key)?.environments.map((entry) => entry.label) ?? []}
      tokensLostOf={(period) =>
        period.driver === claude ? tokensLostAtReset(period, () => 300_000_000) : null
      }
      onSetPlan={() => undefined}
    />
    {rows.length === 0 ? (
      <p className="text-sm text-muted-foreground" data-fixture-empty="">
        No subscription reports its limits yet. Sign in to a provider on a connected machine.
      </p>
    ) : (
      <div className="rounded-lg border border-border/60">
        {rows.map((row) => (
          <SubscriptionRow
            key={row.key}
            row={row}
            color={colorOf(row.accountKey ?? "")}
            now={now}
            onSetDay={() => undefined}
          />
        ))}
      </div>
    )}

  </main>
  </div>,
);
