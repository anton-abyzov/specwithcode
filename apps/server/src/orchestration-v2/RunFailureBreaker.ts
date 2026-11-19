import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@specweave-studio/contracts";
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

type BreakerRun = Pick<OrchestrationV2Run, "ordinal" | "status"> &
  Partial<Pick<OrchestrationV2Run, "userMessageId">>;
type BreakerMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "role" | "creationSource" | "scheduledTaskId"
>;

/**
 * A run started by a person's or an agent's message, or a routine's Run now.
 * Its failure opens a new streak: the runs before it no longer count.
 */
function startsFreshStreak(run: BreakerRun, messages: ReadonlyArray<BreakerMessage>): boolean {
  if (run.userMessageId === undefined) return false;
  const message = messages.find((candidate) => candidate.id === run.userMessageId);
  if (message === undefined || message.role !== "user") return false;
  if (message.id.startsWith(ROUTINE_MESSAGE_PREFIX))
    return isManualRoutineFire(message.id, message.scheduledTaskId);
  return message.creationSource !== "server";
}

/**
 * How many of the thread's latest finished runs failed, counting back to the
 * first that did not, or to the failed run a person's message started.
 */
export function trailingFailedRuns(
  runs: ReadonlyArray<BreakerRun>,
  messages: ReadonlyArray<BreakerMessage> = [],
): number {
  const finished = runs
    .filter((run) => FINISHED.has(run.status))
    .toSorted((left, right) => right.ordinal - left.ordinal);
  let failed = 0;
  for (const run of finished) {
    if (run.status !== "failed") break;
    failed++;
    if (startsFreshStreak(run, messages)) break;
  }
  return failed;
}

/**
 * Why an automatic run (isBreakerGuardedRun) may not start, or null when it may. A person's or an agent's
 * message always starts and resets the count: its own retry starts a new streak.
 */
export function failedRunBreakerRefusal(
  automatic: boolean,
  runs: ReadonlyArray<BreakerRun>,
  messages: ReadonlyArray<BreakerMessage> = [],
): string | null {
  if (!automatic) return null;
  const failed = trailingFailedRuns(runs, messages);
  return failed < FAILED_RUN_BREAKER_LIMIT
    ? null
    : `Automatic runs are paused in this thread: its last ${failed} runs failed. Read the last error, fix the cause, then send a message to run it again.`;
}

const ROUTINE_MESSAGE_PREFIX = "scheduled-task-message:";

/**
 * A person's Run now of a routine. Its fire key is `<task>:manual:<command>`
 * or `<task>:<uuid>:manual` (ScheduledTaskService), read after the task's own
 * id so a task id that itself contains `:manual` never passes for one. It is
 * how someone retries a routine after fixing it, so the breaker lets it
 * through. Without the task id a fire counts as automatic.
 */
function isManualRoutineFire(messageId: string, scheduledTaskId: string | undefined): boolean {
  if (scheduledTaskId === undefined) return false;
  const prefix = `${ROUTINE_MESSAGE_PREFIX}${scheduledTaskId}:`;
  if (!messageId.startsWith(prefix)) return false;
  const rest = messageId.slice(prefix.length);
  return rest.startsWith("manual:") || /^[^:]+:manual$/.test(rest);
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
  readonly scheduledTaskId?: string | undefined;
}): boolean {
  if (command.messageId.startsWith(ROUTINE_MESSAGE_PREFIX))
    return !isManualRoutineFire(command.messageId, command.scheduledTaskId);
  return (
    command.creationSource === "server" &&
    [PROVIDER_FALLBACK_MESSAGE_PREFIX, PROVIDER_RETRY_MESSAGE_PREFIX].some(
      (prefix) => command.commandId.startsWith(prefix) || command.messageId.startsWith(prefix),
    )
  );
}

/**
 * A queued run the thread would start by itself, judged by its message id
 * alone (a queued run keeps no command): a scheduled routine fire, or the
 * server's provider retry or fallback for this thread.
 */
export function isBreakerGuardedQueuedMessage(
  messageId: string,
  threadId: string,
  scheduledTaskId: string | undefined,
): boolean {
  if (messageId.startsWith(ROUTINE_MESSAGE_PREFIX))
    return !isManualRoutineFire(messageId, scheduledTaskId);
  return [PROVIDER_FALLBACK_MESSAGE_PREFIX, PROVIDER_RETRY_MESSAGE_PREFIX].some((prefix) =>
    messageId.startsWith(`${prefix}${threadId}:`),
  );
}
