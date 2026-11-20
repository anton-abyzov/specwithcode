/**
 * A `message.dispatch` with `startOnly` starts a turn now or is refused: it
 * never leaves a queued run that could start later on its own, after
 * whatever allowed it has ended. The refusal is not recorded, so the same
 * command goes through once the thread is idle (1427).
 *
 * The run it plans keeps `startOnly` and `authorityEndsAt` until a provider
 * takes its prompt: the provider start checks the deadline right before the
 * offer, a provider still busy with another turn fails it instead of putting
 * it back in the queue, and no server continuation picks it up.
 */
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@specweave-studio/contracts";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { ProviderAdapterTurnStartError } from "./ProviderAdapter.ts";
import {
  CONTEXT_COMPACT_MESSAGE_PREFIX,
  CONTEXT_RETRY_MESSAGE_PREFIX,
} from "./contextRecoveryIds.ts";
import { isServerContinuation } from "./QueueFollowsThread.ts";

export const START_ONLY_WOULD_QUEUE = "The thread cannot start this turn now.";

/**
 * A dispatch carrying `authorityEndsAt` is refused, unrecorded, when the
 * serialized start runs at or after it: what allowed it ended while it waited.
 */
export const START_AUTHORITY_ENDED = "What allowed this turn ended before it could start.";

/** A server continuation of a start-only run no provider took is refused. */
export const START_ONLY_NOT_CONTINUED =
  "That turn had to start at once and never reached the provider, so nothing continues it.";

/** Whether `at` (epoch milliseconds) is at or past the subject's authority deadline. */
export const authorityEnded = (
  subject: { readonly authorityEndsAt?: number | undefined },
  at: number,
): boolean => subject.authorityEndsAt !== undefined && at >= subject.authorityEndsAt;

/** Fails with `refusal` once the subject's authority deadline has passed. */
export const refuseEndedAuthority = <E>(
  subject: { readonly authorityEndsAt?: number | undefined },
  refusal: () => E,
): Effect.Effect<void, E> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    authorityEnded(subject, now) ? Effect.fail(refusal()) : Effect.void,
  );

/** The start failure a start-only run past its deadline ends with, before any offer. */
export const authorityEndedError = (input: {
  readonly session: { readonly driver: ProviderAdapterTurnStartError["driver"] };
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId">;
  readonly providerThread: { readonly id: ProviderAdapterTurnStartError["providerThreadId"] };
}) =>
  new ProviderAdapterTurnStartError({
    driver: input.session.driver,
    threadId: input.run.threadId,
    providerThreadId: input.providerThread.id,
    runId: input.run.id,
    detail: START_AUTHORITY_ENDED,
  });

/** What a start-only dispatch writes on the run it plans. */
export const startOnlyRunFields = (command: {
  readonly startOnly?: boolean | undefined;
  readonly authorityEndsAt?: number | undefined;
}): Pick<OrchestrationV2Run, "startOnly" | "authorityEndsAt"> =>
  command.startOnly !== true
    ? {}
    : {
        startOnly: true,
        ...(command.authorityEndsAt === undefined
          ? {}
          : { authorityEndsAt: command.authorityEndsAt }),
      };

/**
 * Whether a provider took a prompt from `run`: a provider turn is recorded for
 * one of its attempts (the test `continuationFailedBeforePrompt` uses).
 */
export const runReachedProvider = (
  run: Pick<OrchestrationV2Run, "id" | "activeAttemptId">,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">> = [],
): boolean => {
  const attemptIds = new Set<string | null>([
    run.activeAttemptId,
    ...attempts.flatMap((attempt) => (attempt.runId === run.id ? [attempt.id] : [])),
  ]);
  return providerTurns.some(
    (turn) => turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId),
  );
};

/** A start-only run that no provider took, which nothing may start again. */
export const unofferedStartOnlyRun = (
  run: Pick<OrchestrationV2Run, "id" | "activeAttemptId" | "startOnly"> | undefined,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">> = [],
): boolean => run?.startOnly === true && !runReachedProvider(run, providerTurns, attempts);

/**
 * Whether a server-created dispatch continues a start-only run no provider
 * took: a restart continuation names its run; the fallback, retry, resume and
 * context-recovery continuations continue the thread's latest run.
 */
export const continuesUnofferedStartOnlyRun = (
  command: {
    readonly commandId: string;
    readonly messageId: string;
    readonly creationSource?: string | undefined;
    readonly restartContinuationOfRunId?: string | undefined;
  },
  projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
    readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  },
): boolean => {
  if (command.creationSource !== "server") return false;
  const recovery =
    isServerContinuation(command as Parameters<typeof isServerContinuation>[0]) ||
    [CONTEXT_COMPACT_MESSAGE_PREFIX, CONTEXT_RETRY_MESSAGE_PREFIX].some((prefix) =>
      command.messageId.startsWith(prefix),
    );
  const continued =
    command.restartContinuationOfRunId !== undefined
      ? projection.runs.find((run) => run.id === command.restartContinuationOfRunId)
      : recovery
        ? projection.runs.reduce<OrchestrationV2Run | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          )
        : undefined;
  return unofferedStartOnlyRun(continued, projection.providerTurns, projection.attempts);
};
