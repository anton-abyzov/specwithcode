import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
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
import { environmentPresentations } from "../state/presentation";
import { environmentSession, readEnvironmentScope, readPreparedConnection } from "../state/session";
import type {
  StudioFleetAddResult,
  StudioFleetSnapshot,
  StudioFleetWorkerAccess,
  StudioFleetWorkersResult,
} from "@specweave-studio/contracts/studioFleet";
import {
  requestFleet,
  requestFleetAdd,
  requestFleetPairing,
  requestFleetWorkersAllow,
  requestFleetWorkersStop,
  requestRemoteWorkers,
} from "./fleetRequest";

const fleetAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const presentation = get(environmentPresentations.presentationAtom(environmentId));
      const session = get(environmentSession.sessionStateAtom(environmentId));
      const grant = Option.getOrNull(AsyncResult.value(session));
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (
        presentation?.connection.phase !== "connected" ||
        session._tag === "Failure" ||
        !grant ||
        !sessionGrantsScope(grant, AuthOrchestrationReadScope) ||
        !prepared
      )
        return Effect.succeed(null);
      return requestFleet(prepared);
    })
    .pipe(Atom.setIdleTTL(30_000), Atom.withLabel(`studio-fleet:${environmentId}`)),
);
const remoteWorkersAtom = Atom.family((key: string) => {
  const { environmentId, projectId } = JSON.parse(key) as {
    environmentId: EnvironmentId;
    projectId: ProjectId;
  };
  return connectionAtomRuntime
    .atom((get) => {
      const presentation = get(environmentPresentations.presentationAtom(environmentId));
      const session = get(environmentSession.sessionStateAtom(environmentId));
      const grant = Option.getOrNull(AsyncResult.value(session));
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (
        presentation?.connection.phase !== "connected" ||
        session._tag === "Failure" ||
        !grant ||
        !sessionGrantsScope(grant, AuthOrchestrationReadScope) ||
        !prepared ||
        !fleetRunsWorkers(Option.getOrNull(AsyncResult.value(get(fleetAtom(environmentId)))))
      )
        return Effect.succeed(null);
      return requestRemoteWorkers(prepared, projectId);
    })
    .pipe(Atom.setIdleTTL(30_000), Atom.withLabel(`studio-remote-workers:${key}`));
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

/** Workers this project's coordinator started on other machines, as this server last saw them. */
export function useProjectRemoteWorkers(environmentId: EnvironmentId, projectId: ProjectId) {
  const atom = remoteWorkersAtom(JSON.stringify({ environmentId, projectId }));
  const result = useAtomValue(atom);
  const fleet = useAtomValue(fleetAtom(environmentId));
  return {
    workers: Option.getOrNull(AsyncResult.value(result))?.workers ?? [],
    /** Whether there is anything to poll for. */
    available: fleetRunsWorkers(Option.getOrNull(AsyncResult.value(fleet))),
    refresh: () => appAtomRegistry.refresh(atom),
  };
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
    throw new Error(
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
    const failure = Cause.squash(result.cause);
    throw new Error(
      typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "EnvironmentHttpBadRequestError" &&
        "message" in failure &&
        typeof failure.message === "string"
        ? failure.message
        : "Could not add this machine. Refresh, then retry.",
    );
  }
  return result.value;
}
