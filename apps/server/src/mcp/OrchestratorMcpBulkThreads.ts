import type { OrchestrationV2ThreadShell, RunId, ThreadId } from "@specweave-studio/contracts";

type BulkShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "activityRunStatus"
  | "activeRunId"
  | "latestRunId"
  | "archivedAt"
  | "deletedAt"
  | "lineage"
>;

const ACTIVE_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * A top-level thread other than the caller's, still live. Delegated subagent
 * threads follow their parent: stopping it stops them, and continuing it
 * drives them again.
 */
function bulkCandidate(shell: BulkShell, callerThreadId: ThreadId | null): boolean {
  return (
    shell.id !== callerThreadId &&
    shell.archivedAt === null &&
    shell.deletedAt === null &&
    shell.lineage.relationshipToParent !== "subagent"
  );
}

/** Threads whose turn is running now, with the run a stop targets. */
export function bulkStopTargets<S extends BulkShell>(
  shells: ReadonlyArray<S>,
  callerThreadId: ThreadId | null,
): ReadonlyArray<{ readonly shell: S; readonly runId: RunId }> {
  return shells.flatMap((shell) => {
    if (!bulkCandidate(shell, callerThreadId)) return [];
    const status = shell.activityRunStatus ?? shell.status;
    const runId = shell.activeRunId ?? shell.latestRunId;
    return ACTIVE_STATUSES.has(status) && runId !== null ? [{ shell, runId }] : [];
  });
}

/**
 * Threads whose latest run was interrupted, by anyone: continuing them all is
 * an explicit request, so a user's Stop is continued too.
 */
export function bulkContinueTargets<S extends BulkShell>(
  shells: ReadonlyArray<S>,
  callerThreadId: ThreadId | null,
): ReadonlyArray<{ readonly shell: S; readonly runId: RunId }> {
  return shells.flatMap((shell) =>
    bulkCandidate(shell, callerThreadId) &&
    shell.status === "interrupted" &&
    shell.activeRunId === null &&
    shell.latestRunId !== null
      ? [{ shell, runId: shell.latestRunId }]
      : [],
  );
}

/** What a continued thread is told; the same words as the Continue button. */
export const BULK_CONTINUE_TEXT = "Continue where you left off.";
