import {
  type ConnectionCatalogEntry,
  connectionRoutes,
  type EnvironmentConnectionPresentation,
  routeHttpBaseUrl,
} from "@specweave-studio/client-runtime/connection";
import type { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
} from "@specweave-studio/contracts/studioFleet";

/**
 * Machines the user removed from this browser. Automatic connection leaves
 * them alone until the user connects them again by hand.
 */
const SKIPPED_KEY = "studio:fleet-auto-connect:skipped";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSkippedFleetEnvironments(
  storage: Storage | null = browserStorage(),
): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SKIPPED_KEY) ?? "[]");
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function setFleetEnvironmentSkipped(
  environmentId: EnvironmentId,
  skipped: boolean,
  storage: Storage | null = browserStorage(),
) {
  const next = new Set(readSkippedFleetEnvironments(storage));
  if (skipped === next.has(environmentId)) return;
  if (skipped) next.add(environmentId);
  else next.delete(environmentId);
  try {
    storage?.setItem(SKIPPED_KEY, JSON.stringify([...next]));
  } catch {
    // Storage can be blocked; automatic connection then treats nothing as skipped.
  }
}

/** How long to wait before pairing again with a machine whose last try failed. */
export const FLEET_RETRY_MS = 60_000;

/**
 * Machines tried too recently to try again, from when each was last tried. A
 * failed pairing, such as one made while the server restarts for an update, is
 * retried once this wait has passed instead of waiting for a reload.
 */
export function fleetAttemptsAwaitingRetry(
  attempts: ReadonlyMap<string, number>,
  now: number,
): ReadonlySet<string> {
  return new Set(
    [...attempts]
      .filter(([, at]) => now - at < FLEET_RETRY_MS)
      .map(([environmentId]) => environmentId),
  );
}

/**
 * Saved machines whose server turned this browser's credential down, such as
 * "Approve this device again" after an update that drops older approvals.
 * Pairing again through the fleet replaces that credential.
 */
export function rejectedSavedEnvironments(
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly connection?: Pick<
      EnvironmentConnectionPresentation,
      "phase" | "reapprovalRequired"
    > | null;
  }>,
): ReadonlySet<string> {
  return new Set(
    environments
      .filter(
        ({ connection }) => connection?.phase === "error" && connection.reapprovalRequired === true,
      )
      .map((environment) => environment.environmentId),
  );
}

/**
 * The origins of each saved environment's direct routes, by environment id. A
 * rejected environment has none, so it reads as not saved and is paired again.
 */
export function savedRouteOrigins(
  entries: ReadonlyArray<ConnectionCatalogEntry>,
  rejected: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    entries.map((entry) => [
      entry.target.environmentId,
      new Set(
        rejected.has(entry.target.environmentId)
          ? []
          : connectionRoutes(entry).flatMap((route) => {
              const url = routeHttpBaseUrl(route);
              if (url === null) return [];
              try {
                return [new URL(url).origin];
              } catch {
                return [];
              }
            }),
      ),
    ]),
  );
}

/**
 * Whether this browser already reaches a fleet machine at the address its
 * server lists now. A machine that moved (for example off a relay port on
 * another machine onto its own Tailscale name) counts as unsaved, so the new
 * address is added as another route and the old one stays as a fallback.
 */
export function fleetMachineSaved(
  machine: Pick<StudioFleetMachine, "environmentId" | "url">,
  savedEnvironmentIds: ReadonlySet<string>,
  origins?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!savedEnvironmentIds.has(machine.environmentId)) return false;
  const saved = origins?.get(machine.environmentId);
  if (saved === undefined) return true;
  try {
    return saved.has(new URL(machine.url).origin);
  } catch {
    return true;
  }
}

/** Fleet machines this browser should pair with now, in the server's order. */
export function fleetMachinesToAutoConnect(input: {
  readonly snapshot: StudioFleetSnapshot | null;
  readonly currentEnvironmentId: EnvironmentId;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  /** Without it, any saved environment counts as reached at every address. */
  readonly savedRouteOrigins?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly skippedEnvironmentIds: ReadonlySet<string>;
  readonly attemptedEnvironmentIds: ReadonlySet<string>;
}): ReadonlyArray<StudioFleetMachine> {
  return (input.snapshot?.machines ?? []).filter(
    (machine) =>
      machine.status === "reachable" &&
      machine.pairingConfigured &&
      machine.environmentId !== input.currentEnvironmentId &&
      !fleetMachineSaved(machine, input.savedEnvironmentIds, input.savedRouteOrigins) &&
      !input.skippedEnvironmentIds.has(machine.environmentId) &&
      !input.attemptedEnvironmentIds.has(machine.environmentId),
  );
}

/** Unsaved machines that may still come online, such as a worker that is booting. */
export function fleetMachinesAwaitingReach(input: {
  readonly snapshot: StudioFleetSnapshot | null;
  readonly currentEnvironmentId: EnvironmentId;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly savedRouteOrigins?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly skippedEnvironmentIds: ReadonlySet<string>;
}): ReadonlyArray<StudioFleetMachine> {
  return (input.snapshot?.machines ?? []).filter(
    (machine) =>
      machine.status === "unreachable" &&
      machine.pairingConfigured &&
      machine.environmentId !== input.currentEnvironmentId &&
      !fleetMachineSaved(machine, input.savedEnvironmentIds, input.savedRouteOrigins) &&
      !input.skippedEnvironmentIds.has(machine.environmentId),
  );
}
