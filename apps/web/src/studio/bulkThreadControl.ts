/**
 * Which of a project's threads "Stop all" and "Continue all" act on, and the
 * one-line counts the `/status` command reports.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { RunId } from "@specweave-studio/contracts";

type BulkShell = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "archivedAt" | "lineage" | "latestRun" | "runtime"
>;

const RUNNING_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** The Continue button's words, so a bulk continue reads like a click on it. */
export const CONTINUE_TEXT = "Continue where you left off.";

/** Delegated subagents follow their parent; archived threads are done. */
function isBulkCandidate(thread: BulkShell): boolean {
  return thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent";
}

/** A turn is running now: Stop would interrupt it. A queue alone is not running. */
export function threadIsRunning(thread: BulkShell): boolean {
  const status = thread.runtime?.status ?? thread.latestRun?.status;
  return status !== undefined && RUNNING_STATUSES.has(status);
}

/** The interrupted run Continue picks up, or null when the latest run was not interrupted. */
export function interruptedRunId(thread: BulkShell): RunId | null {
  if (threadIsRunning(thread)) return null;
  return thread.latestRun?.status === "interrupted" ? thread.latestRun.runId : null;
}

export interface BulkThreadTargets<T extends BulkShell> {
  readonly running: ReadonlyArray<T>;
  readonly interrupted: ReadonlyArray<T & { readonly resumeRunId: RunId }>;
  /** Neither running nor interrupted. */
  readonly idle: number;
}

/** Splits a project's threads, except `excludeThreadId` (the caller's own), for bulk actions. */
export function bulkThreadTargets<T extends BulkShell>(
  threads: ReadonlyArray<T>,
  excludeThreadId?: string | null,
): BulkThreadTargets<T> {
  const running: T[] = [];
  const interrupted: Array<T & { readonly resumeRunId: RunId }> = [];
  let idle = 0;
  for (const thread of threads) {
    if (!isBulkCandidate(thread) || thread.id === excludeThreadId) continue;
    const resumeRunId = interruptedRunId(thread);
    if (threadIsRunning(thread)) running.push(thread);
    else if (resumeRunId !== null) interrupted.push({ ...thread, resumeRunId });
    else idle += 1;
  }
  return { running, interrupted, idle };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "Stop 4 running threads?" */
export function stopAllConfirmMessage(count: number): string {
  return `Stop ${count} running ${count === 1 ? "thread" : "threads"}?`;
}

/** "2 running, 1 interrupted, 5 idle" */
export function bulkStatusSummary(targets: {
  readonly running: ReadonlyArray<unknown>;
  readonly interrupted: ReadonlyArray<unknown>;
  readonly idle: number;
}): string {
  return `${targets.running.length} running, ${targets.interrupted.length} interrupted, ${targets.idle} idle`;
}

/** What a finished bulk action says: how many it reached, and how many it could not. */
export function bulkResultMessage(
  verb: "Stopped" | "Continued",
  done: number,
  failed: number,
): string {
  const head = `${verb} ${plural(done, "thread")}.`;
  return failed === 0 ? head : `${head} ${failed} could not be ${verb.toLowerCase()}.`;
}
