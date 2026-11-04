import {
  RELAY_ROUTE_ID,
  type ConnectionCatalogEntry,
  connectionRouteId,
  connectionRoutes,
  hasRelayRoute,
} from "@specweave-studio/client-runtime/connection";
import type { EnvironmentConnectionPhase } from "@specweave-studio/client-runtime/connection";

export interface ConnectRoutePlanMachine {
  readonly environmentId: string;
  readonly entry: ConnectionCatalogEntry;
}

/**
 * Saved machines that this Connect account reaches but that have no Connect
 * route yet, skipping this machine and the ids in `skip` (in flight, or removed by the user).
 */
export function machinesMissingConnectRoute<M extends ConnectRoutePlanMachine>(
  saved: ReadonlyArray<M>,
  discoveredIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  skip: ReadonlySet<string>,
): ReadonlyArray<M> {
  return saved.filter(
    (machine) =>
      machine.entry.target._tag !== "PrimaryConnectionTarget" &&
      discoveredIds.has(machine.environmentId) &&
      !skip.has(machine.environmentId) &&
      !hasRelayRoute(machine.entry),
  );
}

/**
 * Route order with Connect first and every other saved route after it, in
 * its current order. Tailscale and other direct routes stay as fallbacks.
 */
export function connectFirstRouteOrder(entry: ConnectionCatalogEntry): ReadonlyArray<string> {
  const ids = connectionRoutes(entry).map((route) => connectionRouteId(route.target));
  return ids.includes(RELAY_ROUTE_ID)
    ? [RELAY_ROUTE_ID, ...ids.filter((id) => id !== RELAY_ROUTE_ID)]
    : ids;
}

const UNREACHABLE_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "offline",
  "reconnecting",
  "error",
]);

/** Switched-on machines that are failing to connect right now. */
export function unreachableMachines<
  M extends ConnectRoutePlanMachine & {
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
  },
>(saved: ReadonlyArray<M>): ReadonlyArray<M> {
  return saved.filter(
    (machine) => machine.entry.enabled && UNREACHABLE_PHASES.has(machine.connection.phase),
  );
}

const DECLINED_KEY = "specwithcode:connect-route-declined";
// Mirrors the stored list so a removal holds for the session when storage is blocked.
const declinedThisSession = new Set<string>();
const undeclinedThisSession = new Set<string>();
// Connect routes being removed right now: the reconciler neither re-adds them
// nor lifts their removal while the catalog still shows the old route.
const removingConnectRoutes = new Set<string>();

/**
 * Machines whose Connect route the user removed on this device. Only a
 * removal from the route list counts: routes dropped by a sign-out come back
 * on the next sign-in.
 */
export function readDeclinedConnectRoutes(): Set<string> {
  let stored: string[] = [];
  try {
    const raw = globalThis.localStorage.getItem(DECLINED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) stored = parsed.filter((id) => typeof id === "string");
  } catch {
    // Storage blocked: fall back to this session's removals.
  }
  const declined = new Set(stored.filter((id) => !undeclinedThisSession.has(id)));
  for (const id of declinedThisSession) declined.add(id);
  return declined;
}

export function setConnectRouteDeclined(environmentId: string, declined: boolean): void {
  if (declined) {
    declinedThisSession.add(environmentId);
    undeclinedThisSession.delete(environmentId);
  } else {
    declinedThisSession.delete(environmentId);
    undeclinedThisSession.add(environmentId);
  }
  try {
    const raw = globalThis.localStorage.getItem(DECLINED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    const current = new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
    if (current.has(environmentId) === declined) return;
    if (declined) current.add(environmentId);
    else current.delete(environmentId);
    globalThis.localStorage.setItem(DECLINED_KEY, JSON.stringify([...current]));
  } catch {
    // Storage blocked: the in-memory copy holds the removal until the app restarts.
  }
}

/** Marks a Connect route removal as started; the route stays out of the reconciler. */
export function beginConnectRouteRemoval(environmentId: string): void {
  removingConnectRoutes.add(environmentId);
  setConnectRouteDeclined(environmentId, true);
}

/** Ends a removal; a failed one lifts the removal again. */
export function endConnectRouteRemoval(environmentId: string, removed: boolean): void {
  removingConnectRoutes.delete(environmentId);
  if (!removed) setConnectRouteDeclined(environmentId, false);
}

export function isConnectRouteRemoving(environmentId: string): boolean {
  return removingConnectRoutes.has(environmentId);
}
