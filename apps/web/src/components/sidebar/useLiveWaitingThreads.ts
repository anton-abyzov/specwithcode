import type { EnvironmentId } from "@specweave-studio/contracts";
import type { EnvironmentShellState } from "@specweave-studio/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentShell } from "../../state/shell";
import { threadsWaitingOnPerson } from "./liveQuestionThreads";

/** Read while no service is known: no live shell. */
const noShellAtom = Atom.make<EnvironmentShellState | null>(null).pipe(
  Atom.withLabel("web-update-hint-no-shell"),
);

/**
 * The threads of this computer's service that wait on the person, from the
 * live shell Needs you reads. Null while that shell is not live.
 */
export function useLiveWaitingThreads(
  environmentId: EnvironmentId | null,
): ReadonlyMap<string, string> | null {
  const shell = useAtomValue(
    environmentId === null ? noShellAtom : environmentShell.stateValueAtom(environmentId),
  );
  // The shell reducer keeps the thread list stable until a thread changes.
  const threads =
    shell !== null && shell.status === "live" && Option.isSome(shell.snapshot)
      ? shell.snapshot.value.threads
      : null;
  return useMemo(
    () =>
      environmentId === null || threads === null
        ? null
        : threadsWaitingOnPerson(environmentId, threads),
    [environmentId, threads],
  );
}
