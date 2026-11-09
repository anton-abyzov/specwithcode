import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  | "credentials-changed"
  // The device moved to a different network (another Wi-Fi, Wi-Fi to
  // cellular) while staying online. Saved routes may have changed reach.
  | "network-changed"
  // The person is looking at the app again (a window took focus, or a
  // desktop window came back after a brief hide). It only cuts short a
  // pending retry; a live session is neither probed nor resubscribed, so it
  // costs nothing while connected.
  | "retry-hint"
  // The desktop's own backend answers again after a restart. Only a
  // connection to this machine reconnects; remote ones ignore it.
  | "local-backend-ready";

function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect"
  );
}

/** A wakeup that concerns only a connection to this machine. */
export function isLocalBackendWakeup(reason: ConnectionWakeup): boolean {
  return reason === "local-backend-ready";
}

/** Conditions changed enough that a pending retry should run now, from the first rung. */
export function resetsRetryBackoff(reason: ConnectionWakeup): boolean {
  return (
    isApplicationActiveWakeup(reason) ||
    reason === "network-changed" ||
    reason === "retry-hint" ||
    isLocalBackendWakeup(reason)
  );
}

/** Whether a live session should look for a better route after this wakeup. */
export function checksBetterRoute(reason: ConnectionWakeup): boolean {
  return isApplicationActiveWakeup(reason) || reason === "network-changed";
}

// A long resume replaces the session, and the new session subscribes on its own.
export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@specweave-studio/client-runtime/connection/wakeups/ConnectionWakeups") {}

const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
