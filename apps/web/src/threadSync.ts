import type { EnvironmentThreadStatus } from "@specweave-studio/client-runtime/state/threads";

/**
 * - `loading`: no messages are visible yet.
 * - `syncing`: cached messages are visible while the app catches up.
 * - `stale`: cached messages are visible but the last catch-up failed; the
 *   app keeps retrying on its own.
 */
export type ThreadSyncPhase = "loading" | "syncing" | "stale";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
  /** The thread's synchronization error, if its last attempt failed. */
  readonly error: string | null;
  /**
   * Whether catching up has lasted past the grace period. A short catch-up
   * after a reconnect is normal and is not worth a status row.
   */
  readonly syncGraceElapsed: boolean;
  /**
   * Whether this thread was last shown as stale. An automatic retry clears
   * the error while it runs; holding `stale` until the thread goes live keeps
   * the row from blinking off and on with every retry.
   */
  readonly staleHeld: boolean;
}): ThreadSyncPhase | null {
  if (!input.shellExists || input.status === "deleted") {
    return null;
  }
  if (
    input.detailExists &&
    (input.error !== null || (input.staleHeld && input.status !== "live"))
  ) {
    return "stale";
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      if (!input.detailExists) return "loading";
      return input.syncGraceElapsed ? "syncing" : null;
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  switch (phase) {
    case "loading":
      return "Loading messages...";
    case "syncing":
      return "Syncing messages...";
    case "stale":
      return "Messages may be out of date";
  }
}
