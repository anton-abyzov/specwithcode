import type { OrchestrationV2Run } from "@specweave-studio/contracts";
import { PROVIDER_FALLBACK_MESSAGE_PREFIX } from "./providerOpenFailure.ts";
import { PROVIDER_RETRY_MESSAGE_PREFIX } from "./unopenableFallback.ts";

/**
 * After this many failed runs in a row, a thread stops starting runs by
 * itself. On October 21, 2026 one thread failed 21 times in a row, 15 of them
 * routine fires, each paying for the next attempt and burying real errors.
 */
export const FAILED_RUN_BREAKER_LIMIT = 3;

const FINISHED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** How many of the thread's latest finished runs failed, counting back to the first that did not. */
export function trailingFailedRuns(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>,
): number {
  const finished = runs
    .filter((run) => FINISHED.has(run.status))
    .toSorted((left, right) => right.ordinal - left.ordinal);
  let failed = 0;
  for (const run of finished) {
    if (run.status !== "failed") break;
    failed++;
  }
  return failed;
}

/**
 * Why an automatic run (isBreakerGuardedRun) may not start, or null when it may. A person's or an agent's
 * message always starts, and its success resets the count.
 */
export function failedRunBreakerRefusal(
  automatic: boolean,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>,
): string | null {
  if (!automatic) return null;
  const failed = trailingFailedRuns(runs);
  return failed < FAILED_RUN_BREAKER_LIMIT
    ? null
    : `Automatic runs are paused in this thread: its last ${failed} runs failed. Read the last error, fix the cause, then send a message to run it again.`;
}

/**
 * The runs a thread starts by itself again and again: routine fires (their
 * message id, see ScheduledTaskOccurrence) and the server's retry or fallback
 * of a provider that failed to open. Usage-limit fallbacks are capped by
 * LIMIT_FALLBACK_MAX_HOPS and a limit resume waits for the reset, so their
 * policy stays with usage-limit recovery.
 */
export function isBreakerGuardedRun(command: {
  readonly commandId: string;
  readonly messageId: string;
  readonly creationSource?: string | undefined;
}): boolean {
  if (command.messageId.startsWith("scheduled-task-message:")) return true;
  return (
    command.creationSource === "server" &&
    [PROVIDER_FALLBACK_MESSAGE_PREFIX, PROVIDER_RETRY_MESSAGE_PREFIX].some(
      (prefix) => command.commandId.startsWith(prefix) || command.messageId.startsWith(prefix),
    )
  );
}
