import type { EnvironmentConnectionPresentation } from "@specweave-studio/client-runtime/connection";

import { compactAge } from "~/components/sidebar/SidebarProjectTree.logic";

export interface MachineStatus {
  /** Short state under the machine's name. */
  readonly text: string;
  /** The last failure the app saw, so an unreachable machine says why. */
  readonly reason: string | null;
  /** The app has given up or is waiting between attempts, so a manual retry helps. */
  readonly retryable: boolean;
}

/**
 * What the app says about a machine wherever it shows one: the machine picker,
 * a chat's banner, the sidebar and Settings > Connections. A first attempt is
 * "Connecting…"; once an attempt has failed the machine is unreachable and the
 * picker says so, with the reason, instead of looking like it is about to connect.
 */
export function machineStatus(
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">,
  canOperate = true,
  isThisMachine = false,
): MachineStatus {
  const reason = connection.error ?? null;
  if (isThisMachine && isThisMachineCatchingUp(connection.phase))
    return { text: THIS_MACHINE_CATCHING_UP, reason: null, retryable: false };
  switch (connection.phase) {
    case "connected":
      return canOperate
        ? { text: "Connected", reason: null, retryable: false }
        : { text: "Permission to operate threads required", reason: null, retryable: false };
    case "connecting":
      return { text: "Connecting…", reason: null, retryable: false };
    case "reconnecting":
      return reason
        ? { text: "Can't reach. Retrying automatically", reason, retryable: true }
        : { text: "Reconnecting…", reason: null, retryable: true };
    case "error":
      return { text: "Connection failed", reason, retryable: true };
    case "offline":
      return { text: "Offline. This device has no network", reason: null, retryable: true };
    case "unsupported":
      return { text: "Needs an app update", reason, retryable: false };
    case "available":
      return { text: "Not connected", reason: null, retryable: false };
  }
}

/** What the app says about its own machine while its server is slow to answer. */
export const THIS_MACHINE_CATCHING_UP = "Catching up…";
/** The banner title for the app's own machine while its server is slow to answer. */
export const THIS_MACHINE_BUSY_TITLE = "SpecWithCode on this Mac is busy";

/**
 * The app's own machine is never offline or unreachable: its server shares this
 * device, so any phase short of a stopped ("error") or refused ("unsupported")
 * connection means the server is busy and will catch up on its own.
 */
export function isThisMachineCatchingUp(
  phase: EnvironmentConnectionPresentation["phase"],
): boolean {
  return (
    phase === "connecting" ||
    phase === "reconnecting" ||
    phase === "offline" ||
    phase === "available"
  );
}

/** "last seen 2h ago" for a machine that is not connected now, or null when the app never saw it. */
export function lastSeenLabel(lastSeenAt: number | null, now: number): string | null {
  if (lastSeenAt === null) return null;
  const age = compactAge(lastSeenAt, now);
  return age === "now" ? "last seen just now" : `last seen ${age} ago`;
}

/**
 * The detail line under an unreachable machine: when it was last seen first,
 * then why it can't be reached. Raw connection errors can run long, and a
 * truncated line should still say when the machine was last there.
 */
export function machineDetail(lastSeen: string | null, reason: string | null): string {
  return [lastSeen, reason].filter(Boolean).join(" · ");
}

/** The banner a chat shows while its machine is not connected. */
export function machineUnavailableTitle(
  label: string,
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">,
  isThisMachine = false,
): string {
  if (isThisMachine) {
    if (isThisMachineCatchingUp(connection.phase)) return THIS_MACHINE_BUSY_TITLE;
    if (connection.phase === "unsupported") return `${label} needs an app update`;
    return "Connection to SpecWithCode on this Mac failed";
  }
  switch (connection.phase) {
    case "connecting":
      return `${label} is connecting`;
    case "reconnecting":
      return connection.error ? `Can't reach ${label}` : `${label} is reconnecting`;
    case "unsupported":
      return `${label} needs an app update`;
    case "available":
      return `${label} is not connected`;
    case "offline":
      return "This device is offline";
    case "error":
    case "connected":
      return `Can't reach ${label}`;
  }
}

/**
 * The one-line status word on a saved machine's row in Settings > Connections:
 * "Reconnecting: <reason>" rather than the long sentence, since the full text is
 * one hover away. This machine reads "Catching up" while its server is busy.
 */
export function savedMachineStatus(
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">,
  enabled: boolean,
  isThisMachine = false,
): { readonly text: string; readonly tone: "muted" | "error" } {
  if (!enabled && connection.phase !== "unsupported") return { text: "Off", tone: "muted" };
  if (isThisMachine && isThisMachineCatchingUp(connection.phase))
    return { text: "Catching up", tone: "muted" };
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      return {
        text: connection.error ? `Can't reach: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    // Not a failure: the machine is fine, this build just cannot talk to it.
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}
