import { useMemo } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { presentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ThreadId } from "@specweave-studio/contracts";
import type { ThreadLinkTarget } from "@specweave-studio/client-runtime/state/threads";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import {
  useThreadLinkTargets,
  useThreadShells,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import { projectExecutionScopes, logicalProjectThreads } from "./projectDomain";

/** Archived rows first, live rows replacing them: a reopened thread shows its live state. */
function mergeShells(
  archived: readonly EnvironmentThreadShell[],
  live: readonly EnvironmentThreadShell[],
): EnvironmentThreadShell[] {
  const rows = new Map<string, EnvironmentThreadShell>();
  for (const row of archived) rows.set(`${row.environmentId}:${row.id}`, row);
  for (const row of live) rows.set(`${row.environmentId}:${row.id}`, row);
  return [...rows.values()];
}

/**
 * A project's threads. Live rows come from the project's own shell list, so an
 * update to another project's thread renders nothing here. Every host's threads
 * are read only while `withEveryThread` is set: the right panel needs them to
 * place an open thread, a subagent or a fork, whatever project it names.
 */
export function useProjectThreadInventory(
  project: EnvironmentProject,
  iconCheckouts: readonly EnvironmentProject[],
  mainCoordinatorId: ThreadId | null,
  withEveryThread = true,
) {
  const executionScopes = useMemo(
    () => projectExecutionScopes(project, iconCheckouts),
    [project, iconCheckouts],
  );
  const archived = useArchivedThreadSnapshots([
    ...new Set(executionScopes.map((scope) => scope.environmentId)),
  ]);
  // Presented once per archive answer, not again on every live update.
  const archivedRows = useMemo(
    () =>
      archived.snapshots.flatMap((entry) =>
        entry.snapshot.threads.map((thread) => presentThreadShell(entry.environmentId, thread)),
      ),
    [archived.snapshots],
  );
  const projectRefs = useMemo(
    () =>
      executionScopes.map((scope) => ({
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      })),
    [executionScopes],
  );
  const projectLive = useThreadShellsForProjectRefs(projectRefs);
  const everyLive = useThreadShells(withEveryThread);
  const projectShells = useMemo(
    () => mergeShells(archivedRows, projectLive),
    [archivedRows, projectLive],
  );
  const shells = useMemo(
    () => (withEveryThread ? mergeShells(archivedRows, everyLive) : projectShells),
    [withEveryThread, archivedRows, everyLive, projectShells],
  );
  const workers = useMemo(
    () =>
      logicalProjectThreads(
        projectShells,
        executionScopes.map((scope) =>
          scope.environmentId === project.environmentId && scope.projectId === project.id
            ? { ...scope, coordinatorThreadId: mainCoordinatorId }
            : scope,
        ),
        Boolean(project.workspaceSettings?.logicalProject),
      ),
    [projectShells, executionScopes, project, mainCoordinatorId],
  );
  // What a link in the project's messages may name: any thread of its host, live or not.
  const liveLinkTargets = useThreadLinkTargets(project.environmentId);
  const linkTargets = useMemo(() => {
    const rows = new Map<string, ThreadLinkTarget>();
    for (const row of archivedRows)
      if (row.environmentId === project.environmentId) rows.set(row.id, row);
    for (const row of liveLinkTargets) rows.set(row.id, row);
    return [...rows.values()];
  }, [archivedRows, liveLinkTargets, project.environmentId]);
  return { executionScopes, archived, shells, workers, linkTargets };
}
