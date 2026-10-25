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
  return latestRootProviderFailureItem(run, turnItems)?.failure ?? null;
}

/** The exact terminal root item that owns the current failure and its recovery actions. */
export function latestRootProviderFailureItem(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): Extract<OrchestrationV2TurnItem, { type: "error" }> | null {
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
  return latest;
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
  const distinctSessionError =
    sessionError !== null &&
    (failure === null ||
      (sessionError !== failure.message &&
        (unwrapProviderErrorMessage(sessionError) === UNREADABLE_PROVIDER_ERROR ||
          unwrapProviderErrorMessage(sessionError) !==
            unwrapProviderErrorMessage(failure.message))));
  const currentFailure = distinctSessionError ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass: distinctSessionError ? null : (failure?.class ?? null),
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

/**
 * The failure code of a turn SpecWithCode could not save: the disk filled up
 * or SQLite could not open its database. The class stays `unknown`, because
 * older peers decode the class as a closed set; the code carries the cause.
 */
export const LOCAL_STORAGE_FAILURE_CODE = "local_storage";
export const LOCAL_STORAGE_FAILURE_MESSAGE =
  "SpecWithCode could not save this turn because the disk is full or the database could not be opened. Free disk space, then press Continue.";

/** The failure code of a start that found the provider still running the previous turn. */
export const PREVIOUS_TURN_ACTIVE_FAILURE_CODE = "previous_turn_active";
export const PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE =
  "The previous turn is still running in the provider. Wait for it to finish or press Stop, then Continue.";

/**
 * Whether a person can continue a run that failed this way in the same native
 * session ("Continue where you left off."). A provider error, an unclassified
 * failure, a local storage failure or a start that found the previous turn
 * still running can; a rejected request, a sign-in problem, a usage limit or a
 * context that no longer fits would only fail again.
 */
export function isContinuableProviderFailure(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "code" | "message"> | null | undefined,
): boolean {
  if (failure == null) return false;
  if (
    failure.code === LOCAL_STORAGE_FAILURE_CODE ||
    failure.code === PREVIOUS_TURN_ACTIVE_FAILURE_CODE
  ) {
    return true;
  }
  if (failure.class !== "provider_error" && failure.class !== "unknown") return false;
  const message = unwrapProviderErrorMessage(failure.message);
  return !isContextLimitError(message) && !isContextHandoffBudgetMessage(message);
}

/**
 * The run a person's Continue resumes in place, or null: the latest run that
 * started, when it was stopped, stopped on a usage limit, or failed in a way
 * that can continue (see isContinuableProviderFailure).
 */
export function resumableRunId(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly lastErrorClass: OrchestrationV2ProviderFailure["class"] | null | undefined;
}): OrchestrationV2Run["id"] | null {
  const run = latestExecutedRun(input.runs);
  if (run === null) return null;
  if (run.status === "interrupted") return run.id;
  if (run.status !== "failed") return null;
  const failure = latestRootProviderFailure(run, input.turnItems);
  if (failure?.class === "usage_limit") {
    return input.lastErrorClass === "usage_limit" ? run.id : null;
  }
  return isContinuableProviderFailure(failure) ? run.id : null;
}

/**
 * What a provider handoff that does not fit the target says. History is
 * compacted for every handoff; this is the case where even that does not fit
 * next to the request, so the thread needs a model with a larger window.
 */
export const CONTEXT_HANDOFF_TOO_LARGE_MESSAGE =
  "The conversation is too large to hand over to this model's context window. When the project switches providers automatically, SpecWithCode sends your message again whole on a model with room; otherwise choose a larger-context model. Your message was not truncated.";

/** Builds before 1.0.73 stored this wording, which promised a compaction that did not always run. */
const LEGACY_CONTEXT_HANDOFF_BUDGET_PREFIX =
  "Insufficient context allowance for the provider handoff.";

/** Whether a failure message is a handoff that did not fit, in either wording. */
export function isContextHandoffBudgetMessage(message: string): boolean {
  const text = message.trim();
  return (
    text.startsWith(LEGACY_CONTEXT_HANDOFF_BUDGET_PREFIX) ||
    text.startsWith(CONTEXT_HANDOFF_TOO_LARGE_MESSAGE.slice(0, 64))
  );
}

/** A failure's message for display, replacing the legacy generic text with its class's explanation. */
export function providerFailureDisplayMessage(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message">,
): string {
  const message = unwrapProviderErrorMessage(failure.message);
  if (isContextHandoffBudgetMessage(message)) return CONTEXT_HANDOFF_TOO_LARGE_MESSAGE;
  return message === "" || message === LEGACY_GENERIC_PROVIDER_FAILURE_MESSAGE
    ? providerFailureFallbackMessage(failure.class)
    : message;
}

const UNREADABLE_PROVIDER_ERROR = "The provider returned an error without a readable message.";
const MAX_ERROR_ENVELOPE_LENGTH = 65_536;
const MAX_ERROR_ENVELOPE_DEPTH = 16;

/** Decode only explicit provider message envelopes, never arbitrary cause fields. */
export function unwrapProviderErrorMessage(message: string): string {
  if (!message.trim()) return "";
  // Bound parsing work before JSON.parse; oversized diagnostics must not freeze a client.
  if (message.length > MAX_ERROR_ENVELOPE_LENGTH) return UNREADABLE_PROVIDER_ERROR;
  function read(value: unknown, depth: number): string | null {
    if (depth >= MAX_ERROR_ENVELOPE_DEPTH) return null;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return null;
      // Common CLI prefixes wrap an otherwise valid JSON payload.
      const candidate = text.replace(/^(?:Error|API error|Provider error):\s*/iu, "");
      if (
        ["{", "[", '"'].some((prefix) => candidate.startsWith(prefix)) ||
        /^(?:null|true|false|-?\d+(?:\.\d+)?)$/u.test(candidate)
      ) {
        try {
          return read(JSON.parse(candidate), depth + 1);
        } catch {
          // Provider CLIs also prefix plain prose with tags such as [ACP].
          const arrayContent = candidate.slice(1).trimStart();
          return candidate.startsWith("{") ||
            (candidate.startsWith("[") &&
              ["{", '"'].some((prefix) => arrayContent.startsWith(prefix)))
            ? UNREADABLE_PROVIDER_ERROR
            : text;
        }
      }
      return text;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    let genericStatus: string | null = null;
    // Prefer the nested error to a wrapper's generic HTTP status message.
    for (const key of ["error", "response", "data", "message"] as const) {
      const result = read(record[key], depth + 1);
      if (result !== null) {
        // Some HTTP wrappers put a status in `error` and useful prose in `message`.
        if (
          key === "error" &&
          typeof record.error === "string" &&
          /^(?:\d{3}\s+)?(?:bad request|invalid argument|invalid request(?: error)?|request failed|internal(?: server)? error|unknown error|error|unauthorized|forbidden|not found|resource exhausted|rate limit(?:ed| exceeded)?|(?:service )?unavailable)[.!]?$/iu.test(
            result.replaceAll("_", " "),
          )
        ) {
          genericStatus = result;
          continue;
        }
        return record.code === "context_length_exceeded"
          ? `Context length exceeded: ${result}`
          : result;
      }
    }
    return record.code === "context_length_exceeded"
      ? "The model's context limit was exceeded."
      : genericStatus;
  }
  return read(message, 0) ?? UNREADABLE_PROVIDER_ERROR;
}

/** Context capacity is per request, not an account's quota or a resettable usage limit. */
export function isContextLimitError(message: string): boolean {
  const cleanMessage = unwrapProviderErrorMessage(message);
  if (isContextHandoffBudgetMessage(cleanMessage)) return true;
  if (
    /\b(?:output|completion) token count\b/iu.test(cleanMessage) &&
    !/\b(?:input|prompt|context)\b/iu.test(cleanMessage)
  )
    return false;
  return (
    /\bcontext_length_exceeded\b/iu.test(message.slice(0, MAX_ERROR_ENVELOPE_LENGTH)) ||
    /\bcontext[_ -](?:length[_ -]exceeded|window[_ -]exceeded)|\b(?:maximum|exceeds? (?:the )?max(?:imum)?) context (?:length|window)|\b(?:input )?token count(?:\s*\([\d,]+\))? exceeds (?:the )?maximum number of tokens|\bprompt (?:is )?too long\b|\b(?:input|request|conversation) (?:is )?too (?:long|large)\b.{0,100}\b(?:context|tokens?)\b|\bcontext (?:length|window|limit).{0,80}\b(?:exceed|exhaust|full|too (?:long|large))/iu.test(
      cleanMessage,
    )
  );
}

export function providerFailureDisplayTitle(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message">,
): string {
  if (failure.class === "usage_limit") return "Usage limit reached";
  if (isContextLimitError(failure.message)) return "Context limit reached";
  return "Provider error";
}
