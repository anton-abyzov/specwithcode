import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { requestCapacity, type CapacityOperation } from "./capacityRequest";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { environmentSession, readEnvironmentScope, readPreparedConnection } from "../state/session";

/** GET is an observation only. No timers or mount effects invoke native quota refresh. */
const capacityAtom = Atom.family((environmentId: EnvironmentId) =>
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
        grant === null ||
        !sessionGrantsScope(grant, AuthOrchestrationReadScope) ||
        prepared === null
      ) {
        return Effect.succeed(null);
      }
      return requestCapacity(prepared, { kind: "read" });
    })
    .pipe(Atom.setIdleTTL(30_000), Atom.withLabel(`studio-capacity:${environmentId}`)),
);

export function useStudioCapacity(environmentId: EnvironmentId) {
  const result = useAtomValue(capacityAtom(environmentId));
  return {
    snapshot: Option.getOrNull(AsyncResult.value(result)),
    loading: result.waiting,
    failed: result._tag === "Failure",
  };
}

/** Scope and connection are rechecked at the click boundary; server grants remain authoritative. */
export async function mutateStudioCapacity(
  environmentId: EnvironmentId,
  operation: Exclude<CapacityOperation, { kind: "read" }>,
) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared || !canOperateStudioCapacity(environmentId)) {
    throw new Error("This connection cannot change capacity preferences.");
  }
  const action = connectionAtomRuntime.atom(requestCapacity(prepared, operation));
  const result = await executeAtomQuery(appAtomRegistry, action, {
    reportFailure: false,
    reportDefect: false,
  });
  // Invalidate failed observations too; an old ready profile cannot conceal a rejected mutation.
  appAtomRegistry.refresh(capacityAtom(environmentId));
  if (result._tag === "Failure")
    throw new Error("The environment rejected or could not complete this action.");
  return result.value;
}

/** Read the current grant and connection at an explicit draft or mutation click. */
export function canOperateStudioCapacity(environmentId: EnvironmentId): boolean {
  return (
    readPreparedConnection(environmentId) !== null &&
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase === "connected" &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  );
}
