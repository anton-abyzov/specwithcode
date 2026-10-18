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
): MachineStatus {
  const reason = connection.error ?? null;
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

/** "last seen 2h ago" for a machine that is not connected now, or null when the app never saw it. */
export function lastSeenLabel(lastSeenAt: number | null, now: number): string | null {
  if (lastSeenAt === null) return null;
  const age = compactAge(lastSeenAt, now);
  return age === "now" ? "last seen just now" : `last seen ${age} ago`;
}

/** The banner a chat shows while its machine is not connected. */
export function machineUnavailableTitle(
  label: string,
  connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">,
): string {
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
