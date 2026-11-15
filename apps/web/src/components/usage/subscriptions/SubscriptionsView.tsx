import type { EnvironmentId, UsageProviderKind, UsageResetPeriod } from "@specweave-studio/contracts";
import { formatTokens, makeWindow } from "@specweave-studio/shared/usageFormat";
import {
  type LimitAccount,
  collectLimitAccounts,
  limitAccountKey,
} from "@specweave-studio/shared/usageLimits";
import { useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { useUsage } from "../../../state/usage";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { getDriverOption } from "../../settings/providerDriverMeta";
import { Button } from "../../ui/button";
import { barColor } from "../UsageLimits";
import { ResetReport } from "./ResetReport";
import { SubscriptionRow, formatDay } from "./SubscriptionRow";
import { resetReport, resetReportMarkdown } from "./resetReportModel";
import { subscriptionRows } from "./subscriptionRows";
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
  const renewalDays = usePrimarySettings((settings) => settings.subscriptionRenewalDays);
  const updateSettings = useUpdatePrimarySettings();
  const [usageWindow] = useState(() => makeWindow(USAGE_DAYS, undefined, "day"));
  const usage = useUsage(usageWindow, null);

  const periods: readonly UsageResetPeriod[] = ledger ?? [];
  const rows = subscriptionRows(accounts, periods, renewalDays ?? {}, now);
  const byKey = useMemo(() => {
    const map = new Map<string, LimitAccount>();
    for (const account of accounts) {
      const key = limitAccountKey(account.driver, account.email, account.limits);
      if (key !== null) map.set(key, account);
    }
    return map;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- accounts is rebuilt each render; its keys decide.
  }, [accounts.map((account) => account.key).join("\n")]);
  // Every account of a provider seen now or in the ledger: one that signed out since still
  // spent tokens in the periods it has.
  const accountsOfDriver = new Map<string, Set<string>>();
  const seen = (driver: string, key: string) => {
    const keys = accountsOfDriver.get(driver) ?? new Set<string>();
    keys.add(key);
    accountsOfDriver.set(driver, keys);
  };
  for (const account of accounts) {
    seen(account.driver, limitAccountKey(account.driver, account.email, account.limits) ?? account.key);
  }
  for (const period of periods) seen(period.driver, period.accountKey);
  const report = resetReport(periods, now, {
    weeks: REPORT_WEEKS,
    tokensSpent: ({ driver }, from, to) => {
      const kind = USAGE_KIND[driver];
      // Usage is counted per provider, so it is one account's only when it is the only one.
      if (kind === undefined || accountsOfDriver.get(driver)?.size !== 1) return null;
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
    },
  });
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

  return (
    <div className="flex flex-col gap-6" data-subscriptions-view="">
      {rows.length === 0 ? (
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
        </div>
      )}
      <section className="flex flex-col gap-3" aria-labelledby="reset-report-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="reset-report-heading" className="text-sm font-medium">
            Used against lost at each reset
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
              {copied ? "Copied as Markdown" : "Copy report"}
            </Button>
          ) : null}
        </div>
        {ledger === null ? (
          <p className="text-sm text-muted-foreground">Reading the reset history…</p>
        ) : (
          <ResetReport report={report} labelOf={labelOf} colorOf={colorOf} />
        )}
      </section>
    </div>
  );
}
