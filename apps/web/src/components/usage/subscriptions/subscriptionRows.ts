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
  type UnreportedLimitAccount,
  formatDuration,
  limitAccountKey,
  remainingPercent,
} from "@specweave-studio/shared/usageLimits";
import { lossIsUpperBound } from "@specweave-studio/shared/usageResetLedger";
import {
  type SubscriptionNoteProvider,
  type SubscriptionWindowRule,
  subscriptionWindowNote,
} from "@specweave-studio/shared/subscriptionWindowRules";
import { providerUsageLink } from "@specweave-studio/shared/providerUsageLinks";
import {
  isLiveWindow,
  windowModelScope,
  windowName,
  windowTitle,
} from "@specweave-studio/shared/usageWindows";

export interface SubscriptionWindow {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly title: string;
  readonly leftPercent: number;
  /** Null when the provider reports no reset time. */
  readonly resetsAt: number | null;
  /** Resets soon with much of it unused: the quota about to be lost. */
  readonly expiring: boolean;
  /** A weekly or monthly window, not a short one that refills within hours. */
  readonly long: boolean;
  /** Caps one model only, not the whole subscription. */
  readonly scoped: boolean;
  /** How long one period lasts, for reading the pace; null when the provider does not say. */
  readonly durationMs: number | null;
  /** Caps the whole account: not model-scoped and not Cursor's combined "Overall". */
  readonly accountWide: boolean;
  /** Fully used and still live. */
  readonly spent: boolean;
  /** What was used of how much, when the provider reports all three soundly; else null. */
  readonly amounts: { readonly used: number; readonly limit: number; readonly unit: string } | null;
}

export interface SubscriptionRenewal {
  readonly at: number;
  /** Worked out from the day the person set, which wins, or reported by the provider. */
  readonly source: "provider" | "set";
  /** The day of the month the person set; a short month shows an earlier date, the day is kept. */
  readonly day?: number;
  /** Who reported it, for "reported by Cursor". */
  readonly vendor?: string;
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
  /** The key the ledger, prices and history use; null when the account has no identity. */
  readonly accountKey: string | null;
  /**
   * The key the renewal day is saved under: the account key, else the
   * subscription the provider names (Copilot's login and plan). Null when the
   * reading has neither, and then no day can be set.
   */
  readonly renewalKey: string | null;
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
  /**
   * The provider stops ordinary turns, a spend control was reached, or an
   * account-wide window is spent and the provider does not say it still runs.
   */
  readonly atLimit: boolean;
  /** What the reading says about a window the provider does not have; null when no rule covers it. */
  readonly note: Pick<SubscriptionWindowRule, "id" | "note" | "source" | "readOn"> | null;
}

/** An enabled instance that has no reading, drawn after the rows that have one. */
export interface NoReadingRow {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly name: string;
  readonly plan: string | null;
  readonly email: string | null;
  readonly machine: string;
  readonly offline: boolean;
  readonly message: string;
  /** False when billed by API key: the vendor's plan page has nothing for it. */
  readonly subscription: boolean;
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

const DAY_MS = 24 * 60 * 60_000;

/**
 * Amounts only when all three are there, both numbers finite and zero or
 * more, and the unit 1 to 24 characters once trimmed. Anything else is shown
 * as no amounts; the percent stands either way.
 */
export function windowAmounts(
  window: Pick<LimitAccount["limits"]["windows"][number], "used" | "limit" | "unit">,
): SubscriptionWindow["amounts"] {
  const { used, limit } = window;
  const unit = typeof window.unit === "string" ? window.unit.trim() : "";
  const sound = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!sound(used) || !sound(limit) || unit.length < 1 || unit.length > 24) return null;
  return { used, limit, unit };
}

/** Cursor's combined percentage of its two pools, not a quota of its own. */
const isCursorOverall = (account: LimitAccount, windowId: string) =>
  String(account.driver) === "cursor" && windowId === "totalPercentUsed";

function atLimitOf(limits: LimitAccount["limits"], windows: readonly SubscriptionWindow[]) {
  if (limits.ordinaryUsageAllowed === false || limits.spendControlReached === true) return true;
  return (
    limits.ordinaryUsageAllowed !== true &&
    windows.some((window) => window.accountWide && window.spent)
  );
}

function windowsOf(account: LimitAccount, now: number): SubscriptionWindow[] {
  const expiring = expiringQuota({ usageLimits: account.limits } as ServerProvider, "", now);
  return account.limits.windows
    .filter((window) => isLiveWindow(window, now))
    .map((window) => ({
      id: window.id,
      kind: window.kind,
      title: windowTitle(window),
      leftPercent: remainingPercent(window),
      resetsAt: parseTime(window.resetsAt),
      expiring: expiring !== null && windowName(window) === expiring.window,
      long:
        window.kind === "weekly" ||
        window.kind === "monthly" ||
        (window.kind !== "session" && (window.windowDurationMins ?? 0) > 6 * 60),
      scoped: windowModelScope(window) !== null,
      accountWide: windowModelScope(window) === null && !isCursorOverall(account, window.id),
      spent: window.usedPercent >= 100,
      amounts: windowAmounts(window),
      durationMs:
        window.windowDurationMins !== undefined && window.windowDurationMins > 0
          ? window.windowDurationMins * 60_000
          : window.kind === "weekly"
            ? 7 * DAY_MS
            : window.kind === "monthly"
              ? 30 * DAY_MS
              : null,
    }))
    .toSorted((left, right) => lengthOf(left) - lengthOf(right));
}

/** Shortest first; a window of unknown length after the ones whose length is known. */
const lengthOf = (window: Pick<SubscriptionWindow, "kind" | "durationMs">) =>
  window.durationMs ?? (window.kind === "session" ? 5 * 60 * 60_000 : Number.POSITIVE_INFINITY);

const VENDORS: Readonly<Record<string, string>> = {
  claudeAgent: "Anthropic",
  codex: "OpenAI",
  cursor: "Cursor",
  grok: "xAI",
  opencode: "OpenCode",
};

/** The account key, else `<driver>:subscription:<subscriptionKey>`; null with neither. */
export function renewalKeyOf(
  driver: LimitAccount["driver"],
  accountKey: string | null,
  limits: Pick<LimitAccount["limits"], "subscriptionKey">,
): string | null {
  if (accountKey !== null) return accountKey;
  return limits.subscriptionKey ? `${driver}:subscription:${limits.subscriptionKey}` : null;
}

function noteProvider(account: LimitAccount): SubscriptionNoteProvider | null {
  const driver = String(account.driver);
  if (driver === "cursor" || driver === "grok" || driver === "codex") return driver;
  if (account.limits.subscriptionKey?.startsWith("copilot:")) return "copilot";
  return providerUsageLink({ driver, label: account.displayName })?.kind === "copilot"
    ? "copilot"
    : null;
}

function noteOf(account: LimitAccount, windows: readonly SubscriptionWindow[], reportedRenewal: boolean) {
  const rule = subscriptionWindowNote({
    provider: noteProvider(account),
    plans: [account.limits.planLabel, account.plan],
    windows: windows.filter((window) => window.accountWide),
    hasReportedRenewal: reportedRenewal,
  });
  return rule === null
    ? null
    : { id: rule.id, note: rule.note, source: rule.source, readOn: rule.readOn };
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
    const windows = windowsOf(account, now);
    const reported = parseTime(account.limits.renewsAt);
    const renewalKey = renewalKeyOf(account.driver, accountKey, account.limits);
    const setDay = renewalKey === null ? undefined : renewalDays[renewalKey];
    const credits = account.limits.resetCredits;
    return {
      key: account.key,
      accountKey,
      renewalKey,
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
      windows,
      // The day the person set wins; a reported date shows only without one, and only ahead.
      renewal:
        setDay !== undefined
          ? { at: nextRenewalOn(setDay, now), source: "set", day: setDay }
          : reported !== null && reported > now
            ? {
                at: reported,
                source: "provider",
                vendor: VENDORS[String(account.driver)] ?? account.displayName ?? String(account.driver),
              }
            : null,
      credits:
        credits && credits.availableCount > 0
          ? { count: credits.availableCount, nextExpiresAt: parseTime(credits.nextExpiresAt) }
          : null,
      lastLoss: lastLossOf(account, accountKey, periods),
      atLimit: atLimitOf(account.limits, windows),
      note: noteOf(account, windows, reported !== null && reported > now),
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

/** Rows for the accounts without a reading, in the order they were collected. */
export function noReadingRows(
  accounts: readonly UnreportedLimitAccount[],
  driverLabel: (driver: ServerProvider["driver"]) => string,
): NoReadingRow[] {
  return accounts.map((account) => {
    const name = account.displayName ?? driverLabel(account.driver);
    return {
      key: account.key,
      driver: account.driver,
      name,
      plan: account.plan?.trim() || null,
      email: account.email?.trim() || null,
      machine: account.environmentLabel,
      offline: account.offline,
      message: account.message,
      subscription: account.reason !== "apiBilling",
    };
  });
}

export interface SubscriptionsSummary {
  /** Rows with a reading: an instance without one may be a plan or billed per use. */
  readonly subscriptions: number;
  readonly atLimit: number;
  /** When the next reset that matters comes; null when none is known. */
  readonly nextResetAt: number | null;
  readonly withoutReading: number;
}

/**
 * The header line's numbers. The next reset is the soonest a spent window
 * frees a row at a limit (or, for one with no spent window, its soonest
 * reset); with no row at a limit, the soonest reset of any row. Only
 * account-wide windows count, and a reset at or before now never shows.
 */
export function subscriptionsSummary(
  rows: readonly SubscriptionRow[],
  withoutReading: number,
  now: number,
): SubscriptionsSummary {
  const soonest = (windows: readonly SubscriptionWindow[]) =>
    windows.reduce<number | null>(
      (best, window) =>
        window.accountWide && window.resetsAt !== null && window.resetsAt > now
          ? best === null
            ? window.resetsAt
            : Math.min(best, window.resetsAt)
          : best,
      null,
    );
  const min = (values: ReadonlyArray<number | null>) =>
    values.reduce<number | null>(
      (best, value) => (value === null ? best : best === null ? value : Math.min(best, value)),
      null,
    );
  const limited = rows.filter((row) => row.atLimit);
  const nextResetAt =
    limited.length > 0
      ? min(
          limited.map((row) => {
            const spent = soonest(row.windows.filter((window) => window.spent));
            return spent ?? soonest(row.windows);
          }),
        )
      : min(rows.map((row) => soonest(row.windows)));
  return { subscriptions: rows.length, atLimit: limited.length, nextResetAt, withoutReading };
}

/** "3 subscriptions · 1 at a limit · next reset in 2h 5m · 2 without a reading". */
export function subscriptionsSummaryText(summary: SubscriptionsSummary, now: number): string {
  const parts = [
    `${summary.subscriptions} ${summary.subscriptions === 1 ? "subscription" : "subscriptions"}`,
    `${summary.atLimit} at a limit`,
  ];
  if (summary.nextResetAt !== null && summary.nextResetAt > now) {
    parts.push(`next reset in ${formatDuration(summary.nextResetAt - now)}`);
  }
  if (summary.withoutReading > 0) parts.push(`${summary.withoutReading} without a reading`);
  return parts.join(" · ");
}
