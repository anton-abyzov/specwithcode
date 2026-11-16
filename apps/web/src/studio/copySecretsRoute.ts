import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type FolderCopySecretsRoute,
} from "@specweave-studio/contracts";
import { readEnvironmentScopeAccess } from "../state/session";

/**
 * The second way a window can send a source's secrets. A window signed in to the source
 * from another machine holds no access:write there, so it may not stage secrets the plain
 * way. The source can still send them sealed: it asks the destination machine for a key
 * over its own link and serves the files only as ciphertext that machine opens. Whether
 * that works depends on the pair of machines, so the source is asked per destination and
 * the last answer is kept here for the places that decide without rendering.
 */

type Destination = EnvironmentId | string | null | undefined;

/** A source that cannot be asked (too old, unreachable) sends nothing sealed. */
const NO_ROUTE: FolderCopySecretsRoute = { sealed: false };

const routes = new Map<string, FolderCopySecretsRoute>();
const listeners = new Set<() => void>();
const keyOf = (source: string, destination: string) => `${source}\n${destination}`;

/** The source's last answer for that destination; null when it was not asked yet. */
export const sealedRouteNow = (
  source: EnvironmentId,
  destination: Destination,
): FolderCopySecretsRoute | null =>
  destination ? (routes.get(keyOf(source, destination)) ?? null) : null;

/** Calls `listener` when an answer arrives; returns the unsubscribe. */
export const onSealedRoute = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type SecretsRouteCommand = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly destinationEnvironmentId: EnvironmentId };
}) => Promise<AtomCommandResult<FolderCopySecretsRoute, unknown>>;

/** Asks the source whether it can send secrets sealed to that machine, and keeps the answer. */
export async function askSealedRoute(
  source: EnvironmentId,
  destination: Destination,
  ask: SecretsRouteCommand,
): Promise<FolderCopySecretsRoute> {
  if (!destination) return NO_ROUTE;
  let route = NO_ROUTE;
  try {
    const answer = await ask({
      environmentId: source,
      input: { destinationEnvironmentId: destination as EnvironmentId },
    });
    if (answer._tag === "Success") route = answer.value;
  } catch {
    route = NO_ROUTE;
  }
  routes.set(keyOf(source, destination), route);
  for (const listener of listeners) listener();
  return route;
}

/** True when this window's grant on the source lacks access:write. */
export const sourceDeniesSecrets = (source: EnvironmentId): boolean =>
  readEnvironmentScopeAccess(source, AuthAccessWriteScope) === "denied";

/**
 * Asks only when the answer matters: a window holding access:write sends the plain way.
 * Call it before any step that reads `secretsBlocked`, so the step decides on a fresh answer.
 */
export async function refreshSealedRoute(
  source: EnvironmentId,
  destination: Destination,
  ask: SecretsRouteCommand,
): Promise<void> {
  if (sourceDeniesSecrets(source)) await askSealedRoute(source, destination, ask);
}

/** This window sends that source's secrets to that machine sealed, and only sealed. */
export const secretsSealed = (source: EnvironmentId, destination: Destination): boolean =>
  sourceDeniesSecrets(source) && sealedRouteNow(source, destination)?.sealed === true;

/** This window can send that source's secrets to that machine in no way. */
export const secretsBlocked = (source: EnvironmentId, destination: Destination): boolean =>
  sourceDeniesSecrets(source) && sealedRouteNow(source, destination)?.sealed !== true;

/** Forgets every answer. For tests. */
export const resetSealedRoutes = (): void => {
  routes.clear();
};

/** Why a window without access:write cannot send secrets, with what does send them. */
export function secretsBlockedText(
  source: string,
  destination: string,
  route: FolderCopySecretsRoute | null,
): string {
  const there = `start this copy in the SpecWithCode window on ${source}`;
  switch (route?.reason) {
    case "update_needed":
      return `This window can send secrets once SpecWithCode is updated on ${destination}. Update it there, or ${there}.`;
    case "not_allowed":
      return `${destination} takes secrets from ${source} only while ${source} has full access there as your own machine. Allow that on ${destination}, or ${there}.`;
    case "not_linked":
    case "unreachable":
      return `${source} can't reach ${destination} right now, so this window can't send secrets. To include them, ${there}.`;
    default:
      return `Only SpecWithCode on ${source} can send secrets. To include them, ${there}.`;
  }
}
