/**
 * Use-it-or-lose-it alerts: quota that is about to be lost, as plain data.
 * Four things raise one: a window that resets soon with much of it unused, a
 * banked reset about to expire, a subscription renewing with quota unused,
 * and a window the provider reset early. Each alert names one period, so it
 * shows, notifies and is dismissed once per period.
 *
 * @module quotaAlerts
 */
import { EXPIRING_QUOTA_MIN_LEFT_PERCENT } from "./expiringQuota.ts";

const HOUR = 60 * 60_000;
/** A banked reset or a renewal counts within its last day. */
export const QUOTA_ALERT_HORIZON_MS = 24 * HOUR;
/** An early reset is news for this long. */
export const EARLY_RESET_NOTICE_MS = 6 * HOUR;

export type QuotaAlertKind = "window" | "bankedReset" | "renewal" | "earlyReset";

export interface QuotaAlertWindow {
  readonly id: string;
  /** "Weekly", "5-hour": how the window reads in a sentence. */
  readonly title: string;
  readonly leftPercent: number;
  readonly resetsAt: number | null;
  /** Resets soon with much of it unused, by the same rule routing uses. */
  readonly expiring: boolean;
}

/** One subscription as the alert rule reads it. */
export interface QuotaAlertAccount {
  readonly accountKey: string | null;
  readonly driver: string;
  readonly machines: readonly string[];
  readonly offline: boolean;
  readonly windows: readonly QuotaAlertWindow[];
  readonly renewal: { readonly at: number } | null;
  readonly credits: { readonly count: number; readonly nextExpiresAt: number | null } | null;
}

/** A period the provider ended before its announced time, from the reset ledger. */
export interface QuotaAlertEarlyReset {
  readonly accountKey: string;
  readonly driver: string;
  readonly windowId: string;
  readonly windowTitle: string;
  readonly endedAt: number;
}

export interface QuotaAlert {
  /** The account and what about it; the same across periods, so a dismissal replaces the last. */
  readonly key: string;
  /** The period this alert is for: a reset, expiry or renewal time, or when the early reset happened. */
  readonly periodEnd: number;
  readonly kind: QuotaAlertKind;
  readonly accountKey: string;
  readonly driver: string;
  readonly machines: readonly string[];
  /** The window's title; absent for a banked reset or a renewal. */
  readonly windowTitle?: string;
  /** What is left to use, 0..100; absent for a banked reset and an early reset. */
  readonly leftPercent?: number;
  /** Banked resets about to expire. */
  readonly count?: number;
}

/** `key` at `periodEnd`: one per period, for a notification tag. */
export const quotaAlertId = (alert: Pick<QuotaAlert, "key" | "periodEnd">): string =>
  `${alert.key}@${alert.periodEnd}`;

/**
 * Every alert that holds at `now`, the soonest loss first. An offline
 * machine's reading is stale, so it raises none; an account with no identity
 * cannot be dismissed per period, so it raises none either.
 */
export function quotaAlerts(
  accounts: readonly QuotaAlertAccount[],
  earlyResets: readonly QuotaAlertEarlyReset[],
  now: number,
): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  const machinesOf = new Map<string, readonly string[]>();
  for (const account of accounts) {
    const { accountKey } = account;
    if (accountKey === null || account.offline) continue;
    machinesOf.set(accountKey, account.machines);
    const base = { accountKey, driver: account.driver, machines: account.machines };
    for (const window of account.windows) {
      if (!window.expiring || window.resetsAt === null || window.resetsAt <= now) continue;
      alerts.push({
        ...base,
        key: `${accountKey}|window:${window.id}`,
        periodEnd: window.resetsAt,
        kind: "window",
        windowTitle: window.title,
        leftPercent: window.leftPercent,
      });
    }
    const expiry = account.credits?.nextExpiresAt ?? null;
    if (account.credits && account.credits.count > 0 && expiry !== null) {
      if (expiry > now && expiry - now <= QUOTA_ALERT_HORIZON_MS) {
        alerts.push({
          ...base,
          key: `${accountKey}|banked`,
          periodEnd: expiry,
          kind: "bankedReset",
          count: account.credits.count,
        });
      }
    }
    const renewsAt = account.renewal?.at ?? null;
    if (renewsAt !== null && renewsAt > now && renewsAt - now <= QUOTA_ALERT_HORIZON_MS) {
      // The longest window is the subscription's own; a short one refills by itself.
      const longest = account.windows
        .filter((window) => window.resetsAt !== null)
        .toSorted((left, right) => (right.resetsAt ?? 0) - (left.resetsAt ?? 0))[0];
      const alreadyNamed = longest !== undefined && longest.expiring;
      if (
        longest !== undefined &&
        !alreadyNamed &&
        longest.leftPercent >= EXPIRING_QUOTA_MIN_LEFT_PERCENT
      ) {
        alerts.push({
          ...base,
          key: `${accountKey}|renewal`,
          periodEnd: renewsAt,
          kind: "renewal",
          windowTitle: longest.title,
          leftPercent: longest.leftPercent,
        });
      }
    }
  }
  for (const reset of earlyResets) {
    if (reset.endedAt > now || now - reset.endedAt > EARLY_RESET_NOTICE_MS) continue;
    alerts.push({
      key: `${reset.accountKey}|early:${reset.windowId}`,
      periodEnd: reset.endedAt,
      kind: "earlyReset",
      accountKey: reset.accountKey,
      driver: reset.driver,
      machines: machinesOf.get(reset.accountKey) ?? [],
      windowTitle: reset.windowTitle,
    });
  }
  // What is about to be lost first; an early reset is news, not a loss, so it follows.
  const rank = (alert: QuotaAlert) => (alert.kind === "earlyReset" ? Number.MAX_SAFE_INTEGER : alert.periodEnd);
  return alerts.toSorted((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key));
}

/**
 * The alerts not dismissed for their period. `dismissed` holds, per alert
 * key, the period end that was dismissed; a later period shows again.
 */
export function visibleQuotaAlerts(
  alerts: readonly QuotaAlert[],
  dismissed: Readonly<Record<string, number>>,
): QuotaAlert[] {
  return alerts.filter((alert) => (dismissed[alert.key] ?? 0) < alert.periodEnd);
}

const duration = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
};

/**
 * The alert in one sentence, with the subscription already named:
 * "Codex Pro on m4: 62% of its weekly quota resets in 9 h".
 */
export function describeQuotaAlert(alert: QuotaAlert, label: string, now: number): string {
  const where = alert.machines.length === 0 ? label : `${label} on ${alert.machines.join(", ")}`;
  const window = (alert.windowTitle ?? "").toLowerCase();
  const left = Math.round(alert.leftPercent ?? 0);
  const inTime = duration(alert.periodEnd - now);
  switch (alert.kind) {
    case "window":
      return `${where}: ${left}% of its ${window} quota resets in ${inTime}`;
    case "bankedReset":
      return `${where}: ${alert.count === 1 ? "a banked reset expires" : `${alert.count} banked resets, the next expires`} in ${inTime}`;
    case "renewal":
      return `${where}: renews in ${inTime} with ${left}% of its ${window} quota unused`;
    case "earlyReset":
      return `${where} reset early: ${window} back to 100%`;
  }
}
