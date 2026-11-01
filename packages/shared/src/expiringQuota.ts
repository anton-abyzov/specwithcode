/**
 * Quota that is about to reset unused. A subscription window that resets soon
 * with much of it left is capacity the person already paid for and is about
 * to lose; a worker that can run there spends it instead of the model that
 * keeps its quota. Pure: reads only the provider's last usage snapshot.
 *
 * @module expiringQuota
 */
import type { ServerProvider, ServerProviderUsageWindow } from "@specweave-studio/contracts";

import {
  effectiveLeftPercent,
  isLiveWindow,
  windowAppliesToModel,
  windowName,
} from "./usageWindows.ts";

/** At least this share of a window must be left for it to count as going to waste. */
export const EXPIRING_QUOTA_MIN_LEFT_PERCENT = 40;
/** A window of up to this length (the 5-hour one) counts within the next 90 minutes. */
const SHORT_WINDOW_MAX_MINUTES = 6 * 60;
const SHORT_WINDOW_HORIZON_MINUTES = 90;
/** A longer window (the weekly) counts within its last day. */
const LONG_WINDOW_HORIZON_MINUTES = 24 * 60;

export interface ExpiringQuota {
  /** The window that resets soon, named for a sentence (`5-hour`, `weekly`). */
  readonly window: string;
  /** What is left of it, 0..100. */
  readonly leftPercent: number;
  /** Whole minutes until it resets, at least 1. */
  readonly resetsInMinutes: number;
}

const horizonMinutes = (window: ServerProviderUsageWindow): number | null => {
  const duration = window.windowDurationMins;
  if (window.kind === "session") return SHORT_WINDOW_HORIZON_MINUTES;
  if (window.kind === "weekly") return LONG_WINDOW_HORIZON_MINUTES;
  if (duration === undefined || duration <= 0) return null;
  return duration <= SHORT_WINDOW_MAX_MINUTES
    ? SHORT_WINDOW_HORIZON_MINUTES
    : LONG_WINDOW_HORIZON_MINUTES;
};

/**
 * The window of `provider` that resets soon with much of it unused, for turns
 * on `model`, or null. Every other window that applies must leave as much
 * room, so a weekly about to reset is not offered while the 5-hour one is
 * nearly spent. Of several, the one that resets first is named.
 */
export function expiringQuota(
  provider: ServerProvider,
  model: string,
  nowMs: number,
): ExpiringQuota | null {
  const windows = provider.usageLimits?.windows ?? [];
  const overall = effectiveLeftPercent(windows, nowMs, model);
  if (overall === null || overall < EXPIRING_QUOTA_MIN_LEFT_PERCENT) return null;
  let best: ExpiringQuota | null = null;
  for (const window of windows) {
    if (window.resetsAt === undefined) continue;
    if (!isLiveWindow(window, nowMs) || !windowAppliesToModel(window, model)) continue;
    const horizon = horizonMinutes(window);
    if (horizon === null) continue;
    const resetsInMinutes = Math.max(1, Math.ceil((Date.parse(window.resetsAt) - nowMs) / 60_000));
    if (resetsInMinutes > horizon) continue;
    const leftPercent = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
    if (leftPercent < EXPIRING_QUOTA_MIN_LEFT_PERCENT) continue;
    if (best === null || resetsInMinutes < best.resetsInMinutes)
      best = { window: windowName(window), leftPercent, resetsInMinutes };
  }
  return best;
}

/** "70% of its 5-hour quota resets in 40 min", for a routing reason. */
export function describeExpiringQuota(quota: ExpiringQuota): string {
  const when =
    quota.resetsInMinutes < 120
      ? `${quota.resetsInMinutes} min`
      : `${Math.round(quota.resetsInMinutes / 60)} h`;
  return `${quota.leftPercent}% of its ${quota.window} quota resets in ${when}`;
}
