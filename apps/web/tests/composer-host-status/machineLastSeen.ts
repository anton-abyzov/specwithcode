/* When this device last saw the viewed machine: the harness sets it. */
export * from "../../src/lib/machineLastSeen";

declare global {
  interface Window {
    __lastSyncedAt?: number | null;
  }
}

export function machineLastSeenAt(_environmentId: string): number | null {
  return window.__lastSyncedAt ?? null;
}
