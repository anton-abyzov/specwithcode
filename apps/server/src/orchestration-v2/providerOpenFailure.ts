import {
  type ModelSelection,
  ORCHESTRATION_V2_PROVIDER_OPEN_FAILED_FAILURE_CODE,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  orchestrationV2RunStartMessageId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import { latestRootProviderFailure } from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

/** A stop with no reset time counts as a live limit for one session window. */
export const LIMIT_STOP_MAX_AGE_MS = 5 * 60 * 60_000;

/**
 * The message id prefix of the continuation the `switch` rule sent on a
 * usage-limit stop: `limit-fallback:<thread>:<stopped run>`, or
 * `limit-fallback:<thread>:hop-N:<stopped run>` for a later move after a
 * target could not open.
 */
export const LIMIT_FALLBACK_MESSAGE_PREFIX = "limit-fallback:";

/**
 * The same for a stop that was no usage limit, a provider that could not
 * start: `provider-fallback:<thread>[:hop-N]:<failed run>`. Nothing goes back.
 */
export const PROVIDER_FALLBACK_MESSAGE_PREFIX = "provider-fallback:";

export const epochMs = (at: DateTime.Utc | null | undefined): number =>
  at == null ? Number.NaN : DateTime.toEpochMillis(at);

/**
 * The run a continuation's message id names, and which move it was. The run
 * id comes last, since run ids hold colons; a hop after the first carries
 * `hop-N:` before it, so each move gets its own idempotent id while the way
 * back still finds the original stop.
 */
export function continuedRun(
  messageId: string,
  prefix: string,
): { runId: string; hop: number } | null {
  if (!messageId.startsWith(prefix)) return null;
  const rest = messageId.slice(prefix.length);
  const hop = /^hop-(\d+):/.exec(rest);
  return hop === null
    ? { runId: rest, hop: 0 }
    : { runId: rest.slice(hop[0].length), hop: Number(hop[1]) };
}

/** The fallback move a run's message id names, or null for any other turn. */
export function fallbackMove(
  threadId: string,
  messageId: string,
): { readonly runId: string; readonly hop: number; readonly fromLimit: boolean } | null {
  const fromLimit = continuedRun(messageId, `${LIMIT_FALLBACK_MESSAGE_PREFIX}${threadId}:`);
  if (fromLimit !== null) return { ...fromLimit, fromLimit: true };
  const fromProvider = continuedRun(messageId, `${PROVIDER_FALLBACK_MESSAGE_PREFIX}${threadId}:`);
  return fromProvider === null ? null : { ...fromProvider, fromLimit: false };
}

/**
 * The message a session open failure carried before it had a code. Runs that
 * failed before `provider_open_failed` existed are still read as open failures.
 */
const LEGACY_OPEN_FAILURE_MESSAGE = /^Failed to open \S+ provider session\b/;

/**
 * Whether a run's failure says its provider session never opened: the setup
 * code (`provider_unavailable`), the exhausted-retry code
 * (`provider_open_failed`), or the message such a failure carried before
 * either code was set.
 */
export function isOpenFailure(
  failure: OrchestrationV2ProviderFailure | null | undefined,
): failure is OrchestrationV2ProviderFailure {
  if (failure == null) return false;
  if (
    failure.code === ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE ||
    failure.code === ORCHESTRATION_V2_PROVIDER_OPEN_FAILED_FAILURE_CODE
  )
    return true;
  return (
    failure.code === null &&
    failure.class === "provider_error" &&
    LEGACY_OPEN_FAILURE_MESSAGE.test(failure.message)
  );
}

/**
 * Whether the run before `run` on the same provider instance in its thread
 * also failed to open, within one session window of `atMs`. A repeat says
 * retrying did not help, where one failure alone may be transient.
 * `turnItems` must hold that earlier run's items.
 */
export function previousOpenFailure(
  run: Pick<OrchestrationV2Run, "id" | "ordinal" | "providerInstanceId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  atMs: number,
): boolean {
  const previous = previousRunOnInstance(run, runs);
  if (previous === undefined || previous.status !== "failed") return false;
  const failedAtMs = epochMs(previous.completedAt);
  return (
    Number.isFinite(failedAtMs) &&
    atMs - failedAtMs < LIMIT_STOP_MAX_AGE_MS &&
    isOpenFailure(latestRootProviderFailure(previous, turnItems))
  );
}

/** The latest earlier run of the thread on the same provider instance. */
export function previousRunOnInstance(
  run: Pick<OrchestrationV2Run, "id" | "ordinal" | "providerInstanceId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  let previous: OrchestrationV2Run | undefined;
  for (const candidate of runs)
    if (
      candidate.id !== run.id &&
      candidate.ordinal < run.ordinal &&
      candidate.providerInstanceId === run.providerInstanceId &&
      (previous === undefined || candidate.ordinal > previous.ordinal)
    )
      previous = candidate;
  return previous;
}

/** The message id prefix of a continuation the API-credit rule sent; the way back reads it. */
export const API_CREDIT_MESSAGE_PREFIX = "limit-api:";

/** The subscription run the API-credit rule continued, and the run that continued it. */
export interface ApiCreditOrigin {
  readonly stoppedRunId: OrchestrationV2Run["id"];
  readonly continuedByRunId: OrchestrationV2Run["id"];
  readonly modelSelection: ModelSelection;
  /** When the stopped run's limit resets, if the provider said. */
  readonly resetAt: string | null;
}

/**
 * Where a thread running on an API-key instance came from, when the
 * API-credit rule put it there and it has run nowhere else since. Null for a
 * thread a person moved there, which stays where they put it. With
 * `LIMIT_FALLBACK_MESSAGE_PREFIX` the same for a `switch` fallback.
 */
export function apiCreditOrigin(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "providerInstanceId">,
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      | "id"
      | "ordinal"
      | "providerInstanceId"
      | "modelSelection"
      | "userMessageId"
      | "startMessageId"
    >
  >,
  messagePrefix: string = API_CREDIT_MESSAGE_PREFIX,
  depth = 0,
): ApiCreditOrigin | null {
  const prefix = `${messagePrefix}${thread.id}:`;
  const latestFirst = runs.toSorted((a, b) => b.ordinal - a.ordinal);
  // A steer into the continuation restarts the run under its own message;
  // the message that started it still names the move.
  const started = orchestrationV2RunStartMessageId;
  for (const run of latestFirst) {
    if (run.providerInstanceId !== thread.providerInstanceId) return null;
    if (!started(run).startsWith(prefix)) continue;
    // A continuation that itself stopped and was continued again leads back
    // through each one to the subscription run the first of them continued.
    let stopped = runs.find(
      (candidate) => candidate.id === continuedRun(started(run), prefix)?.runId,
    );
    const seen = new Set<string>();
    while (
      stopped !== undefined &&
      stopped.providerInstanceId === thread.providerInstanceId &&
      started(stopped).startsWith(prefix) &&
      !seen.has(stopped.id)
    ) {
      seen.add(stopped.id);
      const earlier = continuedRun(started(stopped), prefix)?.runId;
      stopped = runs.find((candidate) => candidate.id === earlier);
    }
    if (stopped === undefined || stopped.providerInstanceId === thread.providerInstanceId)
      return null;
    // The stopped run can itself be on an API account the rule moved the
    // thread to before that account ran out of credits: the way back leads
    // on to the subscription that one came from.
    const ordinal = stopped.ordinal;
    const earlier =
      messagePrefix === API_CREDIT_MESSAGE_PREFIX && depth < 8
        ? apiCreditOrigin(
            { id: thread.id, providerInstanceId: stopped.providerInstanceId },
            runs.filter((candidate) => candidate.ordinal <= ordinal),
            messagePrefix,
            depth + 1,
          )
        : null;
    return earlier !== null
      ? { ...earlier, continuedByRunId: run.id }
      : {
          stoppedRunId: stopped.id,
          continuedByRunId: run.id,
          modelSelection: stopped.modelSelection,
          resetAt: null,
        };
  }
  return null;
}
