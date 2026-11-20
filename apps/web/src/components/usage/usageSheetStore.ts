import { create } from "zustand";

import type { UsageMetric } from "./usageShortcuts";

export interface UsageSheetRequest {
  readonly metric: UsageMetric;
  readonly key: number;
}

export const useUsageSheetRequest = create<{ request: UsageSheetRequest | null }>(() => ({
  request: null,
}));

/**
 * Opens Usage as a sheet over the whole app, the way Settings opens, and leaves
 * the page underneath in place. `UsageSheetHost` renders it.
 */
export function openUsageSheet({ metric = "limits" }: { readonly metric?: UsageMetric } = {}) {
  useUsageSheetRequest.setState({ request: { metric, key: Date.now() } });
}

/** Which Limits tab Usage opens on; the Limits section reads it when it mounts. */
export const LIMITS_VIEW_KEY = "specwithcode:usage-limits-view";

/** Usage over the app, on Limits > Subscriptions: the full effectiveness view. */
export function openSubscriptionsSheet() {
  try {
    localStorage.setItem(LIMITS_VIEW_KEY, "subscriptions");
  } catch {
    // Usage still opens; the Subscriptions tab is one click away.
  }
  openUsageSheet({ metric: "limits" });
}

export function closeUsageSheet() {
  useUsageSheetRequest.setState({ request: null });
}
