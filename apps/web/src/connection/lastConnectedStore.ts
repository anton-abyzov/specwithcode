import type { EnvironmentId } from "@specweave-studio/contracts";
import type { Persistence } from "@specweave-studio/client-runtime/platform";
import * as Effect from "effect/Effect";

const KEY_PREFIX = "specwithcode:last-connected:";

/**
 * When this browser or desktop window last had a session with each machine
 * (1517). One small key per machine; a missing, unreadable or blocked store
 * reads as never connected and a failed write is dropped.
 */
export function makeBrowserLastConnectedStore(
  browser: Pick<Window, "localStorage"> | undefined = globalThis.window,
): Persistence.LastConnectedRecords {
  return {
    read: (environmentId: EnvironmentId) =>
      Effect.sync(() => {
        try {
          const raw = browser?.localStorage.getItem(`${KEY_PREFIX}${environmentId}`) ?? null;
          const at = raw === null ? Number.NaN : Number(raw);
          return Number.isFinite(at) && at > 0 ? at : null;
        } catch {
          return null;
        }
      }),
    write: (environmentId: EnvironmentId, at: number) =>
      Effect.sync(() => {
        try {
          browser?.localStorage.setItem(`${KEY_PREFIX}${environmentId}`, String(Math.round(at)));
        } catch {
          // Storage full or blocked: the next launch starts with no record.
        }
      }),
  };
}
