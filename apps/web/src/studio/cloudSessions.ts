import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type CloudSessionsSnapshot,
  type EnvironmentId,
  sessionGrantsScope,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { environmentSession, readPreparedConnection } from "../state/session";
import { requestCloudSessions } from "./cloudSessionsRequest";

const cloudSessionsAtom = Atom.family((environmentId: EnvironmentId) =>
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
      return requestCloudSessions(prepared);
    })
    .pipe(Atom.setIdleTTL(30_000), Atom.withLabel(`studio-cloud-sessions:${environmentId}`)),
);

/** Whether this server can start Anthropic cloud sessions, and the ones it started. */
export function useCloudSessions(environmentId: EnvironmentId): {
  snapshot: CloudSessionsSnapshot | null;
  loading: boolean;
  failed: boolean;
  refresh: () => Promise<void>;
} {
  const result = useAtomValue(cloudSessionsAtom(environmentId));
  return {
    snapshot: Option.getOrNull(AsyncResult.value(result)),
    loading: result.waiting,
    failed: result._tag === "Failure",
    refresh: () => refreshCloudSessions(environmentId),
  };
}

/** Re-runs the server's CLI sign-in check, then re-reads the snapshot. */
export async function refreshCloudSessions(environmentId: EnvironmentId): Promise<void> {
  const prepared = readPreparedConnection(environmentId);
  if (prepared) {
    const action = connectionAtomRuntime.atom(requestCloudSessions(prepared, { refresh: "true" }));
    await executeAtomQuery(appAtomRegistry, action, { reportFailure: false, reportDefect: false });
  }
  appAtomRegistry.refresh(cloudSessionsAtom(environmentId));
}
