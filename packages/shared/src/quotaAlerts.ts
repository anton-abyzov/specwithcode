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
/**
 * Two reads of one period may report its end a little apart (a provider
 * rounds or recomputes the reset time), so ends this close are one period.
 * The shortest window is hours long, so the next period is never this near.
 */
export const QUOTA_ALERT_PERIOD_DRIFT_MS = 30 * 60_000;
/** A window ends with a renewal when it resets this close to it; a day set by hand is a date, not an hour. */
export const RENEWAL_WINDOW_APART_MS = 12 * HOUR;
/** A weekly or monthly window is watched over its last two days. */
export const QUOTA_ALERT_LEAD_MS = 48 * HOUR;
/** Under this long to the reset there is nothing left to do about it, so nothing is said. */
export const QUOTA_ALERT_MIN_TIME_TO_ACT_MS = HOUR;
/** A promised reset is expected for this long after its post. */
export const EXPECTED_RESET_WINDOW_MS = 24 * HOUR;
/** An early reset is news for this long. */
export const EARLY_RESET_NOTICE_MS = 6 * HOUR;

export type QuotaAlertKind =
  | "window"
  | "bankedReset"
  | "renewal"
  | "earlyReset"
  | "expectedReset";

export interface QuotaAlertWindow {
  readonly id: string;
  /** "Weekly", "5-hour": how the window reads in a sentence. */
  readonly title: string;
  readonly leftPercent: number;
  readonly resetsAt: number | null;
  /** Caps one model only (Claude's "Weekly · Fable"), so it is not the subscription's quota. */
  readonly scoped?: boolean;
  /** How long one period of it lasts; null when unknown, and then the pace cannot be read. */
  readonly durationMs?: number | null;
  /** A weekly or monthly window. A short one refills many times before a renewal, so it never ends with one. */
  readonly long: boolean;
}

/**
 * The share of a window that will still be unused at its reset if the person
 * keeps the pace of the period so far: what is left now, less what that pace
 * uses in the time that remains. With no known length the pace is unknown and
 * what is left now stands. The period is taken to have begun one length before
 * its reset; after an early reset on an unmoved anchor that overstates the time
 * elapsed and so understates the pace, which errs toward a warning.
 */
export function projectedUnusedPercent(
  window: Pick<QuotaAlertWindow, "leftPercent" | "resetsAt" | "durationMs">,
  now: number,
): number {
  const left = Math.max(0, Math.min(100, window.leftPercent));
  const duration = window.durationMs ?? null;
  if (window.resetsAt === null || duration === null || duration <= 0) return left;
  const remaining = Math.max(0, window.resetsAt - now);
  const elapsed = duration - remaining;
  if (elapsed <= 0) return left;
  return Math.max(0, left - ((100 - left) / elapsed) * remaining);
}

/**
 * Whether a window is worth a warning: a weekly or monthly one in its last two
 * days, with at least an hour to act, that the pace so far leaves at least 40%
 * unused. A short window never is: it refills within hours, and by the time
 * anyone reads the warning it has reset.
 */
export function quotaGoingUnused(window: QuotaAlertWindow, now: number): boolean {
  if (!window.long || window.scoped === true || window.resetsAt === null) return false;
  const remaining = window.resetsAt - now;
  if (remaining < QUOTA_ALERT_MIN_TIME_TO_ACT_MS || remaining > QUOTA_ALERT_LEAD_MS) return false;
  return projectedUnusedPercent(window, now) >= EXPIRING_QUOTA_MIN_LEFT_PERCENT;
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

/** A reset a named source promised and that has not happened yet, from the announcement feed. */
export interface QuotaAlertExpectedReset {
  readonly id: string;
  /** The provider driver whose accounts it concerns. */
  readonly driver: string;
  readonly publishedAt: number;
  readonly sourceUrl: string;
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
  /** The window whose quota is about to go; absent for a banked reset. */
  readonly windowId?: string;
  /** When that window resets; the period end of a window or renewal alert. */
  readonly windowResetsAt?: number;
  /** When the plan renews, for a renewal alert's sentence. */
  readonly renewsAt?: number;
  /** The post behind an expected reset. */
  readonly sourceUrl?: string;
  /** The window's title; absent for a banked reset. */
  readonly windowTitle?: string;
  /** What is left to use, 0..100; absent for a banked reset and an early reset. */
  readonly leftPercent?: number;
  /** Banked resets about to expire. */
  readonly count?: number;
}

/** `key` at `periodEnd`, for a list key. Not a period identity: see `coversQuotaAlertPeriod`. */
export const quotaAlertId = (alert: Pick<QuotaAlert, "key" | "periodEnd">): string =>
  `${alert.key}@${alert.periodEnd}`;

/**
 * Whether a period end recorded earlier (`recorded`, a dismissal or a sent
 * notification) is the period ending at `periodEnd`, allowing for drift
 * between reads. A later period is not covered.
 */
export const coversQuotaAlertPeriod = (recorded: number | undefined, periodEnd: number): boolean =>
  recorded !== undefined && periodEnd <= recorded + QUOTA_ALERT_PERIOD_DRIFT_MS;

/**
 * Every alert that holds at `now`, the soonest loss first. An offline
 * machine's reading is stale, so it raises none; an account with no identity
 * cannot be dismissed per period, so it raises none either.
 */
export function quotaAlerts(
  accounts: readonly QuotaAlertAccount[],
  earlyResets: readonly QuotaAlertEarlyReset[],
  now: number,
  expectedResets: readonly QuotaAlertExpectedReset[] = [],
): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  const machinesOf = new Map<string, readonly string[]>();
  for (const account of accounts) {
    const { accountKey } = account;
    if (accountKey === null || account.offline) continue;
    machinesOf.set(accountKey, account.machines);
    const base = { accountKey, driver: account.driver, machines: account.machines };
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
    // A reset promised today replaces whatever is left of the subscription's own quota,
    // well before the window's reset, so it speaks first. "Expected", never "announced":
    // it is a promise, and it ends when the window starts over or a day after the post.
    const promise = expectedResets
      .filter(
        (expected) =>
          expected.driver === account.driver &&
          expected.publishedAt <= now &&
          now - expected.publishedAt < EXPECTED_RESET_WINDOW_MS,
      )
      .toSorted((left, right) => right.publishedAt - left.publishedAt)[0];
    const replaced =
      promise === undefined
        ? undefined
        : account.windows
            .filter(
              (window) =>
                window.long &&
                window.scoped !== true &&
                window.resetsAt !== null &&
                // A window that began after the post is the reset having arrived.
                (window.durationMs == null ||
                  window.resetsAt - window.durationMs <= promise.publishedAt) &&
                window.resetsAt - now >= QUOTA_ALERT_MIN_TIME_TO_ACT_MS &&
                window.leftPercent >= EXPIRING_QUOTA_MIN_LEFT_PERCENT,
            )
            .toSorted((left, right) => (left.resetsAt ?? 0) - (right.resetsAt ?? 0))[0];
    if (promise !== undefined && replaced !== undefined && replaced.resetsAt !== null) {
      alerts.push({
        ...base,
        key: `${accountKey}|expected`,
        periodEnd: promise.publishedAt + EXPECTED_RESET_WINDOW_MS,
        kind: "expectedReset",
        windowId: replaced.id,
        windowResetsAt: replaced.resetsAt,
        windowTitle: replaced.title,
        leftPercent: replaced.leftPercent,
        sourceUrl: promise.sourceUrl,
      });
      continue;
    }
    // One line per subscription: the window that resets first speaks for it.
    const going = account.windows
      .filter((window) => quotaGoingUnused(window, now))
      .toSorted((left, right) => (left.resetsAt ?? 0) - (right.resetsAt ?? 0))[0];
    if (going !== undefined && going.resetsAt !== null) {
      // When the plan renews within a day and this is the window that ends with it (the
      // long window whose reset is nearest the renewal), the line says so. It is still
      // the same window and period, so a dismissal or a notification holds either way.
      const renewsAt = account.renewal?.at ?? null;
      const endsWithRenewal =
        renewsAt !== null &&
        renewsAt - now >= QUOTA_ALERT_MIN_TIME_TO_ACT_MS &&
        renewsAt - now <= QUOTA_ALERT_HORIZON_MS &&
        going.leftPercent >= EXPIRING_QUOTA_MIN_LEFT_PERCENT &&
        account.windows
          .flatMap((window) =>
            window.resetsAt === null || !window.long || window.scoped === true
              ? []
              : [{ window, apart: Math.abs(window.resetsAt - renewsAt) }],
          )
          .filter((entry) => entry.apart <= RENEWAL_WINDOW_APART_MS)
          .toSorted((left, right) => left.apart - right.apart)[0]?.window === going;
      alerts.push({
        ...base,
        key: `${accountKey}|window:${going.id}`,
        periodEnd: going.resetsAt,
        kind: endsWithRenewal ? "renewal" : "window",
        windowId: going.id,
        windowResetsAt: going.resetsAt,
        windowTitle: going.title,
        leftPercent: going.leftPercent,
        ...(endsWithRenewal && renewsAt !== null ? { renewsAt } : {}),
      });
    }
  }
  for (const reset of earlyResets) {
    if (reset.endedAt > now || now - reset.endedAt > EARLY_RESET_NOTICE_MS) continue;
    // Signed out since, or only on a machine that is offline: no longer this person's news.
    const machines = machinesOf.get(reset.accountKey);
    if (machines === undefined) continue;
    alerts.push({
      key: `${reset.accountKey}|early:${reset.windowId}`,
      periodEnd: reset.endedAt,
      kind: "earlyReset",
      accountKey: reset.accountKey,
      driver: reset.driver,
      machines,
      windowTitle: reset.windowTitle,
    });
  }
  // What is about to be lost first; an early reset is news, not a loss, so it follows.
  const rank = (alert: QuotaAlert) => (alert.kind === "earlyReset" ? Number.MAX_SAFE_INTEGER : alert.periodEnd);
  return alerts.toSorted((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key));
}

/**
 * Recorded period ends that a re-read has moved forward within the same
 * period: `{ key: newEnd }` to save, so the tolerance holds between reads and
 * small drifts cannot add up past it.
 */
export function driftedQuotaAlertPeriods(
  alerts: readonly QuotaAlert[],
  recorded: Readonly<Record<string, number>>,
): Record<string, number> {
  const moved: Record<string, number> = {};
  for (const alert of alerts) {
    const end = recorded[alert.key];
    if (end !== undefined && alert.periodEnd > end && coversQuotaAlertPeriod(end, alert.periodEnd)) {
      moved[alert.key] = alert.periodEnd;
    }
  }
  return moved;
}

/**
 * The alerts not dismissed for their period. `dismissed` holds, per alert
 * key, the period end that was dismissed; a later period shows again, and a
 * re-read that moves the same period's end a little does not.
 */
export function visibleQuotaAlerts(
  alerts: readonly QuotaAlert[],
  dismissed: Readonly<Record<string, number>>,
): QuotaAlert[] {
  return alerts.filter((alert) => !coversQuotaAlertPeriod(dismissed[alert.key], alert.periodEnd));
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
      return `${where}: renews in ${duration((alert.renewsAt ?? alert.periodEnd) - now)} with ${left}% of its ${window} quota unused`;
    case "earlyReset":
      return `${where} reset early: ${window} back to 100%`;
    case "expectedReset":
      return `${label} reset expected today: ${left}% left${
        alert.machines.length === 0 ? "" : ` on ${alert.machines.join(", ")}`
      } will be replaced`;
  }
}
