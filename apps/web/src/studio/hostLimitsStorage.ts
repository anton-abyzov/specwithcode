/**
 * The last reading each host showed while online, kept in this viewer's
 * browser so an offline host still shows what it last reported and when.
 * Storage can be missing or blocked; then offline hosts just show no rows.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";

import type { SavedHostReading } from "./hostLimitsModel";

const KEY = "studio.host-limit-readings.v1";
/** Readings older than this say nothing useful about a window. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function loadSavedHostReadings(now: number): ReadonlyMap<EnvironmentId, SavedHostReading> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const readings = new Map<EnvironmentId, SavedHostReading>();
    for (const [id, value] of Object.entries(parsed as Record<string, SavedHostReading>)) {
      if (
        typeof value?.label === "string" &&
        typeof value.savedAt === "number" &&
        Array.isArray(value.providers) &&
        now - value.savedAt < MAX_AGE_MS
      ) {
        readings.set(id as EnvironmentId, value);
      }
    }
    return readings;
  } catch {
    return new Map();
  }
}

export function saveHostReadings(
  readings: ReadonlyMap<EnvironmentId, SavedHostReading>,
  now: number,
): void {
  if (readings.size === 0) return;
  try {
    const merged = new Map(loadSavedHostReadings(now));
    for (const [id, reading] of readings) merged.set(id, reading);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(merged)));
  } catch {
    // Private windows and blocked storage: offline hosts show no saved rows.
  }
}
