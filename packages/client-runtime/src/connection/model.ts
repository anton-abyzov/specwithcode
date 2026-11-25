import { EnvironmentId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

const ConnectionTargetBase = {
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class PrimaryConnectionTarget extends Schema.TaggedClass<PrimaryConnectionTarget>()(
  "PrimaryConnectionTarget",
  {
    ...ConnectionTargetBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class BearerConnectionTarget extends Schema.TaggedClass<BearerConnectionTarget>()(
  "BearerConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
  },
) {}

export class RelayConnectionTarget extends Schema.TaggedClass<RelayConnectionTarget>()(
  "RelayConnectionTarget",
  {
    ...ConnectionTargetBase,
  },
) {}

export class SshConnectionTarget extends Schema.TaggedClass<SshConnectionTarget>()(
  "SshConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
  },
) {}

export const ConnectionTarget = Schema.Union([
  PrimaryConnectionTarget,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
]);
export type ConnectionTarget = typeof ConnectionTarget.Type;

export const PersistedConnectionTarget = Schema.Union([
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
]);
export type PersistedConnectionTarget = typeof PersistedConnectionTarget.Type;

export type ConnectionTargetKind = ConnectionTarget["_tag"];

export type NetworkStatus = "unknown" | "offline" | "online";

export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "relay-unavailable",
  "remote-unavailable",
  "rate-limited",
]);
export type ConnectionTransientReason = typeof ConnectionTransientReason.Type;

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
  "unsupported",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

export class ConnectionTransientError extends Schema.TaggedError<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    reason: ConnectionTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
    /** The relay reached its tunnel but the machine did not answer: it is asleep or off. */
    machineOffline: Schema.optionalKey(Schema.Boolean),
    /**
     * The relay itself gave this device no answer (the request failed in
     * transport or timed out), so nothing is known about the machine and this
     * device's network may be in the way.
     */
    relayUnreachable: Schema.optionalKey(Schema.Boolean),
    /** The machine refused this client for a while; no retry comes sooner. */
    retryAfterMs: Schema.optionalKey(Schema.Number),
    /** The machine waits for its owner to type this code (1327); `detail` says where. */
    deviceApprovalCode: Schema.optionalKey(Schema.String),
    /**
     * The machine name `detail` mentions, when it is not the target's own label (a server
     * can report another name). Relay spans strip it; `detail` stays as the person reads it.
     */
    machineLabel: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ConnectionBlockedError extends Schema.TaggedError<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
    /**
     * The machine name `detail` mentions, when it is not the target's own label (a server
     * can report another name). Relay spans strip it; `detail` stays as the person reads it.
     */
    machineLabel: Schema.optionalKey(Schema.String),
    /** The host speaks an older orchestration protocol; updating it restores the connection. */
    serverUpdateRequired: Schema.optionalKey(Schema.Boolean),
    /** The host no longer accepts this device's approval; pairing again restores the connection. */
    reapprovalRequired: Schema.optionalKey(Schema.Boolean),
    /**
     * This device has no SpecWithCode Connect sign-in, and the route needs one;
     * signing in restores the connection. Never set for a machine's own
     * credential refusal, which signing in does not fix.
     */
    connectSignInRequired: Schema.optionalKey(Schema.Boolean),
    /**
     * The relay refused this window's Connect sign-in itself: its session token
     * was missing or no longer accepted, or this device was removed from the
     * account. A new sign-in fixes it. Never set for a DPoP proof the relay
     * rejected or one this device could not make, which a sign-in does not
     * fix (1417, AC-13).
     */
    connectSessionRefused: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

export const DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export type PreparedHttpAuthorization =
  | {
      readonly _tag: "Bearer";
      readonly token: string;
    }
  | {
      readonly _tag: "Dpop";
      readonly accessToken: string;
      readonly expiresAtEpochMs: number;
    };

export interface PreparedConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly target: ConnectionTarget;
}

export type SupervisorConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "backoff"
  | "connected"
  | "blocked";

export type ConnectionAttemptStage = "preparing" | "opening" | "synchronizing";

export interface SupervisorConnectionState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
  /**
   * When this device last had a session with the machine in this run (epoch
   * ms): when it was established while connected, when it ended afterwards.
   * Absent or null when it has had none.
   */
  readonly lastConnectedAt?: number | null;
  /**
   * Since when this device has had no session while wanting one (epoch ms):
   * when the last session ended, else when the connection was asked for.
   * Null while connected or not wanted.
   */
  readonly lostAt?: number | null;
  /**
   * Why the latest attempt since {@link lostAt} failed. Unlike `lastFailure`
   * it survives an explicit retry, so what a person reads about the machine
   * does not blank while the retry runs.
   */
  readonly lossFailure?: ConnectionAttemptError | null;
}

export type ConnectionProjectionPhase = "disconnected" | "synchronizing" | "ready";

export function connectionProjectionPhase(
  state: SupervisorConnectionState,
): ConnectionProjectionPhase {
  switch (state.phase) {
    case "connecting":
      return "synchronizing";
    case "connected":
      return "ready";
    case "available":
    case "offline":
    case "backoff":
    case "blocked":
      return "disconnected";
  }
}

export const AVAILABLE_CONNECTION_STATE: SupervisorConnectionState = Object.freeze({
  desired: false,
  network: "unknown",
  phase: "available",
  stage: null,
  attempt: 0,
  generation: 0,
  lastFailure: null,
  retryAt: null,
});
