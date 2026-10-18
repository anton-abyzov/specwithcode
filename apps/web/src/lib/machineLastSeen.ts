/**
 * When this device last saw each machine connected, so an unreachable machine
 * can say "last seen 2h ago". The connection supervisor only knows the current
 * attempt, so the time is recorded here from the phases the UI already reads,
 * and kept in local storage so it survives a reload (a per-device note, never
 * shared state).
 *
 * @module machineLastSeen
 */
import type { EnvironmentConnectionPhase } from "@specweave-studio/client-runtime/connection";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "specwithcode:machine-last-seen";
/** A connected machine's time is refreshed at most this often, to keep writes rare. */
const REFRESH_MS = 60_000;

interface MachinePhase {
  readonly environmentId: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
}

function load(): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
}

let seen: Map<string, number> | null = null;
const previousPhase = new Map<string, EnvironmentConnectionPhase>();
const listeners = new Set<() => void>();
let version = 0;

function store(): Map<string, number> {
  seen ??= load();
  return seen;
}

function persist(next: Map<string, number>) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Storage can be full or blocked; the time still holds for this session.
  }
}

/**
 * Notes the machines seen connected now, and the moment one stops being
 * connected, which is the last time it was seen.
 */
export function recordMachinePhases(machines: ReadonlyArray<MachinePhase>, now = Date.now()) {
  const current = store();
  let changed = false;
  for (const { environmentId, connection } of machines) {
    const before = previousPhase.get(environmentId);
    previousPhase.set(environmentId, connection.phase);
    const connected = connection.phase === "connected";
    const justLeft = !connected && before === "connected";
    const stale = (current.get(environmentId) ?? 0) <= now - REFRESH_MS;
    if ((connected && (before !== "connected" || stale)) || justLeft) {
      current.set(environmentId, now);
      changed = true;
    }
  }
  if (!changed) return;
  persist(current);
  version += 1;
  for (const listener of listeners) listener();
}

export function machineLastSeenAt(environmentId: string): number | null {
  return store().get(environmentId) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when a recorded time changes; read times with machineLastSeenAt. */
export function useMachineLastSeenVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/** Test seam: forget everything recorded in this module. */
export function resetMachineLastSeenForTests() {
  seen = new Map();
  previousPhase.clear();
  version = 0;
}
