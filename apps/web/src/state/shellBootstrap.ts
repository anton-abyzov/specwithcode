import type { SupervisorConnectionState } from "@specweave-studio/client-runtime/connection";

/** A machine gets this many tries to answer before the first load settles without it. */
export const BOOTSTRAP_ATTEMPTS = 2;

/**
 * Whether a machine still holds the first load of chats open. One that has
 * reported does not. One that has not holds it while it is connected (its
 * chats are on the way) and through its first tries; after those it keeps
 * retrying in the background, and the load settles without it, so a machine
 * that is switched off cannot keep every list on "Reading your chats…".
 */
export function environmentHoldsBootstrap(
  connection: Pick<SupervisorConnectionState, "phase" | "desired" | "attempt">,
  hasSnapshot: boolean,
): boolean {
  if (hasSnapshot) return false;
  switch (connection.phase) {
    case "connected":
      return true;
    case "connecting":
      return connection.attempt <= BOOTSTRAP_ATTEMPTS;
    case "backoff":
      return connection.desired && connection.attempt <= BOOTSTRAP_ATTEMPTS;
    case "available":
    case "offline":
    case "blocked":
      return false;
  }
}
