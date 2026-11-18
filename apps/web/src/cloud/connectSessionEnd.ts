import {
  type ConnectionCatalogEntry,
  connectionRoutes,
} from "@specweave-studio/client-runtime/connection";
import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";

import { isThisMachineTarget } from "../connection/desktopLocal";

/**
 * The warning before this window's SpecWithCode Connect sign-in ends (1417,
 * AC-11). Clerk ends every sign-in after 7 days and nothing extends one, so
 * the window says so in time: the account button from 24 hours before, a
 * banner from 2 hours before. Only when a saved machine depends on the
 * sign-in; otherwise its end changes nothing the person uses.
 */
export const SESSION_END_MENU_MS = 24 * 60 * 60_000;
export const SESSION_END_BANNER_MS = 2 * 60 * 60_000;

export type SessionEndStage = "none" | "menu" | "banner";

export function sessionEndStage(expireAt: number | null, now: number): SessionEndStage {
  if (expireAt === null) return "none";
  const left = expireAt - now;
  // Ended: Clerk signs the window out on its next refresh, and the signed-out banner takes over.
  if (left <= 0) return "none";
  if (left <= SESSION_END_BANNER_MS) return "banner";
  if (left <= SESSION_END_MENU_MS) return "menu";
  return "none";
}

/**
 * Milliseconds until the warning should be read again: the next stage while
 * there is none, every minute while a time is shown. Null once the sign-in ended.
 */
export function sessionEndRecheckMs(expireAt: number | null, now: number): number | null {
  if (expireAt === null) return null;
  const left = expireAt - now;
  if (left <= 0) return null;
  if (left > SESSION_END_MENU_MS) return left - SESSION_END_MENU_MS;
  return Math.min(60_000, left);
}

/** "1h 40m", "23h", "12m": the time left on the account button, never below a minute. */
export function sessionTimeLeft(left: number): string {
  const minutes = Math.max(1, Math.floor(left / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Whether a saved machine is reached from this window only with the Connect
 * sign-in: every route is the relay, or a direct route that borrows the
 * Connect credential (`authorization: "studio-connect"`). A paired bearer
 * route, SSH and the primary keep working without it.
 */
export function dependsOnConnectSignIn(
  entry: Pick<ConnectionCatalogEntry, "target" | "profile" | "alternateRoutes">,
): boolean {
  return connectionRoutes(entry as ConnectionCatalogEntry).every((route) => {
    if (route.target._tag === "RelayConnectionTarget") return true;
    const profile = Option.getOrNull(route.profile);
    return profile?._tag === "BearerConnectionProfile" && profile.authorization === "studio-connect";
  });
}

/** The names of the switched-on saved machines that depend on the sign-in, never this machine. */
export function machinesDependingOnConnectSignIn(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly entry: ConnectionCatalogEntry;
  }>,
  nameOf: (environmentId: EnvironmentId, label: string) => string,
): ReadonlyArray<string> {
  return environments
    .filter(
      ({ entry }) =>
        entry.enabled && !isThisMachineTarget(entry) && dependsOnConnectSignIn(entry),
    )
    .map(({ environmentId, label }) => nameOf(environmentId, label));
}
