import type { ConnectionRoute } from "./catalog.ts";
import { connectionRouteKind } from "./routes.ts";

/*
 * The connection policy for the server on this machine: the primary
 * environment reached at a loopback address. It needs no network, so it only
 * stops answering while it restarts or stalls (a full disk, a busy event loop,
 * a starved CPU). A stalled server still holds its socket open and answers
 * eventually, so these budgets are long enough to ride out a stall instead of
 * tearing down a working connection. A server that is gone refuses or closes
 * the socket at once, so the longer budgets do not delay noticing that.
 */

/** Retry ceiling: a refused loopback port costs nothing to try again. */
export const LOOPBACK_RETRY_MAX_DELAY_MS = 3_000;
/** How long a session must last before the retry ladder restarts. */
export const LOOPBACK_BACKOFF_RESET_AFTER_MS = 5_000;
/** Time one attempt may spend on setup (descriptor, ticket, socket, config). */
export const LOOPBACK_CONNECTION_ESTABLISHMENT_TIMEOUT = "60 seconds";
/** Per-request budget for the descriptor and WebSocket ticket during setup. */
export const LOOPBACK_SETUP_REQUEST_TIMEOUT_MS = 30_000;
/** How long the WebSocket may take to open. */
export const LOOPBACK_SOCKET_OPEN_TIMEOUT = "30 seconds";
/**
 * How long after the last frame from the server the session still answers
 * its own pings for it. The RPC client then gives up after its usual three
 * unanswered 5 second windows, so the socket counts as dead after about 60
 * seconds of total silence, against about 20 for a remote server.
 */
export const LOOPBACK_ANSWERED_SILENCE_MS = 40_000;
/** Traffic this recent answers a health check without waiting for a reply. */
export const LOOPBACK_RECENT_TRAFFIC_MS = 5_000;

/**
 * Whether a route reaches the server on this machine: the primary route at a
 * loopback address, on a supervisor that treats its primary as this machine.
 * A bearer or SSH route at a loopback address is a port forward to another
 * machine, so it keeps the remote policy.
 */
export function isThisMachineRoute(
  thisMachine: boolean,
  route: ConnectionRoute | undefined,
): boolean {
  return (
    thisMachine &&
    route !== undefined &&
    route.target._tag === "PrimaryConnectionTarget" &&
    connectionRouteKind(route) === "loopback"
  );
}
