/**
 * One row per subscription account for Usage > Limits > Subscriptions: what
 * is left in each window and when it resets, when the subscription renews,
 * its banked resets, the machines signed in to it, and what its last reset
 * left unused. Pure, so the view and its tests share one reading.
 *
 * Nothing unknown becomes a number: a missing reset, renewal or loss is null
 * and the view says "Not reported".
 */
import type { ServerProvider, UsageResetPeriod } from "@specweave-studio/contracts";
import { expiringQuota } from "@specweave-studio/shared/expiringQuota";
import {
  type LimitAccount,
  limitAccountKey,
  remainingPercent,
} from "@specweave-studio/shared/usageLimits";
import { lossIsUpperBound } from "@specweave-studio/shared/usageResetLedger";
import { isLiveWindow, windowName, windowTitle } from "@specweave-studio/shared/usageWindows";

export interface SubscriptionWindow {
  readonly id: string;
  readonly title: string;
  readonly leftPercent: number;
  /** Null when the provider reports no reset time. */
  readonly resetsAt: number | null;
  /** Resets soon with much of it unused: the quota about to be lost. */
  readonly expiring: boolean;
  /** A weekly or monthly window, not a short one that refills within hours. */
  readonly long: boolean;
}

export interface SubscriptionRenewal {
  readonly at: number;
  /** Reported by the provider, or worked out from the day the person set. */
  readonly source: "provider" | "set";
  /** The day of the month the person set; a short month shows an earlier date, the day is kept. */
  readonly day?: number;
}

export interface SubscriptionLoss {
  readonly windowTitle: string;
  readonly lostPercent: number;
  readonly endedAt: number;
  /** The last read was long before the reset, so the real loss may be smaller. */
  readonly upperBound: boolean;
  readonly cause: UsageResetPeriod["cause"];
}

export interface SubscriptionRow {
  readonly key: string;
  /** The key the ledger and the renewal setting use; null when the account has no identity. */
  readonly accountKey: string | null;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly plan: string | null;
  readonly email: string | null;
  /** Machines signed in to it, or the hub that read it. */
  readonly machines: readonly string[];
  readonly offline: boolean;
  readonly checkedAt: number | null;
  readonly windows: readonly SubscriptionWindow[];
  readonly renewal: SubscriptionRenewal | null;
  readonly credits: { readonly count: number; readonly nextExpiresAt: number | null } | null;
  readonly lastLoss: SubscriptionLoss | null;
}

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The next time the given day of the month comes round, in local time. A
 * month too short for the day renews on its last day, as billing does.
 */
export function nextRenewalOn(dayOfMonth: number, now: number): number {
  const today = new Date(now);
  const inMonth = (year: number, month: number) => {
    const last = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(dayOfMonth, last)).getTime();
  };
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const thisMonth = inMonth(today.getFullYear(), today.getMonth());
  return thisMonth >= startOfToday
    ? thisMonth
    : inMonth(today.getFullYear(), today.getMonth() + 1);
}

function windowsOf(account: LimitAccount, now: number): SubscriptionWindow[] {
  const expiring = expiringQuota({ usageLimits: account.limits } as ServerProvider, "", now);
  return account.limits.windows
    .filter((window) => isLiveWindow(window, now))
    .map((window) => ({
      id: window.id,
      title: windowTitle(window),
      leftPercent: remainingPercent(window),
      resetsAt: parseTime(window.resetsAt),
      expiring: expiring !== null && windowName(window) === expiring.window,
      long:
        window.kind === "weekly" ||
        window.kind === "monthly" ||
        (window.kind !== "session" && (window.windowDurationMins ?? 0) > 6 * 60),
    }));
}

function lastLossOf(
  account: LimitAccount,
  accountKey: string | null,
  periods: readonly UsageResetPeriod[],
): SubscriptionLoss | null {
  if (accountKey === null) return null;
  let latest: UsageResetPeriod | null = null;
  for (const period of periods) {
    // A model family's window is a slice of the account; the account-wide one is its loss.
    if (period.accountKey !== accountKey || period.modelScope !== undefined) continue;
    if (latest === null || Date.parse(period.endedAt) > Date.parse(latest.endedAt)) {
      latest = period;
    }
  }
  if (latest === null) return null;
  const window = account.limits.windows.find((candidate) => candidate.id === latest.windowId);
  const endedAt = Date.parse(latest.endedAt);
  return {
    windowTitle: window ? windowTitle(window) : latest.windowKind === "monthly" ? "Monthly" : "Weekly",
    lostPercent: Math.round(latest.lostPercent),
    endedAt,
    upperBound: lossIsUpperBound({ endedAt, lastReadAt: Date.parse(latest.lastReadAt) }),
    cause: latest.cause,
  };
}

/**
 * Rows for every account, the ones about to lose quota first, then by the
 * soonest reset, so the top of the list is what to act on.
 */
export function subscriptionRows(
  accounts: readonly LimitAccount[],
  periods: readonly UsageResetPeriod[],
  renewalDays: Readonly<Record<string, number>>,
  now: number,
): SubscriptionRow[] {
  const rows = accounts.map((account): SubscriptionRow => {
    const accountKey = limitAccountKey(account.driver, account.email, account.limits);
    const reported = parseTime(account.limits.renewsAt);
    const setDay = accountKey === null ? undefined : renewalDays[accountKey];
    const credits = account.limits.resetCredits;
    return {
      key: account.key,
      accountKey,
      driver: account.driver,
      displayName: account.displayName,
      plan: account.limits.planLabel?.trim() || account.plan?.trim() || null,
      email: account.email?.trim() || null,
      machines:
        account.environments.length > 0
          ? account.environments.map((environment) => environment.label)
          : account.sourceLabel
            ? [account.sourceLabel]
            : [],
      offline: account.offline,
      checkedAt: parseTime(account.limits.checkedAt),
      windows: windowsOf(account, now),
      renewal:
        reported !== null && reported > now
          ? { at: reported, source: "provider" }
          : setDay !== undefined
            ? { at: nextRenewalOn(setDay, now), source: "set", day: setDay }
            : null,
      credits:
        credits && credits.availableCount > 0
          ? { count: credits.availableCount, nextExpiresAt: parseTime(credits.nextExpiresAt) }
          : null,
      lastLoss: lastLossOf(account, accountKey, periods),
    };
  });
  const soonest = (row: SubscriptionRow) =>
    row.windows.reduce(
      (best, window) => (window.resetsAt === null ? best : Math.min(best, window.resetsAt)),
      Number.POSITIVE_INFINITY,
    );
  const expiring = (row: SubscriptionRow) => row.windows.some((window) => window.expiring);
  return rows.toSorted(
    (left, right) =>
      Number(expiring(right)) - Number(expiring(left)) ||
      soonest(left) - soonest(right) ||
      left.key.localeCompare(right.key),
  );
}
