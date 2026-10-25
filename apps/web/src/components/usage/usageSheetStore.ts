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

export function closeUsageSheet() {
  useUsageSheetRequest.setState({ request: null });
}
