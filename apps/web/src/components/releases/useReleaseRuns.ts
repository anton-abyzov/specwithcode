import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentConnectedAtom } from "../../studio/connected";
import { requestReleaseRuns } from "../../studio/fleetRequest";
import { environmentSession } from "../../state/session";

/** A running release changes a stage every few seconds; the view re-reads its record this often. */
export const RELEASE_RUNS_REFRESH_MS = 5_000;

const releaseRunsAtom = Atom.family((environmentId: EnvironmentId) =>
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
      return requestReleaseRuns(prepared);
    })
    .pipe(
      Atom.withRefresh(RELEASE_RUNS_REFRESH_MS),
      Atom.setIdleTTL(30_000),
      Atom.withLabel(`studio-release-runs:${environmentId}`),
    ),
);

/** The release runs this machine recorded, re-read while the view is open. */
export function useReleaseRuns(environmentId: EnvironmentId) {
  const result = useAtomValue(releaseRunsAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  return {
    runs: snapshot?.runs ?? [],
    skipped: snapshot?.skipped ?? 0,
    timings: snapshot?.timings,
    installs: snapshot?.installs,
    loading: result.waiting,
    failed: result._tag === "Failure",
    refresh: () => appAtomRegistry.refresh(releaseRunsAtom(environmentId)),
  };
}
