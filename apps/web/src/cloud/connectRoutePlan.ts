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
 * route yet, skipping this machine and ones already tried in this session.
 */
export function machinesMissingConnectRoute<M extends ConnectRoutePlanMachine>(
  saved: ReadonlyArray<M>,
  discoveredIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  attempted: ReadonlySet<string>,
): ReadonlyArray<M> {
  return saved.filter(
    (machine) =>
      machine.entry.target._tag !== "PrimaryConnectionTarget" &&
      discoveredIds.has(machine.environmentId) &&
      !attempted.has(machine.environmentId) &&
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

const OFFERS_KEY_PREFIX = "specwithcode:connect-route-offers:";

/** Machines that already got an automatic Connect route for this account on this device. */
export function readConnectRouteOffers(accountId: string): Set<string> {
  try {
    const raw = globalThis.localStorage.getItem(OFFERS_KEY_PREFIX + accountId);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function recordConnectRouteOffer(accountId: string, offered: ReadonlySet<string>): void {
  try {
    globalThis.localStorage.setItem(OFFERS_KEY_PREFIX + accountId, JSON.stringify([...offered]));
  } catch {
    // Storage blocked: the offer is remembered for this session only.
  }
}
