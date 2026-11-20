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

import { latestExecutedRun } from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { CommitAuthorityEnded } from "./EventSink.ts";
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

/** The deadline a dispatch hands its commit, checked last inside the transaction. */
export const commitDeadline = (command: object): { readonly authorityEndsAt?: number } =>
  "authorityEndsAt" in command && typeof command.authorityEndsAt === "number"
    ? { authorityEndsAt: command.authorityEndsAt }
    : {};

/** A commit rolled back at its deadline reads as the unrecorded deadline refusal. */
export const deadlineRefusal = <E extends { readonly cause?: unknown }>(
  error: E,
  refuse: (cause: string) => E,
): E =>
  (error.cause as { readonly cause?: unknown } | undefined)?.cause instanceof CommitAuthorityEnded
    ? refuse(START_AUTHORITY_ENDED)
    : error;

/** A start-only run that no provider took, which nothing may start again. */
export const unofferedStartOnlyRun = (
  run: Pick<OrchestrationV2Run, "id" | "activeAttemptId" | "startOnly"> | undefined,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">> = [],
): boolean => run?.startOnly === true && !runReachedProvider(run, providerTurns, attempts);

/** Whether `id` names run `runId` as a whole part, so ordinal 1 never matches ordinal 12. */
const namesRun = (id: string, runId: string): boolean =>
  id.endsWith(`:${runId}`) || id.includes(`:${runId}:`);

/**
 * Whether a server-created dispatch continues a start-only run no provider
 * took. The sources are the runs it names (by field, or by id inside its
 * message or command id) and, for a recovery, the thread's latest run and
 * its last run that ran. Held queued runs never ran, so they never stand
 * in for a source. Every hop from an unoffered run is refused here, so no
 * later continuation can carry its text.
 */
export const continuesUnofferedStartOnlyRun = (
  command: {
    readonly commandId: string;
    readonly messageId: string;
    readonly creationSource?: string | undefined;
    readonly restartContinuationOfRunId?: string | undefined;
    readonly usageLimitContinuationOfRunId?: string | undefined;
    readonly manualContinuationOfRunId?: string | undefined;
  },
  projection: {
    readonly thread?: { readonly latestRunId: string | null } | null;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
    readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  },
): boolean => {
  if (command.creationSource !== "server") return false;
  const named = [
    command.restartContinuationOfRunId,
    command.usageLimitContinuationOfRunId,
    command.manualContinuationOfRunId,
  ];
  const recovery =
    isServerContinuation(command as Parameters<typeof isServerContinuation>[0]) ||
    [CONTEXT_COMPACT_MESSAGE_PREFIX, CONTEXT_RETRY_MESSAGE_PREFIX].some((prefix) =>
      command.messageId.startsWith(prefix),
    );
  if (!recovery && named.every((id) => id === undefined)) return false;
  const latest = recovery ? latestExecutedRun(projection.runs) : null;
  return projection.runs.some(
    (run) =>
      (named.includes(run.id) ||
        run === latest ||
        (recovery && run.id === projection.thread?.latestRunId) ||
        (recovery && (namesRun(command.messageId, run.id) || namesRun(command.commandId, run.id)))) &&
      unofferedStartOnlyRun(run, projection.providerTurns, projection.attempts),
  );
};

/**
 * An earlier run on this provider thread that failed or was interrupted
 * before any provider took it: its turn items ride with the next turn there.
 * A start-only run's never do; its message goes again only as a send checked
 * again by its receiver.
 */
export const missedBeforeRun = (
  source: OrchestrationV2Run,
  run: Pick<OrchestrationV2Run, "ordinal">,
  providerThreadId: string,
  deliveredAttemptIds: ReadonlySet<string | null>,
): boolean =>
  source.ordinal < run.ordinal &&
  source.providerThreadId === providerThreadId &&
  (source.status === "failed" || source.status === "interrupted") &&
  source.startOnly !== true &&
  !deliveredAttemptIds.has(source.activeAttemptId);

/** A run restarted by a steer: the steer is its sender's own send, so no deadline carries over. */
export const withoutStartOnly = ({
  startOnly: _startOnly,
  authorityEndsAt: _authorityEndsAt,
  ...run
}: OrchestrationV2Run): OrchestrationV2Run => run;
