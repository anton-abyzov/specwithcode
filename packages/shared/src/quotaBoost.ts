/**
 * "Use it until it resets": a time-boxed override that starts new worker
 * threads on one subscription's model while its quota is about to reset
 * unused. Plain data over the `quotaBoosts` setting; nothing here reads a
 * clock or a provider, so a thread launch and the banner agree.
 *
 * It ends by itself: a boost past its `until` is simply not current, so no
 * timer has to fire and a restart or a sleep cannot leave it stuck.
 *
 * @module quotaBoost
 */
import type { QuotaBoost } from "@specweave-studio/contracts";

/** The `quotaBoosts` setting: boosts by account key, null for one that ended. */
export type SavedQuotaBoosts = Readonly<Record<string, QuotaBoost | null>>;

import { QUOTA_ALERT_PERIOD_DRIFT_MS } from "./quotaAlerts.ts";

/** Under this much left, the subscription is spent and the boost has done its job. */
export const QUOTA_BOOST_MIN_LEFT_PERCENT = 5;

export type QuotaBoostEnd = "reset" | "earlyReset" | "spent";

const covers = (boost: Pick<QuotaBoost, "projectIds">, projectId: string): boolean =>
  boost.projectIds.length === 0 || boost.projectIds.includes(projectId);

/** The boosts still running at `nowMs`, the one ending first leading. */
export function liveQuotaBoosts(boosts: SavedQuotaBoosts | undefined, nowMs: number): QuotaBoost[] {
  return Object.values(boosts ?? {})
    .filter((boost): boost is QuotaBoost => boost !== null && boost.until > nowMs)
    .toSorted(
      (left, right) => left.until - right.until || left.accountKey.localeCompare(right.accountKey),
    );
}

/**
 * The model a new worker thread of `projectId` starts on while a boost
 * covers it, else null. With several, the quota that is lost first wins.
 * The caller still checks the provider is enabled, as for any saved model.
 */
export function currentQuotaBoost(
  boosts: SavedQuotaBoosts | undefined,
  projectId: string,
  nowMs: number,
): { readonly instanceId: QuotaBoost["instanceId"]; readonly model: string } | null {
  const boost = liveQuotaBoosts(boosts, nowMs).find((candidate) => covers(candidate, projectId));
  return boost === undefined ? null : { instanceId: boost.instanceId, model: boost.model };
}

/**
 * Why a boost is over at `nowMs`, or null while it runs. `windows` are the
 * account's windows as read now; undefined when the account is not readable,
 * which ends nothing: an unread account is not a spent one.
 *
 * `until` is the window's own reset as read when the boost started, so an
 * early reset shows as that reset moving well past it: the quota the boost
 * was started for is gone and a fresh period began.
 */
export function quotaBoostEnd(
  boost: Pick<QuotaBoost, "until" | "windowId" | "resetsAtStart">,
  windows:
    | ReadonlyArray<{
        readonly id: string;
        readonly leftPercent: number;
        readonly resetsAt: number | null;
      }>
    | undefined,
  nowMs: number,
): QuotaBoostEnd | null {
  if (boost.until <= nowMs) return "reset";
  const window =
    boost.windowId === undefined
      ? undefined
      : windows?.find((candidate) => candidate.id === boost.windowId);
  if (window === undefined) return null;
  // The reset the window was heading for when the boost started.
  const expected = boost.resetsAtStart ?? boost.until;
  if (window.resetsAt !== null && window.resetsAt - expected > QUOTA_ALERT_PERIOD_DRIFT_MS) {
    return "earlyReset";
  }
  return window.leftPercent < QUOTA_BOOST_MIN_LEFT_PERCENT ? "spent" : null;
}
