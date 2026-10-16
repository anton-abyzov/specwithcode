import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

/** Only a failed root turn of the current run owns the thread's failure state. */
export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "error" }> | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest?.failure ?? null;
}

/**
 * A distinct session failure supersedes the turn's classification, unless the
 * latest run finished cleanly after it: a session's lastError outlives the
 * turn that set it, so a completed or cancelled latest run makes it history.
 */
export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  latestSessionError: string | null,
  latestRunStatus?: OrchestrationV2Run["status"] | "idle" | null,
) {
  const sessionError =
    latestRunStatus === "completed" || latestRunStatus === "cancelled" ? null : latestSessionError;
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass:
      sessionError !== null && sessionError !== failure?.message ? null : (failure?.class ?? null),
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/**
 * Whether started `run` ran after `other`. Ordinals follow submission, but a
 * run can start ahead of a held queue (a restart continuation, or a message
 * sent while the queue is held), so a queued run resumed later can have a
 * lower ordinal than one that already ended. An unfinished run is the latest.
 */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

/**
 * The latest run that actually started, when it stopped because the
 * subscription limit was reached. Queued messages after that run must stay
 * queued instead of being sent into the same limit.
 */
export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/**
 * That limited run, when newer runs were queued or cancelled before starting.
 * Callers that treat the highest-ordinal run as the thread outcome would
 * otherwise hide the limit.
 */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  return blocked !== null && runs.some((run) => run.ordinal > blocked.ordinal) ? blocked : null;
}

/**
 * The newest run that is not waiting in a held queue, or null when only held
 * runs exist. A held queue waits for the user, so its runs never stand for the
 * thread's outcome. The SQL thread shell selects the same run.
 */
export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

/**
 * How many queued messages wait in a held queue: they start only when someone
 * resumes the queue (or sends the thread a message), so a thread that has them
 * is waiting on the user. The SQL thread shell counts the same runs.
 */
export function heldQueuedRunCount(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld">>,
): number {
  let count = 0;
  for (const run of runs) if (run.status === "queued" && run.queueHeld === true) count += 1;
  return count;
}

/**
 * How long a failed turn's error stays a live banner. After that, or once a
 * newer run exists or the thread is resolved, the error is history: the
 * timeline keeps a quiet note with its cause and no banner appears.
 */
export const LIVE_THREAD_ERROR_WINDOW_MS = 30 * 60_000;

function epochMillis(value: string | DateTime.DateTime | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const millis = typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);
  return Number.isFinite(millis) ? millis : null;
}

/** Whether a thread-level error belongs to the current turn and may show as a banner. */
export function threadErrorIsLive(input: {
  /** When the failing run ended; null while it is still running. */
  readonly errorAt: string | DateTime.DateTime | null | undefined;
  readonly settled: boolean;
  readonly nowMs: number;
}): boolean {
  if (input.settled) return false;
  const errorAt = epochMillis(input.errorAt);
  return errorAt === null || input.nowMs - errorAt <= LIVE_THREAD_ERROR_WINDOW_MS;
}

/**
 * Whether a failed turn's timeline entry is history rather than the thread's
 * current problem: a newer run superseded it, the thread is resolved, or it
 * is older than the live window.
 */
export function timelineFailureIsHistory(input: {
  readonly runId: string | null;
  readonly latestRunId: string | null;
  readonly occurredAt: string | DateTime.DateTime | null | undefined;
  readonly settled: boolean;
  readonly nowMs: number;
}): boolean {
  if (input.settled) return true;
  if (input.runId !== null && input.latestRunId !== null && input.runId !== input.latestRunId) {
    return true;
  }
  const occurredAt = epochMillis(input.occurredAt);
  return occurredAt !== null && input.nowMs - occurredAt > LIVE_THREAD_ERROR_WINDOW_MS;
}

/** Older builds stored this when a provider gave no reason; it is never shown as-is. */
export const LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

/** The most specific explanation available when a provider sent no message. */
export function providerFailureFallbackMessage(
  failureClass: OrchestrationV2ProviderFailure["class"],
): string {
  switch (failureClass) {
    case "transport_error":
      return "The connection to the provider closed before this turn finished. Send your message again to continue.";
    case "permission_error":
      return "The provider refused this turn because of a permission or sign-in problem. Check the provider's sign-in, then send your message again.";
    case "validation_error":
      return "The provider rejected the request for this turn. Check the model and provider settings, then send your message again.";
    case "usage_limit":
      return "The provider's usage limit was reached.";
    case "provider_error":
    case "unknown":
      return "The provider ended this turn with an error but sent no details. Send your message again; if it keeps failing, check the provider setup.";
  }
}

/** A failure's message for display, replacing the legacy generic text with its class's explanation. */
export function providerFailureDisplayMessage(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message">,
): string {
  const message = failure.message.trim();
  return message === "" || message === LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE
    ? providerFailureFallbackMessage(failure.class)
    : failure.message;
}
