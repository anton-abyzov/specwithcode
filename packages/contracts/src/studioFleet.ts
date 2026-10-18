import * as Schema from "effect/Schema";
import { AuthGrantScope } from "./auth.ts";
import { AuthSessionId, EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";

export const StudioFleetMachineId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/),
);
/**
 * The most a coordinator on this server may let a worker it starts on another
 * machine run with. Read-only is not offered: a worker grant exists to start
 * threads there.
 */
export const StudioFleetWorkerAccess = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type StudioFleetWorkerAccess = typeof StudioFleetWorkerAccess.Type;

/**
 * Whether this server may start workers on a fleet machine. The grant itself
 * (a bearer token minted on that machine) never leaves this server.
 */
export const StudioFleetWorkersStatus = Schema.Literals([
  "not_allowed",
  "allowed",
  "expiring",
  "revoked",
  "expired",
]);
export type StudioFleetWorkersStatus = typeof StudioFleetWorkersStatus.Type;

/** Why the last attempt to allow or renew workers did not finish. */
export const StudioFleetWorkersProblem = Schema.Literals([
  "unsupported",
  "route_mismatch",
  "pairing_unavailable",
  "pairing_code_rejected",
  "unreachable",
  "identity_mismatch",
]);
export type StudioFleetWorkersProblem = typeof StudioFleetWorkersProblem.Type;

export const StudioFleetWorkers = Schema.Struct({
  status: StudioFleetWorkersStatus,
  access: Schema.NullOr(StudioFleetWorkerAccess),
  expiresAt: Schema.NullOr(IsoDateTime),
  /** True when this server can renew the grant on its own (it holds a management token). */
  renewable: Schema.Boolean,
  problem: Schema.NullOr(StudioFleetWorkersProblem),
});
export type StudioFleetWorkers = typeof StudioFleetWorkers.Type;

export const StudioFleetMachine = Schema.Struct({
  id: StudioFleetMachineId,
  label: Schema.String,
  environmentId: EnvironmentId,
  url: Schema.String,
  status: Schema.Literals(["reachable", "unreachable", "identity-mismatch"]),
  pairingConfigured: Schema.Boolean,
  /** The machine's own name from its environment descriptor; absent when unreachable or on older servers. */
  machineName: Schema.optionalKey(Schema.String),
  /** Absent from servers older than coordinator workers. */
  workers: Schema.optionalKey(StudioFleetWorkers),
});
export type StudioFleetMachine = typeof StudioFleetMachine.Type;
export const StudioFleetSnapshot = Schema.Struct({
  configured: Schema.Boolean,
  connectPermission: Schema.Literals(["access:write", "orchestration:operate"]),
  observedAt: IsoDateTime,
  listener: Schema.Literals(["loopback", "network"]),
  machines: Schema.Array(StudioFleetMachine),
});
export type StudioFleetSnapshot = typeof StudioFleetSnapshot.Type;
export const StudioFleetConnectInput = Schema.StructWithRest(
  Schema.Struct({ id: StudioFleetMachineId }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).check(Schema.makeFilter((value) => Object.keys(value).every((key) => key === "id")));
export const StudioFleetConnectResult = Schema.Struct({
  environmentId: EnvironmentId,
  host: Schema.String,
  pairingCode: Schema.String,
  expiresAt: IsoDateTime,
  scopes: Schema.Array(AuthGrantScope),
});
export type StudioFleetConnectResult = typeof StudioFleetConnectResult.Type;

/** Like the connect input: unknown keys are rejected rather than silently dropped. */
const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]).check(Schema.makeFilter((value) => Object.keys(value).every((key) => key in fields)));

/** A pairing code from the other machine, for when this server cannot mint one itself. */
const StudioFleetPairingCode = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^\S+$/),
);

/** Requests name a configured machine only; never a URL, token or scope. */
export const StudioFleetWorkersAllowInput = exactStruct({
  id: StudioFleetMachineId,
  access: StudioFleetWorkerAccess,
  pairingCode: Schema.optionalKey(StudioFleetPairingCode),
});
export type StudioFleetWorkersAllowInput = typeof StudioFleetWorkersAllowInput.Type;

export const StudioFleetWorkersStopInput = exactStruct({ id: StudioFleetMachineId });
export type StudioFleetWorkersStopInput = typeof StudioFleetWorkersStopInput.Type;

export const StudioFleetWorkersResult = Schema.Struct({
  id: StudioFleetMachineId,
  workers: StudioFleetWorkers,
  /** Stop could not revoke the session on the other machine; it lapses at its expiry. */
  remoteSessionKept: Schema.optionalKey(Schema.Boolean),
});
export type StudioFleetWorkersResult = typeof StudioFleetWorkersResult.Type;

/**
 * A machine's invitation from `fleet invite` on it. The server checks that its
 * private address answers as that machine before saving it; the browser never
 * names a URL or token of its own.
 */
export const StudioFleetAddInput = exactStruct({
  invitation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)),
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
export type StudioFleetAddInput = typeof StudioFleetAddInput.Type;

export const StudioFleetAddResult = Schema.Struct({
  id: StudioFleetMachineId,
  label: Schema.String,
  url: Schema.String,
  environmentId: EnvironmentId,
  /** updated: a configured machine got a new address or token. */
  change: Schema.Literals(["added", "updated"]),
  previousUrl: Schema.optionalKey(Schema.String),
});
export type StudioFleetAddResult = typeof StudioFleetAddResult.Type;

/**
 * Asks this server to publish itself on its own Tailscale name and make an
 * invitation for another machine's Add a machine, as `fleet invite` does.
 */
export const StudioFleetInviteInput = exactStruct({
  /** Name shown for this machine on the other one. Defaults to this machine's own name. */
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  /** How long the other machine may use the invitation. Default 365. */
  days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
});
export type StudioFleetInviteInput = typeof StudioFleetInviteInput.Type;

/**
 * The invitation line holds a management credential: shown once, never
 * cached or logged. `sessionId` names that credential so it can be revoked.
 */
export const StudioFleetInviteResult = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  label: Schema.String,
  expiresAt: IsoDateTime,
  sessionId: AuthSessionId,
});
export type StudioFleetInviteResult = typeof StudioFleetInviteResult.Type;

/** Why this server could not publish itself on its Tailscale name. */
export const StudioFleetInviteProblem = Schema.Literals([
  "tailscale_missing",
  "tailscale_signed_out",
  "tailscale_unavailable",
  "magic_dns_missing",
  "serves_other_server",
  "port_occupied",
  "serve_failed",
  "dev_server_not_proxiable",
  "tailscale_needs_admin",
  "tailscale_sign_in_failed",
]);
export type StudioFleetInviteProblem = typeof StudioFleetInviteProblem.Type;

/**
 * Whether Tailscale on this machine is ready for an invitation: not
 * installed, installed but not signed in (or stopped), or running.
 */
export const StudioFleetTailscaleState = Schema.Literals([
  "not_installed",
  "signed_out",
  "running",
]);
export type StudioFleetTailscaleState = typeof StudioFleetTailscaleState.Type;

export const StudioFleetTailscaleStatus = Schema.Struct({
  state: StudioFleetTailscaleState,
  /** Tailscale's own `BackendState`, such as `NeedsLogin` or `Stopped`; null when unknown. */
  backendState: Schema.NullOr(Schema.String),
  /** Whether this machine has a MagicDNS name, which the invitation needs. */
  magicDns: Schema.Boolean,
  /** The server's platform, so the app links the right download. */
  platform: Schema.String,
  /** Whether Homebrew is installed here, so `brew install --cask tailscale` would work. */
  homebrew: Schema.Boolean,
});
export type StudioFleetTailscaleStatus = typeof StudioFleetTailscaleStatus.Type;

/** Starting a sign-in takes no options: never an auth key or a flag. */
export const StudioFleetTailscaleSignInInput = exactStruct({});
export type StudioFleetTailscaleSignInInput = typeof StudioFleetTailscaleSignInInput.Type;

export const StudioFleetTailscaleSignInResult = Schema.Struct({
  /** The Tailscale sign-in page to open; null when this machine was already signed in. */
  loginUrl: Schema.NullOr(Schema.String),
});
export type StudioFleetTailscaleSignInResult = typeof StudioFleetTailscaleSignInResult.Type;

/** Where a worker this server started on another machine stands, as last observed. */
export const StudioFleetRemoteWorkerState = Schema.Literals([
  "launching",
  "following",
  "idle",
  "wake_pending",
  "paused_auth",
  "stopped",
  "launch_unknown",
  "disposed",
]);
export type StudioFleetRemoteWorkerState = typeof StudioFleetRemoteWorkerState.Type;

export const StudioFleetRemoteWorker = Schema.Struct({
  id: Schema.String,
  machineId: StudioFleetMachineId,
  machineLabel: Schema.String,
  environmentId: EnvironmentId,
  callerThreadId: ThreadId,
  remoteThreadId: Schema.NullOr(ThreadId),
  threadRef: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: StudioFleetRemoteWorkerState,
  lastStatus: Schema.NullOr(Schema.String),
  reachable: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type StudioFleetRemoteWorker = typeof StudioFleetRemoteWorker.Type;

export const StudioFleetRemoteWorkersQuery = Schema.Struct({ projectId: ProjectId });
export const StudioFleetRemoteWorkersResult = Schema.Struct({
  workers: Schema.Array(StudioFleetRemoteWorker),
});
export type StudioFleetRemoteWorkersResult = typeof StudioFleetRemoteWorkersResult.Type;
