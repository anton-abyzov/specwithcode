import { useMemo } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { presentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ThreadId } from "@specweave-studio/contracts";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useThreadShells } from "../state/entities";
import { projectExecutionScopes, logicalProjectThreads } from "./projectDomain";

export function useProjectThreadInventory(
  project: EnvironmentProject,
  iconCheckouts: readonly EnvironmentProject[],
  mainCoordinatorId: ThreadId | null,
) {
  const liveShells = useThreadShells();
  const executionScopes = useMemo(
    () => projectExecutionScopes(project, iconCheckouts),
    [project, iconCheckouts],
  );
  const archived = useArchivedThreadSnapshots([
    ...new Set(executionScopes.map((scope) => scope.environmentId)),
  ]);
  const shells = useMemo(() => {
    const rows = new Map<string, EnvironmentThreadShell>();
    for (const entry of archived.snapshots)
      for (const thread of entry.snapshot.threads) {
        const row = presentThreadShell(entry.environmentId, thread);
        rows.set(`${row.environmentId}:${row.id}`, row);
      }
    for (const row of liveShells) rows.set(`${row.environmentId}:${row.id}`, row);
    return [...rows.values()];
  }, [liveShells, archived.snapshots]);
  const workers = useMemo(
    () =>
      logicalProjectThreads(
        shells,
        executionScopes.map((scope) =>
          scope.environmentId === project.environmentId && scope.projectId === project.id
            ? { ...scope, coordinatorThreadId: mainCoordinatorId }
            : scope,
        ),
        Boolean(project.workspaceSettings?.logicalProject),
      ),
    [shells, executionScopes, project, mainCoordinatorId],
  );
  return { executionScopes, archived, shells, workers };
}
