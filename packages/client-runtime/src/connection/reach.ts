/**
 * One judgement of whether this device can reach another machine, shared by
 * every surface that words or groups by it. A dropped connection reads
 * "reconnecting" for {@link RECONNECT_GRACE_MS}; after that the wording
 * follows why the latest attempt failed.
 *
 * @module reach
 */
import type { ConnectionAttemptError, NetworkStatus } from "./model.ts";
import type { EnvironmentConnectionPresentation } from "./presentation.ts";

/**
 * How long a machine without a session reads "reconnecting" before it reads as
 * a problem. It covers an update restart and a short stall under memory
 * pressure; a machine that is really gone still shows within about a minute
 * and a half of its last frame.
 */
export const RECONNECT_GRACE_MS = 60_000;

/** Why this device has no session with a machine. */
export type ConnectionLossCause =
  /** The machine's address was reached and the service stayed silent, or a session stopped responding. */
  | "not-answering"
  /** The relay says nothing serves the machine's Connect address. */
  | "no-service"
  /** The relay itself gave this device no answer. */
  | "relay-unreachable"
  /** This device has no network. */
  | "no-network"
  /** The connection was refused and no longer retries. */
  | "stopped"
  /** The machine answered: its owner has not approved this device yet (1327). */
  | "awaiting-approval";

export type MachineReachState =
  | "connected"
  /** Connected, with the thread list still resyncing. */
  | "catching-up"
  /** Inside the grace, with no session yet in this run. */
  | "connecting"
  /** Without a session for less than the grace. */
  | "reconnecting"
  | "not-answering"
  | "offline"
  /** The relay could not be reached from this device. */
  | "cant-reach"
  | "no-network"
  | "stopped"
  /** Turned off here: nobody asked for a connection. */
  | "not-connected";

export interface MachineReach {
  readonly state: MachineReachState;
  /** When the grace ends (epoch ms), while the state still depends on it. */
  readonly graceEndsAt: number | null;
}

export function connectionLossCause(
  failure: ConnectionAttemptError | null,
  network: NetworkStatus,
): ConnectionLossCause | undefined {
  if (network === "offline") return "no-network";
  if (failure === null) return undefined;
  if (failure._tag === "ConnectionBlockedError") return "stopped";
  if (failure.deviceApprovalCode !== undefined) return "awaiting-approval";
  if (failure.relayUnreachable === true) return "relay-unreachable";
  return failure.reason === "endpoint-unavailable" ? "no-service" : "not-answering";
}

function stateAfterGrace(cause: ConnectionLossCause | undefined): MachineReachState {
  switch (cause) {
    case "no-service":
      return "offline";
    case "relay-unreachable":
      return "cant-reach";
    case "no-network":
      return "no-network";
    case "not-answering":
    case "stopped":
    case undefined:
      return "not-answering";
    // Never an outage: `machineReach` answers for it before any grace.
    case "awaiting-approval":
      return "connecting";
  }
}

/**
 * The reach state of another machine at `now`. `listSyncing` marks a connected
 * machine whose thread list is still resyncing.
 *
 * A connection with no recorded loss time (`lostAt`) is judged by its phase
 * alone: a first attempt is "connecting", anything else is past the grace.
 * Inside the grace a machine that had a session in this run is "reconnecting",
 * whichever attempt is running, so an explicit retry does not change the word.
 */
export function machineReach(
  connection: Pick<
    EnvironmentConnectionPresentation,
    "phase" | "lostAt" | "lastConnectedAt" | "cause"
  >,
  now: number,
  options?: { readonly listSyncing?: boolean },
): MachineReach {
  switch (connection.phase) {
    case "connected":
      return {
        state: options?.listSyncing === true ? "catching-up" : "connected",
        graceEndsAt: null,
      };
    case "available":
      return { state: "not-connected", graceEndsAt: null };
    case "error":
    case "unsupported":
      return { state: "stopped", graceEndsAt: null };
    case "offline":
    case "connecting":
    case "reconnecting": {
      const cause = connection.phase === "offline" ? "no-network" : connection.cause;
      // The machine answers every attempt and waits for its owner, however
      // long that takes: the device keeps asking, so this is not an outage.
      if (cause === "awaiting-approval") {
        return {
          state: connection.lastConnectedAt === undefined ? "connecting" : "reconnecting",
          graceEndsAt: null,
        };
      }
      if (connection.lostAt === undefined) {
        return connection.phase === "connecting"
          ? { state: "connecting", graceEndsAt: null }
          : { state: stateAfterGrace(cause), graceEndsAt: null };
      }
      const graceEndsAt = connection.lostAt + RECONNECT_GRACE_MS;
      // A refused connection that a person asked to try again is being tried:
      // that is not an outage with a cause to name yet.
      if (now < graceEndsAt || (cause === "stopped" && connection.phase !== "offline")) {
        return {
          state: connection.lastConnectedAt === undefined ? "connecting" : "reconnecting",
          graceEndsAt: now < graceEndsAt ? graceEndsAt : null,
        };
      }
      return { state: stateAfterGrace(cause), graceEndsAt: null };
    }
  }
}

/** Whether a reach state means the machine cannot be used now: its threads are stale. */
export function isMachineReachDown(state: MachineReachState): boolean {
  switch (state) {
    case "connected":
    case "catching-up":
    case "connecting":
    case "reconnecting":
      return false;
    case "not-answering":
    case "offline":
    case "cant-reach":
    case "no-network":
    case "stopped":
    case "not-connected":
      return true;
  }
}
