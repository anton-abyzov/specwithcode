import { useMemo, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useGitStackedAction } from "../../state/sourceControlActions";
import { vcsEnvironment } from "../../state/vcs";
import { randomUUID } from "../../lib/utils";
import type { HandoffSourceChanges } from "./MachineHandoffDialog";

/** Uncommitted work in the source checkout, read only while the dialog is open. */
export function useHandoffSourceChanges(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly enabled: boolean;
  readonly canCommit: boolean;
}): HandoffSourceChanges {
  const scope = useMemo(
    () => ({
      environmentId: input.enabled ? input.environmentId : null,
      cwd: input.enabled ? input.workspaceRoot : null,
    }),
    [input.enabled, input.environmentId, input.workspaceRoot],
  );
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({ environmentId: scope.environmentId, input: { cwd: scope.cwd } })
      : null,
  );
  const commit = useGitStackedAction(scope);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = status.data;
  const state = !data || !data.isRepo ? "unknown" : data.hasWorkingTreeChanges ? "dirty" : "clean";
  return {
    state,
    fileCount: data?.isRepo ? data.workingTree.files.length : 0,
    committing,
    error,
    onCommit:
      state === "dirty" && input.canCommit && commit.isAllowed
        ? () => {
            if (committing) return;
            setCommitting(true);
            setError(null);
            // A blank message lets the server write one from the diff.
            void commit
              .run({ actionId: randomUUID(), action: "commit" })
              .then((result) => {
                if (result._tag === "Failure") {
                  const failure = squashAtomCommandFailure(result);
                  setError(
                    failure instanceof Error ? failure.message : "Could not commit these changes.",
                  );
                }
                status.refresh();
              })
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : "Could not commit these changes.",
                ),
              )
              .finally(() => setCommitting(false));
          }
        : null,
  };
}
