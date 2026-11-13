import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  sessionGrantsScope,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { environmentSession, readEnvironmentScope, readPreparedConnection } from "../state/session";
import type {
  StudioFleetAddResult,
  StudioFleetInviteProblem,
  StudioFleetRemoteWorkersResult,
  StudioFleetRemoveResult,
  StudioFleetInviteResult,
  StudioFleetSnapshot,
  StudioFleetTailscaleStatus,
  StudioFleetWorkerAccess,
  StudioFleetWorkersResult,
  StudioWorkGrant,
  StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";
import { revokeServerClientSession, revokeServerPairingLink } from "../environments/primary";
import {
  requestFleet,
  requestFleetAdd,
  requestFleetInvite,
  requestFleetTailscale,
  requestFleetTailscaleSignIn,
  requestFleetPairing,
  requestFleetRemove,
  requestFleetWorkersAccountJoin,
  requestFleetWorkersAllow,
  requestFleetWorkersIncoming,
  requestFleetWorkersStop,
  requestRemoteWorkers,
  requestWorkGrantChange,
  requestWorkGrants,
} from "./fleetRequest";
import { environmentConnectedAtom } from "./connected";
import {
  fleetRetainsWorkers,
  fleetWorkerCapability,
  remoteAttentionObservation,
} from "./remoteAttentionObservation";

const fleetAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const connected = get(environmentConnectedAtom(environmentId));
      const session = get(environmentSession.sessionStateAtom(environmentId));
      const grant = Option.getOrNull(AsyncResult.value(session));
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (
        !connected ||
        !grant ||
        !sessionGrantsScope(grant, AuthOrchestrationReadScope) ||
        !prepared
      )
        return Effect.succeed(null);
      return requestFleet(prepared);
    })
    .pipe(
      Atom.withRefresh(10_000),
      Atom.setIdleTTL(30_000),
      Atom.withLabel(`studio-fleet:${environmentId}`),
    ),
);
// Polling transport state must not invalidate every project's worker request.
// A primitive capability changes only when support or availability changes.
const fleetWorkerCapabilityAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => fleetWorkerCapability(get(fleetAtom(environmentId)))),
);
// The request follows the retained snapshot, so a failed poll keeps known workers.
const fleetRetainsWorkersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => fleetRetainsWorkers(get(fleetAtom(environmentId)))),
);
// Null stands for "no primary machine yet", so pages can call the hook unconditionally.
const workGrantsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  connectionAtomRuntime
    .atom((get) => {
      if (environmentId === null) return Effect.succeed(null);
      const connected = get(environmentConnectedAtom(environmentId));
      const session = get(environmentSession.sessionStateAtom(environmentId));
      const grant = Option.getOrNull(AsyncResult.value(session));
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (!connected || !grant || !sessionGrantsScope(grant, AuthAccessReadScope) || !prepared)
        return Effect.succeed(null);
      return requestWorkGrants(prepared);
    })
    .pipe(Atom.setIdleTTL(30_000), Atom.withLabel(`studio-work-grants:${environmentId}`)),
);
const remoteWorkersAtom = Atom.family((key: string) => {
  const { environmentId, projectId } = JSON.parse(key) as {
    environmentId: EnvironmentId;
    projectId: ProjectId;
  };
  return connectionAtomRuntime
    .atom((get) => {
      const connected = get(environmentConnectedAtom(environmentId));
      const session = get(environmentSession.sessionStateAtom(environmentId));
      const grant = Option.getOrNull(AsyncResult.value(session));
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (
        !connected ||
        !grant ||
        !sessionGrantsScope(grant, AuthOrchestrationReadScope) ||
        !prepared ||
        !get(fleetRetainsWorkersAtom(environmentId))
      )
        return Effect.succeed(null);
      return requestRemoteWorkers(prepared, projectId);
    })
    .pipe(
      Atom.withRefresh(10_000),
      Atom.setIdleTTL(30_000),
      Atom.withLabel(`studio-remote-workers:${key}`),
    );
});

/** How often the project page re-reads workers it started on other machines. */
export const REMOTE_WORKERS_REFRESH_MS = 10_000;

/**
 * Whether this server can run workers on another machine at all: a fleet
 * whose machines report a workers status. Single-machine installs, and
 * servers from before remote workers, never ask for them.
 */
export function fleetRunsWorkers(snapshot: StudioFleetSnapshot | null): boolean {
  return snapshot?.machines.some((machine) => machine.workers !== undefined) ?? false;
}

/**
 * Whether the project's remote worker list is known: the server answered with
 * one, or its fleet runs no workers, or a read failed. The request's own null
 * answer only means its connection or fleet snapshot is not ready yet.
 */
export function remoteWorkersLoaded(
  workers: AsyncResult.AsyncResult<StudioFleetRemoteWorkersResult | null, unknown>,
  fleet: AsyncResult.AsyncResult<StudioFleetSnapshot | null, unknown>,
): boolean {
  if (workers._tag === "Failure" || fleet._tag === "Failure") return true;
  if (Option.getOrNull(AsyncResult.value(workers)) !== null) return true;
  const snapshot = Option.getOrNull(AsyncResult.value(fleet));
  return snapshot !== null && !fleetRunsWorkers(snapshot);
}

/** Workers this project's coordinator started on other machines, as this server last saw them. */
export function useProjectRemoteWorkers(environmentId: EnvironmentId, projectId: ProjectId) {
  const atom = remoteWorkersAtom(JSON.stringify({ environmentId, projectId }));
  const result = useAtomValue(atom);
  const fleet = useAtomValue(fleetAtom(environmentId));
  return {
    workers: Option.getOrNull(AsyncResult.value(result))?.workers ?? [],
    /** The first answer is in, so an empty list means none rather than not yet known. */
    loaded: remoteWorkersLoaded(result, fleet),
    /** Whether there is anything to poll for. */
    available: fleetRunsWorkers(Option.getOrNull(AsyncResult.value(fleet))),
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

/**
 * The primary server's fleet list, or null without a primary or before it
 * loads. The same object until its content changes: the list is read every
 * ten seconds, and effects that depend on it should run on changes only.
 */
export function usePrimaryFleetSnapshot(primaryEnvironmentId: EnvironmentId | null) {
  // The fleet atom needs an id; one that matches no environment reads as no fleet.
  const fleet = useStudioFleet(primaryEnvironmentId ?? ("" as EnvironmentId));
  const next = primaryEnvironmentId === null ? null : fleet.snapshot;
  const kept = useRef<{ readonly key: string; readonly snapshot: typeof next }>({
    key: "null",
    snapshot: null,
  });
  // observedAt changes on every read; the machines are what callers act on.
  const key = JSON.stringify(
    next === null ? null : [next.connectPermission ?? null, next.machines],
  );
  if (kept.current.key !== key) kept.current = { key, snapshot: next };
  return kept.current.snapshot;
}

export function useStudioFleet(environmentId: EnvironmentId) {
  const result = useAtomValue(fleetAtom(environmentId));
  return {
    snapshot: Option.getOrNull(AsyncResult.value(result)),
    loading: result.waiting,
    failed: result._tag === "Failure",
    refresh: () => appAtomRegistry.refresh(fleetAtom(environmentId)),
  };
}
/** The message of a bad-request failure, which the server words for the user. */
/**
 * The error the server declared for this request. The request layer passes on
 * only its common errors and wraps any other as a fetch failure, the declared
 * one as its cause.
 */
export function declaredFailure(cause: Cause.Cause<unknown>): {
  readonly _tag?: unknown;
  readonly reason?: unknown;
  readonly message?: unknown;
} | null {
  const failure = Cause.squash(cause) as {
    readonly _tag?: unknown;
    readonly cause?: unknown;
  } | null;
  if (typeof failure !== "object" || failure === null) return null;
  return failure._tag === "RemoteEnvironmentAuthFetchError" &&
    typeof failure.cause === "object" &&
    failure.cause !== null
    ? failure.cause
    : failure;
}

const messageOfDeclared = (
  cause: Cause.Cause<unknown>,
  tags: ReadonlyArray<string>,
): string | null => {
  const failure = declaredFailure(cause);
  return typeof failure?._tag === "string" &&
    tags.includes(failure._tag) &&
    typeof failure.message === "string"
    ? failure.message
    : null;
};

export function badRequestMessage(cause: Cause.Cause<unknown>): string | null {
  return messageOfDeclared(cause, ["EnvironmentHttpBadRequestError"]);
}

/** What the server said about a machine it could not add, in words it wrote for the user. */
export function fleetAddFailureMessage(cause: Cause.Cause<unknown>): string {
  return (
    messageOfDeclared(cause, [
      "EnvironmentHttpBadRequestError",
      "EnvironmentHttpForbiddenError",
      "EnvironmentHttpInternalServerError",
    ]) ?? "Could not add this machine. Refresh, then retry."
  );
}

const OLD_BUILD_ACCOUNT_JOIN_REFUSAL =
  "Only a sign-in through this machine's own SpecWithCode Connect account";

/**
 * What to say when a machine of the same account did not take this machine's
 * line: its own words, or, when it said nothing, that the join may still have
 * gone through and how to tidy up after a retry.
 */
export function accountJoinFailureMessage(
  cause: Cause.Cause<unknown>,
  coordinatorLabel: string,
  /** This app reaches that machine through its SpecWithCode Connect sign-in. */
  overConnect = false,
): string {
  const said = messageOfDeclared(cause, [
    "EnvironmentHttpBadRequestError",
    "EnvironmentHttpForbiddenError",
    "EnvironmentHttpInternalServerError",
  ]);
  // Builds up to 1.0.265 refused every real Connect sign-in here with these
  // words, which send the owner to a different setup. Through Connect that
  // refusal can only be the old build, so say what fixes it.
  if (overConnect && said?.startsWith(OLD_BUILD_ACCOUNT_JOIN_REFUSAL))
    return `${coordinatorLabel} runs an older SpecWithCode that cannot do this yet. Update SpecWithCode on ${coordinatorLabel}, then choose Allow again.`;
  return (
    said ??
    `${coordinatorLabel} did not answer in time. Check that it is online, then retry; a retry is safe if it added this machine anyway. Afterwards, under Settings > Machines > Authorized clients on this machine, revoke a setup session it no longer uses.`
  );
}

export async function pairStudioFleet(environmentId: EnvironmentId, id: string) {
  const prepared = readPreparedConnection(environmentId);
  const observation = appAtomRegistry.get(fleetAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(observation));
  if (
    !prepared ||
    observation._tag === "Failure" ||
    !readEnvironmentScope(environmentId, snapshot?.connectPermission ?? AuthAccessWriteScope) ||
    !readEnvironmentScope(environmentId, AuthOrchestrationReadScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new Error("This connection cannot pair private machines.");
  const action = connectionAtomRuntime.atom(requestFleetPairing(prepared, id));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure")
    // The server words what the user can fix, such as a machine to approve again.
    throw new Error(
      badRequestMessage(result.cause) ??
        "Could not pair this machine. Check its private connection and pairing permission, then retry.",
    );
  return result.value;
}

function preparedForWorkers(environmentId: EnvironmentId) {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new Error("Allowing workers on another machine needs Manage access on this server.");
  return prepared;
}

/**
 * Lets this server start a coordinator's workers on a fleet machine. The grant
 * is minted and kept by the server; the browser only sees its status.
 */
export async function allowStudioFleetWorkers(
  environmentId: EnvironmentId,
  input: {
    readonly id: string;
    readonly access: StudioFleetWorkerAccess;
    readonly pairingCode?: string;
  },
): Promise<StudioFleetWorkersResult> {
  const prepared = preparedForWorkers(environmentId);
  const action = connectionAtomRuntime.atom(requestFleetWorkersAllow(prepared, input));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(fleetAtom(environmentId));
  if (result._tag === "Failure")
    throw new Error("Could not allow workers on this machine. Refresh, then retry.");
  return result.value;
}

/**
 * Lets the fleet machine `machineId` run workers on `here`, from `here` alone:
 * its server asks that machine, with the management token it holds there, to
 * add and allow this one. The answer is that machine's grant.
 */
export async function allowIncomingStudioFleetWorkers(
  here: EnvironmentId,
  machineId: string,
  access: StudioFleetWorkerAccess,
): Promise<StudioFleetWorkersResult> {
  const prepared = preparedForWorkers(here);
  const action = connectionAtomRuntime.atom(
    requestFleetWorkersIncoming(prepared, { id: machineId, access }),
  );
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(fleetAtom(here));
  if (result._tag === "Failure")
    // The server words what to do, such as updating the other machine.
    throw new Error(
      messageOfDeclared(result.cause, [
        "EnvironmentHttpBadRequestError",
        "EnvironmentHttpForbiddenError",
        "EnvironmentHttpInternalServerError",
        "StudioFleetInviteError",
      ]) ?? "Could not let that machine run work here. Refresh, then retry.",
    );
  return result.value;
}

/**
 * Lets `coordinator`, another machine of the same SpecWithCode Connect
 * account, run workers on `here` with nothing to copy: this machine makes its
 * line and this app hands it over through its Connect sign-in there. That
 * machine adds this one and answers with its grant. A line it refuses is
 * revoked here.
 */
export async function joinAccountMachineForWorkers(input: {
  readonly here: EnvironmentId;
  readonly coordinator: EnvironmentId;
  readonly coordinatorLabel: string;
  readonly access: StudioFleetWorkerAccess;
}): Promise<StudioFleetWorkersResult> {
  const prepared = readPreparedConnection(input.coordinator);
  if (
    !prepared ||
    !readEnvironmentScope(input.coordinator, AuthOrchestrationOperateScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(input.coordinator))?.connection
      .phase !== "connected"
  )
    throw new Error(`Connect to ${input.coordinatorLabel} first.`);
  // No label: the line carries the name this machine reports for itself.
  const invitation = await inviteStudioFleetMachine(input.here, {
    coordinatorEnvironmentId: input.coordinator,
    via: "connect",
  });
  const action = connectionAtomRuntime.atom(
    requestFleetWorkersAccountJoin(prepared, { invitation: invitation.code, access: input.access }),
  );
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(fleetAtom(input.coordinator));
  if (result._tag === "Failure") {
    // Unspent, the line would stay valid for an hour; spent, this is a no-op.
    await revokeStudioFleetInvitation(invitation).catch(() => undefined);
    // That machine words what to do, such as a team rule or an address it cannot reach.
    throw new Error(
      accountJoinFailureMessage(
        result.cause,
        input.coordinatorLabel,
        prepared.httpAuthorization?._tag === "Dpop",
      ),
    );
  }
  return result.value;
}

/** Stops new workers there and revokes this server's grant on that machine. */
export async function stopStudioFleetWorkers(
  environmentId: EnvironmentId,
  id: string,
): Promise<StudioFleetWorkersResult> {
  const prepared = preparedForWorkers(environmentId);
  const action = connectionAtomRuntime.atom(requestFleetWorkersStop(prepared, id));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(fleetAtom(environmentId));
  if (result._tag === "Failure")
    throw new Error("Could not stop workers on this machine. Refresh, then retry.");
  return result.value;
}

/**
 * Adds the machine a `fleet invite` line names to this server's private
 * machines, or moves a configured one to its new address. The server checks
 * the address answers as that machine before saving anything.
 */
export async function addStudioFleetMachine(
  environmentId: EnvironmentId,
  invitation: string,
): Promise<StudioFleetAddResult> {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new Error("Adding a machine needs Manage access on this server.");
  const action = connectionAtomRuntime.atom(requestFleetAdd(prepared, { invitation }));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(fleetAtom(environmentId));
  if (result._tag === "Failure") {
    // The server words what the user can fix: a bad line, an offline machine.
    throw new Error(fleetAddFailureMessage(result.cause));
  }
  return result.value;
}

/** Why an invitation could not be made, so the app can say what to do. */
export class FleetInviteFailure extends Error {
  constructor(
    readonly reason: StudioFleetInviteProblem | "permission" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Publishes this machine on its own Tailscale name and makes the line another
 * machine's Add a machine accepts, as `specwithcode fleet invite` does. The
 * line holds a management credential: callers show it once and keep no copy.
 */
export async function inviteStudioFleetMachine(
  environmentId: EnvironmentId,
  input: {
    readonly coordinatorEnvironmentId: EnvironmentId;
    readonly label?: string;
    readonly days?: number;
    /** Which address the line carries; absent asks for the original Tailscale-only line. */
    readonly via?: "auto" | "tailscale" | "connect";
  },
): Promise<StudioFleetInviteResult> {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new FleetInviteFailure(
      "permission",
      "Inviting this machine needs Manage access on this server.",
    );
  const label = input.label?.trim();
  const action = connectionAtomRuntime.atom(
    requestFleetInvite(prepared, {
      coordinatorEnvironmentId: input.coordinatorEnvironmentId,
      ...(label ? { label } : {}),
      ...(input.days !== undefined ? { days: input.days } : {}),
      ...(input.via !== undefined ? { via: input.via } : {}),
    }),
  );
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") {
    // The server words what to do about Tailscale; anything else is generic.
    const failure = declaredFailure(result.cause);
    if (
      typeof failure === "object" &&
      failure !== null &&
      failure._tag === "StudioFleetInviteError" &&
      typeof failure.reason === "string" &&
      typeof failure.message === "string"
    )
      throw new FleetInviteFailure(failure.reason as StudioFleetInviteProblem, failure.message);
    if (
      typeof failure === "object" &&
      failure !== null &&
      failure._tag === "EnvironmentHttpForbiddenError"
    )
      throw new FleetInviteFailure(
        "permission",
        "This connection cannot invite this machine. Open the app on this machine itself with Manage access, then try again.",
      );
    throw new FleetInviteFailure(
      "unknown",
      "Could not make an invitation on this machine. Check that the app is running here, then try again.",
    );
  }
  return result.value;
}

/**
 * Revokes an invitation's credential on this machine: the management session
 * a Tailscale-only line holds, or the one-time credential of a line with a
 * SpecWithCode Connect address.
 */
export async function revokeStudioFleetInvitation(
  invitation: Pick<StudioFleetInviteResult, "sessionId" | "pairingId">,
): Promise<void> {
  if (invitation.sessionId) await revokeServerClientSession(invitation.sessionId);
  else if (invitation.pairingId) await revokeServerPairingLink(invitation.pairingId);
}

/**
 * Settings > Machines > Add for agents: the machine makes a line for this one
 * and this one redeems it, over connections this app already holds. Only a
 * Connect line, whose credential works once. Unused, it lapses within the hour;
 * redeemed and then failing, it leaves a session on that machine, listed under
 * Authorized clients there. Nobody ever sees the line. Other machines take this
 * request only from the desktop app, not from a browser tab.
 */
export async function addVisibleMachineToStudioFleet(
  primaryEnvironmentId: EnvironmentId,
  machineEnvironmentId: EnvironmentId,
  label: string,
): Promise<StudioFleetAddResult> {
  const manually = `On ${label}, choose Join a main machine under Settings > Machines.`;
  let linked: boolean;
  try {
    linked = (await readStudioFleetTailscale(machineEnvironmentId)).connect?.linked === true;
  } catch {
    throw new FleetInviteFailure("unknown", `Could not check ${label}. Try again.`);
  }
  if (!linked)
    throw new FleetInviteFailure(
      "connect_not_linked",
      `${label} has no SpecWithCode Connect address to add it by. ${manually}`,
    );
  let code: string;
  try {
    ({ code } = await inviteStudioFleetMachine(machineEnvironmentId, {
      coordinatorEnvironmentId: primaryEnvironmentId,
      label,
      via: "connect",
    }));
  } catch (failure) {
    // The server's words say "this machine" for the one it runs on, which here is the other one.
    if (failure instanceof FleetInviteFailure && failure.reason === "permission")
      throw new FleetInviteFailure("permission", `${label} refused this request. ${manually}`);
    if (failure instanceof FleetInviteFailure && failure.reason === "connect_unreachable")
      throw new FleetInviteFailure(
        failure.reason,
        `${label}'s SpecWithCode Connect address is not answering. Try again.`,
      );
    if (failure instanceof FleetInviteFailure && failure.reason !== "unknown")
      throw new FleetInviteFailure(failure.reason, `On ${label}: ${failure.message} ${manually}`);
    throw new FleetInviteFailure("unknown", `Could not make the line on ${label}. ${manually}`);
  }
  return addStudioFleetMachine(primaryEnvironmentId, code);
}

function preparedForInvite(environmentId: EnvironmentId) {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new FleetInviteFailure(
      "permission",
      "Inviting this machine needs Manage access on this server.",
    );
  return prepared;
}

/** The machines a coordinator lists, read fresh so setup can tell whether one is already there. */
export async function readStudioFleetMachines(
  environmentId: EnvironmentId,
): Promise<StudioFleetSnapshot["machines"]> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("Not connected to that machine.");
  const result = await executeAtomQuery(
    appAtomRegistry,
    connectionAtomRuntime.atom(requestFleet(prepared)),
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") throw new Error("Could not read that machine's machine list.");
  return result.value.machines;
}

/** Whether Tailscale here is installed, signed in and running. Read fresh each time. */
export async function readStudioFleetTailscale(
  environmentId: EnvironmentId,
): Promise<StudioFleetTailscaleStatus> {
  const action = connectionAtomRuntime.atom(
    requestFleetTailscale(preparedForInvite(environmentId)),
  );
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure")
    throw new FleetInviteFailure("unknown", "Could not check Tailscale on this machine.");
  return result.value;
}

/**
 * Starts the Tailscale app and its sign-in on this machine and returns the
 * sign-in page to open, or null when it was already signed in.
 */
export async function signInStudioFleetTailscale(
  environmentId: EnvironmentId,
): Promise<string | null> {
  const action = connectionAtomRuntime.atom(
    requestFleetTailscaleSignIn(preparedForInvite(environmentId)),
  );
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") {
    const failure = declaredFailure(result.cause);
    if (
      typeof failure === "object" &&
      failure !== null &&
      failure._tag === "StudioFleetInviteError" &&
      typeof failure.reason === "string" &&
      typeof failure.message === "string"
    )
      throw new FleetInviteFailure(failure.reason as StudioFleetInviteProblem, failure.message);
    throw new FleetInviteFailure(
      "tailscale_sign_in_failed",
      "Could not start signing in to Tailscale. Open the Tailscale app, sign in there, then come back.",
    );
  }
  return result.value.loginUrl;
}

/**
 * "Who can run work here": coordinator machines with a grant on this
 * server's machine. Servers from before scoped grants answer with nothing.
 */
export function useMachineWorkGrants(environmentId: EnvironmentId | null) {
  const result = useAtomValue(workGrantsAtom(environmentId));
  return {
    snapshot: Option.getOrNull(AsyncResult.value(result)),
    loading: result.waiting,
    failed: result._tag === "Failure",
    refresh: () => appAtomRegistry.refresh(workGrantsAtom(environmentId)),
  };
}

function failureMessage(cause: unknown, fallback: string) {
  return badRequestMessage(cause as Cause.Cause<unknown>) ?? fallback;
}

/** Changes, revokes or restores what one coordinator machine may do here. */
export async function changeMachineWorkGrant(
  environmentId: EnvironmentId,
  change:
    | { readonly action: "update"; readonly input: StudioWorkGrantUpdateInput }
    | {
        readonly action: "revoke" | "restore";
        readonly input: { readonly coordinatorEnvironmentId: EnvironmentId };
      },
): Promise<StudioWorkGrant> {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new Error("Changing who can run work here needs Manage access on this machine.");
  const action = connectionAtomRuntime.atom(requestWorkGrantChange(prepared, change));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(workGrantsAtom(environmentId));
  if (result._tag === "Failure")
    throw new Error(
      failureMessage(result.cause, "Could not save this change. Refresh, then retry."),
    );
  return result.value.grant;
}

/** Whether this server can remove a machine from its list. Servers from
    before 1.0.58 lack only that; the rest of the list works with them. */
export function useFleetRemoveSupported(environmentId: EnvironmentId): boolean {
  return useServerConfigs().get(environmentId)?.environment.capabilities.studioFleetRemove === true;
}

/**
 * Removes a machine from this server's list. The server first gives up its
 * worker grant and its management token on that machine, and says which it
 * could not reach.
 */
export async function removeStudioFleetMachine(
  environmentId: EnvironmentId,
  id: string,
): Promise<StudioFleetRemoveResult> {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new Error("Removing a machine needs Manage access on this server.");
  const action = connectionAtomRuntime.atom(requestFleetRemove(prepared, id));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  appAtomRegistry.refresh(fleetAtom(environmentId));
  if (result._tag === "Failure")
    throw new Error(
      failureMessage(result.cause, "Could not remove this machine. Refresh, then retry."),
    );
  return result.value;
}

/** Read-only project attention coverage. A missing follower result cannot prove an all-clear. */
export const projectRemoteAttentionAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { environmentId } = JSON.parse(key) as { environmentId: EnvironmentId };
    const capability = get(fleetWorkerCapabilityAtom(environmentId));
    if (capability === false) return { workers: [], complete: true };
    return remoteAttentionObservation(capability, get(remoteWorkersAtom(key)));
  }),
);
