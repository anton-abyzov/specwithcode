/**
 * The last report each machine sent, kept on this device so a machine that is
 * out of reach still shows what it last reported instead of vanishing.
 */
import { UsageMachineReport } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";

const STORAGE_KEY = "studio:usage-machine-reports:v1";
/** Limits are read over two weeks at most, so an older report explains nothing shown. */
export const REPORT_CACHE_MS = 14 * 24 * 60 * 60 * 1000;

const CacheSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ savedAt: Schema.Number, report: UsageMachineReport }),
);
export type MachineReportCache = typeof CacheSchema.Type;

export function readMachineReportCache(now: number): MachineReportCache {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, CacheSchema) ?? {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, entry]) => now - entry.savedAt <= REPORT_CACHE_MS),
    );
  } catch {
    return {};
  }
}

/** Keeps `reports` over what is stored; a full store only costs the offline view. */
export function saveMachineReports(
  reports: ReadonlyMap<string, UsageMachineReport>,
  now: number,
): void {
  if (reports.size === 0) return;
  try {
    const next: Record<string, MachineReportCache[string]> = { ...readMachineReportCache(now) };
    for (const [machineId, report] of reports) next[machineId] = { savedAt: now, report };
    setLocalStorageItem(STORAGE_KEY, next, CacheSchema);
  } catch {
    // Nothing to do: the next read asks the machines again.
  }
}
