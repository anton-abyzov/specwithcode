import * as Schema from "effect/Schema";
import { AuthGrantScope } from "./auth.ts";
import { AuthSessionId, EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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

/** How a coordinator reaches a machine: its Tailscale name or its SpecWithCode Connect address. */
export const FleetTransport = Schema.Literals(["tailnet", "connect"]);
export type FleetTransport = typeof FleetTransport.Type;
export const StudioFleetMachine = Schema.Struct({
  id: StudioFleetMachineId,
  label: Schema.String,
  environmentId: EnvironmentId,
  url: Schema.String,
  /** Second address over SpecWithCode Connect, beside a Tailscale `url`. Absent from older servers. */
  connectUrl: Schema.optionalKey(Schema.String),
  /** The address that answered the last check. Absent when unreachable and from older servers. */
  transport: Schema.optionalKey(FleetTransport),
  /** Whether the saved management token is a plain bearer or bound to this machine's fleet key. */
  managementBinding: Schema.optionalKey(Schema.Literals(["bearer", "proof"])),
  status: Schema.Literals(["reachable", "unreachable", "identity-mismatch"]),
  pairingConfigured: Schema.Boolean,
  /** The machine's own name from its environment descriptor; absent when unreachable or on older servers. */
  machineName: Schema.optionalKey(Schema.String),
  /** Absent from servers older than coordinator workers. */
  workers: Schema.optionalKey(StudioFleetWorkers),
});
export type StudioFleetMachine = typeof StudioFleetMachine.Type;
/** A machine line in the fleet file the server skipped; the other machines still load. */
export const StudioFleetInvalidEntry = Schema.Struct({
  kind: Schema.Literal("config"),
  /** Zero-based position in the file's machines list. */
  index: Schema.Number,
  label: Schema.optionalKey(Schema.String),
  reason: Schema.String,
});
export type StudioFleetInvalidEntry = typeof StudioFleetInvalidEntry.Type;
export const StudioFleetSnapshot = Schema.Struct({
  configured: Schema.Boolean,
  connectPermission: Schema.Literals(["access:write", "orchestration:operate"]),
  observedAt: IsoDateTime,
  listener: Schema.Literals(["loopback", "network"]),
  machines: Schema.Array(StudioFleetMachine),
  /** Absent when every line parsed, and from older servers. */
  invalidEntries: Schema.optionalKey(Schema.Array(StudioFleetInvalidEntry)),
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
  /** The machine's SpecWithCode Connect address, when the invitation carried one. */
  connectUrl: Schema.optionalKey(Schema.String),
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
  /** Explicit owner approval of the machine receiving this invitation. Never inferred from its label. */
  coordinatorEnvironmentId: EnvironmentId,
  /** Name shown for this machine on the other one. Defaults to this machine's own name. */
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  /** How long the other machine may use the invitation. Default 365. */
  days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
  /**
   * Which address the line carries: Tailscale, SpecWithCode Connect, or
   * whatever works here (`auto`, both when both do). Absent: the original
   * Tailscale-only line with a management token, for older apps.
   */
  via: Schema.optionalKey(Schema.Literals(["auto", "tailscale", "connect"])),
});
export type StudioFleetInviteInput = typeof StudioFleetInviteInput.Type;

/**
 * The invitation line holds a credential: shown once, never cached or logged.
 * A Tailscale-only line holds a management token, named by `sessionId` so it
 * can be revoked. A line with a SpecWithCode Connect address holds a one-time
 * credential instead, named by `pairingId`, which the other machine must use
 * by `redeemBy`; it then holds a token bound to its own key.
 */
export const StudioFleetInviteResult = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  label: Schema.String,
  expiresAt: IsoDateTime,
  sessionId: Schema.optionalKey(AuthSessionId),
  /** The SpecWithCode Connect address the line carries beside a Tailscale `url`. */
  connectUrl: Schema.optionalKey(Schema.String),
  /** The one-time credential's pairing link, for revoking an unused line. */
  pairingId: Schema.optionalKey(Schema.String),
  /** When the one-time credential stops working if unused. */
  redeemBy: Schema.optionalKey(IsoDateTime),
});
export type StudioFleetInviteResult = typeof StudioFleetInviteResult.Type;

/**
 * The other machine spends a v2 invitation's one-time `redeem` credential
 * here, with a DPoP proof of the key it will hold the management token with.
 * The token's principal, scopes and lifetime come from the invitation, never
 * from this request.
 */
export const StudioFleetRedeemInput = exactStruct({
  credential: StudioFleetPairingCode,
  coordinatorEnvironmentId: EnvironmentId,
});
export type StudioFleetRedeemInput = typeof StudioFleetRedeemInput.Type;

/** A management token bound to the redeeming machine's proof key. */
export const StudioFleetRedeemResult = Schema.Struct({
  managementToken: Schema.String,
  sessionId: AuthSessionId,
  expiresAt: IsoDateTime,
});
export type StudioFleetRedeemResult = typeof StudioFleetRedeemResult.Type;

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
  /** Asked for SpecWithCode Connect, and this machine is not linked to it. */
  "connect_not_linked",
  /** Linked to SpecWithCode Connect, and its address does not answer as this machine. */
  "connect_unreachable",
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
  /** Whether an invitation can carry this machine's SpecWithCode Connect address instead. */
  connect: Schema.optionalKey(
    Schema.Struct({ linked: Schema.Boolean, origin: Schema.NullOr(Schema.String) }),
  ),
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

/**
 * Which of this machine's projects a coordinator machine's workers may run
 * in: every project, the projects linked to that coordinator (a logical
 * project naming it as a member), or the listed ones.
 */
export const StudioWorkGrantProjects = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("linked") }),
  Schema.Struct({
    kind: Schema.Literal("listed"),
    projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(256)),
  }),
]);
export type StudioWorkGrantProjects = typeof StudioWorkGrantProjects.Type;

/**
 * Which of this machine's sign-ins (provider instances) remote work may use:
 * all of them, the listed ones, or none (every launch is refused).
 */
export const StudioWorkGrantAccounts = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("listed"),
    instanceIds: Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type StudioWorkGrantAccounts = typeof StudioWorkGrantAccounts.Type;

/** Whether the coordinator machine is the owner's own or another person's. */
export const StudioWorkGrantOwner = Schema.Literals(["self", "other"]);
export type StudioWorkGrantOwner = typeof StudioWorkGrantOwner.Type;

/** How many machine hops a launch may have made when it reaches this machine. */
export const workGrantHopLimit = (owner: StudioWorkGrantOwner) => (owner === "self" ? 2 : 1);

/**
 * A coordinator machine that may run work on this one, as this machine sees
 * it. The machine doing the work owns and enforces it.
 */
export const StudioWorkGrant = Schema.Struct({
  coordinatorEnvironmentId: EnvironmentId,
  /**
   * The coordinator's name in this machine's fleet list, else its shared
   * nickname, else its environment id (clients show a short form for that).
   */
  machineLabel: Schema.String,
  projects: StudioWorkGrantProjects,
  accounts: StudioWorkGrantAccounts,
  owner: StudioWorkGrantOwner,
  hopLimit: Schema.Int,
  /** The most its threads may run with; null until it has called since this version. */
  runtimeCap: Schema.NullOr(StudioFleetWorkerAccess),
  /** When its newest live grant lapses; null when none is live. */
  expiresAt: Schema.NullOr(IsoDateTime),
  status: Schema.Literals(["active", "revoked", "expired"]),
  revokedAt: Schema.NullOr(IsoDateTime),
  /** Set while revoked threads still run: when they are interrupted. */
  interruptAt: Schema.NullOr(IsoDateTime),
  /** Threads it started here that are running now. */
  runningThreads: Schema.Int,
  /** Allowed before grants had scopes: all projects, all sign-ins until edited. */
  legacy: Schema.Boolean,
});
export type StudioWorkGrant = typeof StudioWorkGrant.Type;

export const StudioWorkGrantsSnapshot = Schema.Struct({
  grants: Schema.Array(StudioWorkGrant),
  projects: Schema.Array(
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      /** Coordinator machines this project is linked to. */
      linkedTo: Schema.Array(EnvironmentId),
      /**
       * Set when the project is no longer offered for remote work: the machine's
       * "No project" folder, an archived project or one a check made for itself.
       * Such a project is listed only while a grant still covers it: a "listed"
       * grant names it, or it is linked to a coordinator whose grant is "linked".
       */
      unavailable: Schema.optionalKey(Schema.Literals(["scratch", "archived", "automated"])),
    }),
  ),
  accounts: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      label: Schema.String,
      driver: Schema.String,
      /** The signed-in account, when the provider reports one. */
      account: Schema.NullOr(Schema.String),
    }),
  ),
  /**
   * Set when this machine could not read its projects, so `projects` is empty for that
   * reason and a grant's project ids cannot be checked against it.
   */
  projectsUnreadable: Schema.optionalKey(Schema.Boolean),
});
export type StudioWorkGrantsSnapshot = typeof StudioWorkGrantsSnapshot.Type;

export const StudioWorkGrantUpdateInput = exactStruct({
  coordinatorEnvironmentId: EnvironmentId,
  projects: Schema.optionalKey(StudioWorkGrantProjects),
  accounts: Schema.optionalKey(StudioWorkGrantAccounts),
  owner: Schema.optionalKey(StudioWorkGrantOwner),
});
export type StudioWorkGrantUpdateInput = typeof StudioWorkGrantUpdateInput.Type;

/** Revoke refuses new work at once and interrupts running work after a grace period. */
export const StudioWorkGrantRevokeInput = exactStruct({ coordinatorEnvironmentId: EnvironmentId });
export type StudioWorkGrantRevokeInput = typeof StudioWorkGrantRevokeInput.Type;

/** Lifts a revoke so that machine may allow workers here again. */
export const StudioWorkGrantRestoreInput = exactStruct({ coordinatorEnvironmentId: EnvironmentId });
export type StudioWorkGrantRestoreInput = typeof StudioWorkGrantRestoreInput.Type;

export const StudioWorkGrantResult = Schema.Struct({ grant: StudioWorkGrant });
export type StudioWorkGrantResult = typeof StudioWorkGrantResult.Type;

/** Grace between Revoke and interrupting the threads that machine started here. */
export const WORK_GRANT_REVOKE_GRACE_MS = 2 * 60 * 1000;

export const StudioFleetRemoveInput = exactStruct({ id: StudioFleetMachineId });
export type StudioFleetRemoveInput = typeof StudioFleetRemoveInput.Type;

/**
 * What removing a machine did on that machine: `revoked` there, `kept` when
 * it could not be reached or refused (still valid there until revoked on it),
 * `none` when this machine held nothing there.
 */
export const StudioFleetRemoteRevoke = Schema.Literals(["revoked", "kept", "none"]);
export type StudioFleetRemoteRevoke = typeof StudioFleetRemoteRevoke.Type;

export const StudioFleetRemoveResult = Schema.Struct({
  id: StudioFleetMachineId,
  label: Schema.String,
  managementToken: StudioFleetRemoteRevoke,
  workerAccess: StudioFleetRemoteRevoke,
  /** The management token's session id there, to revoke it on that machine when kept. */
  managementSessionId: Schema.NullOr(Schema.String),
});
export type StudioFleetRemoveResult = typeof StudioFleetRemoveResult.Type;

/**
 * Phone fleet links. A phone paired with one machine (the hub) asks it for
 * the other machines it knows; each of them mints a phone-only pairing code
 * on the hub's request, and the phone redeems it there itself, so no machine
 * ever holds the phone's token for another (one token per machine).
 */
export const StudioFleetPhoneRouteKind = Schema.Literals(["lan", "tailnet", "fleet"]);
export type StudioFleetPhoneRouteKind = typeof StudioFleetPhoneRouteKind.Type;

export const StudioFleetPhoneRoute = Schema.Struct({
  kind: StudioFleetPhoneRouteKind,
  httpBaseUrl: Schema.String,
});
export type StudioFleetPhoneRoute = typeof StudioFleetPhoneRoute.Type;

export const StudioFleetPhoneRosterInput = exactStruct({
  /** Machines the phone has no working token for; each mints a pairing code for it. */
  mint: Schema.optionalKey(Schema.Array(EnvironmentId).check(Schema.isMaxLength(16))),
});
export type StudioFleetPhoneRosterInput = typeof StudioFleetPhoneRosterInput.Type;

/** Why a machine could not mint a phone code. */
export const StudioFleetPhoneProblem = Schema.Literals([
  "unreachable",
  "identity_mismatch",
  "pairing_unavailable",
  "update_required",
]);
export type StudioFleetPhoneProblem = typeof StudioFleetPhoneProblem.Type;

export const StudioFleetPhoneMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Where the phone may reach it: its private fleet address, then the addresses it reported. */
  routes: Schema.Array(StudioFleetPhoneRoute),
  pairing: Schema.optionalKey(Schema.Struct({ code: Schema.String, expiresAt: IsoDateTime })),
  problem: Schema.optionalKey(StudioFleetPhoneProblem),
});
export type StudioFleetPhoneMachine = typeof StudioFleetPhoneMachine.Type;

export const StudioFleetPhoneRoster = Schema.Struct({
  hub: Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
  machines: Schema.Array(StudioFleetPhoneMachine),
});
export type StudioFleetPhoneRoster = typeof StudioFleetPhoneRoster.Type;

/** Sent by the hub with its management token; the code's session is tied to the hub's phone session. */
export const StudioFleetPhoneMintInput = exactStruct({
  hubEnvironmentId: EnvironmentId,
  hubSessionId: AuthSessionId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  scopes: Schema.Array(AuthGrantScope).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type StudioFleetPhoneMintInput = typeof StudioFleetPhoneMintInput.Type;

export const StudioFleetPhoneMintResult = Schema.Struct({
  code: Schema.String,
  expiresAt: IsoDateTime,
  routes: Schema.Array(StudioFleetPhoneRoute),
});
export type StudioFleetPhoneMintResult = typeof StudioFleetPhoneMintResult.Type;

/**
 * The hub's phone sessions that are still active. Phone sessions here linked
 * to any other session of that hub are revoked; the answer lists the rest.
 */
export const StudioFleetPhoneLinksInput = exactStruct({
  hubEnvironmentId: EnvironmentId,
  activeHubSessionIds: Schema.Array(AuthSessionId).check(Schema.isMaxLength(256)),
});
export type StudioFleetPhoneLinksInput = typeof StudioFleetPhoneLinksInput.Type;

export const StudioFleetPhoneLink = Schema.Struct({
  sessionId: AuthSessionId,
  hubSessionId: AuthSessionId,
  expiresAt: IsoDateTime,
});
export type StudioFleetPhoneLink = typeof StudioFleetPhoneLink.Type;

export const StudioFleetPhoneLinksResult = Schema.Struct({
  links: Schema.Array(StudioFleetPhoneLink),
  revoked: Schema.Int,
});
export type StudioFleetPhoneLinksResult = typeof StudioFleetPhoneLinksResult.Type;

/** An exact release version, `X.Y.Z`: no ranges, tags or prereleases. */
export const StudioFleetUpdateVersion = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/),
);

/** How a fleet machine installs a release: its update agent (macOS service) or the boot service (Linux). */
export const StudioFleetUpdateMethod = Schema.Literals(["service-agent", "boot-service"]);
export type StudioFleetUpdateMethod = typeof StudioFleetUpdateMethod.Type;

/** Where a fleet update request stands on the machine that was asked. */
export const StudioFleetUpdatePhase = Schema.Literals([
  "idle",
  "checking",
  "draining",
  "requesting",
  "requested",
  "downloading",
  "installing",
  "handed-off",
  "cancelled",
  "failed",
]);
export type StudioFleetUpdatePhase = typeof StudioFleetUpdatePhase.Type;

/** Why a fleet machine did not take an update request. */
export const StudioFleetUpdateRefusal = Schema.Literals([
  "downgrade",
  "unknown-version",
  "not-offered",
  "not-held",
  "unsupported",
  "busy",
  "failed",
]);
export type StudioFleetUpdateRefusal = typeof StudioFleetUpdateRefusal.Type;

const StudioFleetUpdateHoldMinutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(15),
);

/**
 * What a fleet primary may ask of this machine with its management token:
 * install a published release (`force` drains and holds the service as
 * Update now does), cancel the install request it wrote, or look for a
 * release now. Nothing else, and no paths, commands or URLs.
 */
export const StudioFleetUpdateInput = Schema.Union([
  exactStruct({
    coordinatorEnvironmentId: EnvironmentId,
    version: StudioFleetUpdateVersion,
    mode: Schema.Literals(["force", "normal"]),
    holdMinutes: Schema.optionalKey(StudioFleetUpdateHoldMinutes),
  }),
  exactStruct({
    coordinatorEnvironmentId: EnvironmentId,
    /** The `installRequestedAt` of the request to cancel. */
    cancel: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(64),
      Schema.isPattern(/^[0-9T:.+Z-]+$/),
    ),
  }),
  exactStruct({
    coordinatorEnvironmentId: EnvironmentId,
    check: Schema.Literal(true),
  }),
]);
export type StudioFleetUpdateInput = typeof StudioFleetUpdateInput.Type;

export const StudioFleetUpdateStatusQuery = Schema.Struct({
  coordinatorEnvironmentId: EnvironmentId,
});
export type StudioFleetUpdateStatusQuery = typeof StudioFleetUpdateStatusQuery.Type;

/** The install request as the update agent's settings hold it. */
export const StudioFleetUpdateRequestRecord = Schema.Struct({
  installRequestedAt: Schema.NullOr(Schema.String),
  installMode: Schema.NullOr(Schema.String),
  installHoldUntil: Schema.NullOr(Schema.String),
  installRequest: Schema.NullOr(Schema.Struct({ at: Schema.String, version: Schema.String })),
});
export type StudioFleetUpdateRequestRecord = typeof StudioFleetUpdateRequestRecord.Type;

export const StudioFleetUpdateResult = Schema.Struct({
  method: StudioFleetUpdateMethod,
  result: Schema.Literals([
    "accepted",
    "requested",
    "checking",
    "check-requested",
    "already-installed",
    "cancelled",
  ]),
  phase: StudioFleetUpdatePhase,
  serverVersion: Schema.String,
  request: Schema.optionalKey(StudioFleetUpdateRequestRecord),
});
export type StudioFleetUpdateResult = typeof StudioFleetUpdateResult.Type;

/**
 * This machine's update state for its fleet primary. `agent` is the update
 * agent's own status (`update_request.py status`) on a macOS service.
 */
export const StudioFleetUpdateStatus = Schema.Struct({
  method: StudioFleetUpdateMethod,
  serverVersion: Schema.String,
  phase: StudioFleetUpdatePhase,
  targetVersion: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
  lastErrorReason: Schema.optionalKey(StudioFleetUpdateRefusal),
  agent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type StudioFleetUpdateStatus = typeof StudioFleetUpdateStatus.Type;

/**
 * A published skill as `owner/repo/name`: three plain segments, each starting
 * with a letter or digit. No scheme (`local:`, `github:`), path, URL, `..` or
 * leading `-` can match, so the value is safe as one argv element.
 */
export const StudioFleetSkillName = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  ),
);

/** Which lock the install lands in: the user's (`vskill install --global`) or one project's. */
export const StudioFleetSkillScope = Schema.Literals(["user", "project"]);
export type StudioFleetSkillScope = typeof StudioFleetSkillScope.Type;

/**
 * What a fleet primary may ask of this machine with its management token:
 * install one published skill at one exact version, for the user or for one
 * of this machine's own projects (named by its id, never a path), and keep
 * the pin `install @version` sets or drop it. Nothing else.
 */
export const StudioFleetSkillInput = Schema.Union([
  exactStruct({
    coordinatorEnvironmentId: EnvironmentId,
    skill: StudioFleetSkillName,
    version: StudioFleetUpdateVersion,
    scope: Schema.Literal("user"),
    pin: Schema.Boolean,
  }),
  exactStruct({
    coordinatorEnvironmentId: EnvironmentId,
    skill: StudioFleetSkillName,
    version: StudioFleetUpdateVersion,
    scope: Schema.Literal("project"),
    projectId: ProjectId.check(Schema.isMaxLength(128)),
    pin: Schema.Boolean,
  }),
]);
export type StudioFleetSkillInput = typeof StudioFleetSkillInput.Type;

export const StudioFleetSkillStatusQuery = Schema.Struct({
  coordinatorEnvironmentId: EnvironmentId,
});
export type StudioFleetSkillStatusQuery = typeof StudioFleetSkillStatusQuery.Type;

/** Where this machine's last skill install from its fleet primary stands. */
export const StudioFleetSkillPhase = Schema.Literals([
  "idle",
  "installing",
  "unpinning",
  "installed",
  "failed",
]);
export type StudioFleetSkillPhase = typeof StudioFleetSkillPhase.Type;

/** Why a fleet machine did not install the skill version it was asked for. */
export const StudioFleetSkillRefusal = Schema.Literals([
  "unsupported",
  "vskill-missing",
  "invalid-skill",
  "unknown-project",
  "install-failed",
  "busy",
]);
export type StudioFleetSkillRefusal = typeof StudioFleetSkillRefusal.Type;

export const StudioFleetSkillResult = Schema.Struct({
  result: Schema.Literal("accepted"),
  /** Names this install in the status call, so the primary reads its own. */
  requestId: Schema.String,
  phase: StudioFleetSkillPhase,
  skill: Schema.String,
  version: Schema.String,
  scope: StudioFleetSkillScope,
});
export type StudioFleetSkillResult = typeof StudioFleetSkillResult.Type;

/**
 * The last skill install on this machine. `installedVersion` and
 * `pinnedVersion` are read back from the lock vskill wrote once it finished.
 */
export const StudioFleetSkillStatus = Schema.Struct({
  phase: StudioFleetSkillPhase,
  requestId: Schema.optionalKey(Schema.String),
  skill: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(StudioFleetSkillScope),
  projectId: Schema.optionalKey(Schema.String),
  pin: Schema.optionalKey(Schema.Boolean),
  installedVersion: Schema.optionalKey(Schema.String),
  pinnedVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastError: Schema.optionalKey(Schema.String),
  lastErrorReason: Schema.optionalKey(StudioFleetSkillRefusal),
});
export type StudioFleetSkillStatus = typeof StudioFleetSkillStatus.Type;
