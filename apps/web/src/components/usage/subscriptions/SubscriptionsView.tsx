import type { EnvironmentId, UsageProviderKind, UsageResetPeriod } from "@specweave-studio/contracts";
import { formatTokens, makeWindow } from "@specweave-studio/shared/usageFormat";
import {
  type LimitAccount,
  collectLimitAccounts,
  collectUnreportedLimitAccounts,
  limitAccountKey,
} from "@specweave-studio/shared/usageLimits";
import { useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { useUsage } from "../../../state/usage";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { getDriverOption } from "../../settings/providerDriverMeta";
import { Button } from "../../ui/button";
import { barColor } from "../UsageLimits";
import { useUsageLimitHistory } from "../usageLimitHistoryState";
import { SubscriptionsDashboard } from "./SubscriptionsDashboard";
import { SubscriptionRow, formatDay } from "./SubscriptionRow";
import type { EfficiencyPeriod } from "./efficiency";
import { resetReport, resetReportMarkdown, tokensLostAtReset } from "./resetReportModel";
import { NoReadingRow } from "./NoReadingRow";
import {
  noReadingRows,
  subscriptionRows,
  subscriptionsSummary,
  subscriptionsSummaryText,
} from "./subscriptionRows";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { ResetAnnouncements } from "./ResetAnnouncements";
import { useResetAnnouncements } from "./resetAnnouncementsState";
import { useUsageResetLedger } from "./usageResetLedgerState";

const REPORT_WEEKS = 4;
const USAGE_DAYS = 45;

const USAGE_KIND: Partial<Record<string, UsageProviderKind>> = {
  codex: "codex",
  claudeAgent: "claude",
};

/** "Codex Pro · m1": the provider and plan, then where it is signed in. */
export function subscriptionLabel(account: LimitAccount): string {
  const provider = getDriverOption(account.driver)?.label ?? String(account.driver);
  const plan = account.limits.planLabel?.trim() || account.plan?.trim();
  const machines = account.environments.map((environment) => environment.label).join(", ");
  return [plan ? `${provider} ${plan}` : provider, machines || account.sourceLabel]
    .filter(Boolean)
    .join(" · ");
}

const driverLabel = (driver: LimitAccount["driver"]) =>
  getDriverOption(driver)?.label ?? String(driver);

/**
 * Every subscription on every connected machine, then what each reset left
 * unused. Reads the same accounts as the pooled view; the ledger of closed
 * periods comes from each machine that is connected.
 */
export function SubscriptionsView({
  presentations,
  now,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const [copied, setCopied] = useState(false);
  const nickname = useMachineNicknames();
  const accounts = collectLimitAccounts(presentations, { machineName: nickname });
  const connected = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection === undefined || presentation.connection.phase === "connected",
    )
    .map(([environmentId]) => environmentId as EnvironmentId);
  const ledger = useUsageResetLedger(connected, now);
  const announcements = useResetAnnouncements(usePrimaryEnvironmentId(), now);
  const history = useUsageLimitHistory(connected, now);
  const renewalDays = usePrimarySettings((settings) => settings.subscriptionRenewalDays);
  const targets = usePrimarySettings((settings) => settings.subscriptionTargets);
  const prices = usePrimarySettings((settings) => settings.subscriptionPrices);
  const updateSettings = useUpdatePrimarySettings();
  const [usageWindow] = useState(() => makeWindow(USAGE_DAYS, undefined, "day"));
  const usage = useUsage(usageWindow, null);

  const periods: readonly UsageResetPeriod[] = ledger?.periods ?? [];
  const rows = subscriptionRows(accounts, periods, renewalDays ?? {}, now);
  const unread = noReadingRows(
    collectUnreportedLimitAccounts(presentations, accounts, {
      machineName: nickname,
      drivers: "all",
      driverLabel,
    }),
    driverLabel,
  );
  const summary = subscriptionsSummary(rows, unread.length, now);
  const byKey = useMemo(() => {
    const map = new Map<string, LimitAccount>();
    for (const account of accounts) {
      const key = limitAccountKey(account.driver, account.email, account.limits);
      if (key !== null) map.set(key, account);
    }
    return map;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- accounts is rebuilt each render; its keys decide.
  }, [accounts.map((account) => account.key).join("\n")]);
  // When each account of a provider was in use, now or in the ledger. Usage is counted per
  // provider, so a span's tokens are one account's only when no other account was in use
  // during it. An unknown start counts as always, so doubt withholds the estimate.
  const spansOfDriver = new Map<string, Map<string, Array<{ from: number; to: number }>>>();
  const span = (driver: string, key: string, from: number, to: number) => {
    const keys = spansOfDriver.get(driver) ?? new Map<string, Array<{ from: number; to: number }>>();
    keys.set(key, [...(keys.get(key) ?? []), { from, to }]);
    spansOfDriver.set(driver, keys);
  };
  const timeOr = (value: string | undefined, fallback: number) => {
    const at = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isFinite(at) ? at : fallback;
  };
  const lastClosed = new Map<string, number>();
  for (const period of periods) {
    const endedAt = timeOr(period.endedAt, now);
    span(period.driver, period.accountKey, timeOr(period.startedAt, Number.NEGATIVE_INFINITY), endedAt);
    lastClosed.set(period.accountKey, Math.max(lastClosed.get(period.accountKey) ?? 0, endedAt));
  }
  // The running period: from the last one that closed, when there is one, to the newest read.
  const running = (driver: string, key: string, lastReadAt: number) =>
    span(driver, key, lastClosed.get(key) ?? Number.NEGATIVE_INFINITY, lastReadAt);
  for (const account of accounts) {
    running(
      account.driver,
      limitAccountKey(account.driver, account.email, account.limits) ?? account.key,
      timeOr(account.limits.checkedAt, now),
    );
  }
  // An account read without closing a period still shared the provider's token counts. A
  // server too old to say when it was last read counts as read now.
  for (const open of ledger?.openAccounts ?? []) {
    running(open.driver, open.accountKey, timeOr(open.lastReadAt, now));
  }
  const tokensSpent = (
    { accountKey, driver }: { readonly accountKey: string; readonly driver: UsageResetPeriod["driver"] },
    from: number,
    to: number,
  ) => {
    const kind = USAGE_KIND[driver];
    if (kind === undefined) return null;
    for (const [other, spans] of spansOfDriver.get(driver) ?? []) {
      if (other !== accountKey && spans.some((used) => used.from < to && used.to > from)) return null;
    }
    if (usage.isPending || usage.isPartial) return null;
    let tokens = 0;
    let days = 0;
    for (const day of usage.merged.daily) {
      const start = new Date(`${day.day}T00:00:00`).getTime();
      if (start + 86_400_000 <= from || start >= to) continue;
      days += 1;
      tokens += day.byProvider.get(kind)?.totalTokens ?? 0;
    }
    return days === 0 ? null : tokens;
  };
  const report = resetReport(periods, now, { weeks: REPORT_WEEKS, tokensSpent });
  const tokensLostOf = (period: EfficiencyPeriod) =>
    tokensLostAtReset(period, (from, to) => tokensSpent(period, from, to));
  const labelOf = (accountKey: string) => {
    const account = byKey.get(accountKey);
    return account ? subscriptionLabel(account) : accountKey.replace(/^[^:]+:/, "");
  };
  const colorOf = (accountKey: string) => {
    const account = byKey.get(accountKey);
    return account?.accentColor ?? (account ? barColor(account.driver) : "var(--foreground)");
  };
  // Settings patches merge, so one entry is enough and the others stay.
  const setDay = (accountKey: string, day: number) => {
    updateSettings({ subscriptionRenewalDays: { [accountKey]: day } });
  };

  const machinesOf = (accountKey: string) =>
    byKey.get(accountKey)?.environments.map((environment) => environment.label) ?? [];
  const providerOf = (driver: UsageResetPeriod["driver"]) =>
    getDriverOption(driver)?.label ?? String(driver);
  // Settings patches merge by key, so a price cannot be removed, only replaced.
  const setPlan = (
    accountKey: string,
    plan: { readonly target: number; readonly price: number | null },
  ) => {
    updateSettings({
      subscriptionTargets: { [accountKey]: plan.target },
      ...(plan.price === null ? {} : { subscriptionPrices: { [accountKey]: plan.price } }),
    });
  };

  return (
    <div className="flex flex-col gap-6" data-subscriptions-view="">
      <p className="text-sm text-muted-foreground tabular-nums" data-subscriptions-summary="">
        {subscriptionsSummaryText(summary, now)}
      </p>
      <SubscriptionsDashboard
        ledger={ledger === null ? null : periods}
        rows={rows}
        history={history}
        now={now}
        targets={targets ?? {}}
        renewalDays={renewalDays ?? {}}
        prices={prices ?? {}}
        labelOf={labelOf}
        colorOf={colorOf}
        providerOf={providerOf}
        providerColorOf={barColor}
        machinesOf={machinesOf}
        tokensLostOf={tokensLostOf}
        onSetPlan={setPlan}
      />
      <section className="flex flex-col gap-3" aria-labelledby="current-windows-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="current-windows-heading" className="text-sm font-medium">
            Right now
          </h3>
          {report.accounts.length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(resetReportMarkdown(report, labelOf, formatDay, formatTokens))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied as Markdown" : "Copy 4-week report"}
            </Button>
          ) : null}
        </div>
        {rows.length === 0 && unread.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subscription reports its limits yet. Sign in to a provider on a connected machine.
          </p>
        ) : (
          <div className="rounded-lg border border-border/60">
            {rows.map((row) => (
              <SubscriptionRow
                key={row.key}
                row={row}
                color={colorOf(row.accountKey ?? "") ?? barColor(row.driver)}
                now={now}
                onSetDay={setDay}
              />
            ))}
            {unread.map((row) => (
              <NoReadingRow key={row.key} row={row} />
            ))}
          </div>
        )}
      </section>
      {announcements !== null ? (
        <ResetAnnouncements
          announcements={announcements.announcements}
          checkedAt={announcements.checkedAt}
          enabled={announcements.enabled}
          now={now}
        />
      ) : null}
    </div>
  );
}
