import { answeredRuntimeRequestCopy } from "@specweave-studio/shared/projectAttention";
/**
 * Records what a forced "Update now" is about to close, and asks it again once
 * the update is over (increment 0991, owner decision D-03).
 *
 * `captureOpenRequests` reads every question and approval still waiting on the
 * person, with what it asked, so the drain can record them
 * (`ServiceUpdateClosedQuestions`) before it stops a turn or cancels anything.
 *
 * The reopen runs once the update is over: this service is not held, no drain
 * is under way, and the desktop's install request is no longer open (between
 * two drains of one update, the hold can lapse while the request still waits:
 * nothing is reopened then, only to be closed again). That is right after the
 * restart that installed the update, once the helper's install gate has
 * opened (`ServiceUpdateHold.isHeld` covers both), and in the old process when
 * the update was cancelled, refused or expired. A rolled-back update puts the
 * old release back; if that release does not know the record it ignores the
 * file, and the next release that knows it reopens what is left when it
 * starts. What an automatic install's stale-wait sweep closed
 * (`reopenAfterRestart`) waits until that install is no longer under way
 * (`automaticInstallUnderway`): asked again before the install, it would hold
 * that install again, and a restart that was not the install does not count.
 * Once installed, failed or cancelled, it is asked again, in whichever
 * process. A pass and a drain never overlap: a drain waits for the pass under
 * way, which stops after the entry it is on.
 *
 * Each recorded request is reopened once, and only when the update closed it
 * (an answered one is left alone):
 *
 * - a note on the turn that asked quotes the closed question or approval, so
 *   the person sees what the update closed;
 * - where the project continues threads after restarts and a restart
 *   continuation of that turn has started, the continuation
 *   (`RestartContinuation`) tells the agent its question was closed and to ask
 *   it again, and the agent's new question is what lands in Needs you. The
 *   entry waits for that continuation to end: one whose agent asked nothing
 *   (it failed, or went on without asking) gets the card after all, so the
 *   thread is in Needs you either way. One that should start is waited for up
 *   to `CONTINUATION_WAIT_MS`; a process that never restarted (a cancelled
 *   update) continues nothing;
 * - otherwise the question is asked again as a question card answered by
 *   message (an approval, whose agent process is gone, becomes a "go ahead?"
 *   question), so the thread shows "Answer needed" in Needs you and the answer
 *   reaches the agent as the next message.
 *
 * Both writes use ids derived from the closed request (the note's command id,
 * the card's request id), so reopening twice changes nothing; the entry is
 * then marked reopened at once, with how (a continuation leaves out one asked
 * as a card, and one whose card exists). An entry whose turn is not known is
 * asked again on the thread's latest turn; one whose thread is gone is marked
 * without a reopen, one whose thread cannot be read now is tried again, and
 * one that keeps failing is given up after `MAX_REOPEN_ATTEMPTS` passes.
 *
 * @module ServiceUpdateReopenQuestions
 */
import {
  CommandId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@specweave-studio/contracts";
import { runRanAfter } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import { cancelledForUpdate } from "../orchestration-v2/RestartQueueHold.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";
import * as ServiceUpdateHold from "./ServiceUpdateHold.ts";

/** How often the service looks for closed questions to reopen. */
export const REOPEN_POLL_MS = 10_000;
/** Passes an entry may fail before it is given up (and logged). */
export const MAX_REOPEN_ATTEMPTS = 5;
/** How long a restart continuation that should ask again is waited for before a card asks instead. */
export const CONTINUATION_WAIT_MS = 120_000;
/** Between the closed request's card and the interrupt notice on the same turn. */
const NOTE_ORDINAL = 97;
/** Run statuses of a turn that has ended. */
const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const isProjectionThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);
/** A thread that is not there (deleted), as opposed to one that cannot be read now. */
export const isThreadNotFound = (error: unknown): boolean =>
  isProjectionThreadNotFound(error) ||
  (typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    isProjectionThreadNotFound((error as { readonly cause: unknown }).cause));

type Threads = ThreadManagementService.ThreadManagementService["Service"];

/**
 * Every question and approval still waiting on the person, with what it asked,
 * as the record keeps it. A thread that cannot be read is recorded from its
 * request row alone.
 */
export const captureOpenRequests = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threads: Pick<Threads, "getThreadRecords">;
  /** Only these threads' requests. */
  readonly threadIds?: ReadonlyArray<string>;
  /** Requests already captured, which are not read again. */
  readonly skip?: (requestId: string) => boolean;
}) =>
  Effect.gen(function* () {
    const rows = yield* input.sql<{
      readonly runtime_request_id: string;
      readonly thread_id: string;
      readonly kind: string;
      readonly created_at: string | null;
    }>`
      SELECT runtime_request_id, thread_id, kind, created_at
        FROM orchestration_v2_projection_runtime_requests
       WHERE status = 'pending'
       ORDER BY created_at, runtime_request_id
    `;
    const closedAt = DateTime.formatIso(yield* DateTime.now);
    const byThread = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      if (!ClosedQuestions.isPersonRequestKind(row.kind)) continue;
      if (input.threadIds !== undefined && !input.threadIds.includes(row.thread_id)) continue;
      if (input.skip?.(row.runtime_request_id) === true) continue;
      const list = byThread.get(row.thread_id) ?? [];
      list.push(row);
      byThread.set(row.thread_id, list);
    }
    const entries: Array<ClosedQuestions.ClosedQuestion> = [];
    for (const [threadId, threadRows] of byThread) {
      const records = yield* input.threads
        .getThreadRecords(ThreadId.make(threadId), ["runtimeRequests", "nodes", "turnItems"], {
          turnItemTypes: ["user_input_request", "approval_request"],
        })
        .pipe(
          Effect.asSome,
          Effect.catchCause((cause) =>
            Effect.logWarning("service-update.closed-questions.read-failed", {
              threadId,
              cause,
            }).pipe(Effect.as(Option.none())),
          ),
        );
      for (const row of threadRows) {
        const found = Option.getOrUndefined(records);
        const request = found?.runtimeRequests.find(
          (candidate) => candidate.id === row.runtime_request_id,
        );
        const item = found?.turnItems.find(
          (candidate) =>
            (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
            candidate.requestId === row.runtime_request_id,
        );
        const node =
          request === undefined
            ? undefined
            : found?.nodes.find((candidate) => candidate.id === request.nodeId);
        const described = ClosedQuestions.describeClosedRequest({ kind: row.kind as never }, item);
        entries.push({
          requestId: row.runtime_request_id,
          threadId,
          threadTitle: found?.thread.title ?? null,
          runId: node?.runId ?? item?.runId ?? null,
          kind: row.kind,
          text: described.text,
          ...(described.questions === undefined ? {} : { questions: described.questions }),
          askedAt: row.created_at,
          closedAt,
          reopenedAt: null,
        });
      }
    }
    return entries;
  });

/**
 * Whether a restart continues the turn that asked: the project continues
 * threads after restarts, and that turn is the thread's latest and was
 * interrupted for the update, or a continuation of it already started.
 */
type RunOrder = Pick<
  OrchestrationV2Run,
  "id" | "status" | "ordinal" | "completedAt" | "cancelledForUpdate"
>;

/**
 * The thread's latest turn that has started (a queued one has not, nor one the
 * update cancelled while it was queued).
 */
function latestRun<R extends RunOrder>(runs: ReadonlyArray<R>): R | undefined {
  return runs.reduce<R | undefined>(
    (current, candidate) =>
      candidate.status !== "queued" &&
      !cancelledForUpdate(candidate) &&
      (current === undefined || runRanAfter(candidate, current))
        ? candidate
        : current,
    undefined,
  );
}

export function continuationExpected(
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "status" | "restartContinuationOfRunId" | "ordinal" | "completedAt"
    >
  >,
  runId: string,
  continues: boolean,
): boolean {
  if (!continues) return false;
  if (runs.some((run) => run.restartContinuationOfRunId === runId)) return true;
  const latest = latestRun(runs);
  return latest?.id === runId && latest.status === "interrupted";
}

/**
 * Whether the thread asked the person anything since `since` (a turn's
 * start): a question or approval of its own, not a card asking a closed one.
 */
export function askedSince(
  requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "createdAt">>,
  since: DateTime.Utc,
  closedRequestId: string,
): boolean {
  const sinceMs = DateTime.toEpochMillis(since);
  return requests.some(
    (request) =>
      request.id !== closedRequestId &&
      ClosedQuestions.isPersonRequestKind(request.kind) &&
      !request.id.startsWith("update-reopen") &&
      DateTime.toEpochMillis(request.createdAt) >= sinceMs,
  );
}

/** What one entry's reopen did, for the log and the tests. */
export type ReopenOutcome =
  | { readonly type: "reopened"; readonly by: ClosedQuestions.ReopenedBy }
  | { readonly type: "skipped"; readonly reason: string }
  /** Not yet: looked at again on a later pass. */
  | { readonly type: "waiting"; readonly reason: string };

export const makeReopener = Effect.gen(function* () {
  const store = yield* ClosedQuestions.ServiceUpdateClosedQuestions;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const hold = yield* ServiceUpdateHold.optional;
  const holdService = yield* Effect.serviceOption(ServiceUpdateHold.ServiceUpdateHold);
  const installRequestOpen = Option.match(holdService, {
    onNone: () => Effect.succeed(false),
    onSome: (service) => service.installRequestOpen,
  });
  const automaticInstallUnderway = Option.match(holdService, {
    onNone: () => Effect.succeed(false),
    onSome: (service) => service.automaticInstallUnderway,
  });
  const attempts = new Map<string, number>();
  /** When this process first found an entry waiting on a continuation. */
  const awaitingSince = new Map<string, number>();

  const projectContinues = (projectId: Parameters<typeof resolveProjectSettings>[1]) =>
    Option.match(settings, {
      onNone: () => Effect.succeed(false),
      onSome: (service) =>
        service.getSettings.pipe(
          Effect.map(
            (current) =>
              resolveProjectSettings(current, projectId).settings.continueThreadsAfterServerUpdate,
          ),
          Effect.orElseSucceed(() => false),
        ),
    });

  const postNote = (
    entry: ClosedQuestions.ClosedQuestion,
    run: OrchestrationV2Run,
    by: ClosedQuestions.ReopenedBy,
  ) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(entry.threadId);
      const commandId = CommandId.make(`service-update:reopen:${entry.requestId}:note`);
      const now = yield* DateTime.now;
      const event: OrchestrationV2DomainEvent = {
        id: yield* ids.allocate.event({ threadId, commandId }),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        payload: {
          id: ids.derive.runSignalTurnItem({
            runId: run.id,
            signal: `update-closed-request:${entry.requestId}`,
          }),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: run.ordinal * 100 + NOTE_ORDINAL,
          status: "completed",
          title: "Closed by the update",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "system_notice",
          message: ClosedQuestions.closedQuestionNote(entry, by),
        },
      };
      // The command id makes a second commit of the same note a no-op.
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "service-update.reopen-question",
        acceptedAt: now,
        events: [event],
        effects: [],
      });
    });

  const askAgain = (
    entry: ClosedQuestions.ClosedQuestion,
    run: OrchestrationV2Run,
    rootNodeId: NodeId,
  ) =>
    threads.dispatch({
      type: "user_input_request.record",
      commandId: CommandId.make(`service-update:reopen:${entry.requestId}:card`),
      threadId: ThreadId.make(entry.threadId),
      runId: run.id,
      nodeId: rootNodeId,
      requestNodeId: NodeId.make(`node:update-reopen:${entry.requestId}`),
      // Recording a request id that exists already leaves it as it is. A
      // closed approval's card keeps an approval id, so a later automatic
      // install's stale-wait sweep can release it as it released the approval.
      requestId: RuntimeRequestId.make(ClosedQuestions.reopenCardRequestId(entry)),
      turnItemId: TurnItemId.make(`turn-item:update-reopen:${entry.requestId}`),
      questions: ClosedQuestions.reopenedQuestions(entry),
    });

  const reopenOne = (entry: ClosedQuestions.ClosedQuestion) =>
    Effect.gen(function* () {
      // In the process that closed it, the restart has not happened yet.
      const restarted = entry.closedIn !== store.bootId;
      // The automatic install it was released for still waits or installs.
      if (entry.reopenAfterRestart === true && (yield* automaticInstallUnderway))
        return { type: "waiting", reason: "install-pending" } as const;
      const records = yield* threads
        .getThreadRecords(ThreadId.make(entry.threadId), ["runs", "runtimeRequests"])
        .pipe(
          Effect.asSome,
          // Only a thread that is not there is gone; any other failure is tried again.
          Effect.catchIf(isThreadNotFound, () => Effect.succeedNone),
        );
      if (Option.isNone(records)) return { type: "skipped", reason: "thread-gone" } as const;
      const { thread, runs, runtimeRequests } = records.value;
      if (thread.archivedAt !== null || thread.deletedAt !== null)
        return { type: "skipped", reason: "thread-closed" } as const;
      const request = runtimeRequests.find((candidate) => candidate.id === entry.requestId);
      // Answered, or never closed (the drain stopped first): nothing to ask again.
      // A later drain that closes one still open records it afresh.
      if (request !== undefined && !ClosedQuestions.wasClosed(request))
        return { type: "skipped", reason: `request-${request.status}` } as const;
      if (answeredRuntimeRequestCopy({ id: entry.requestId }, runtimeRequests))
        return { type: "skipped", reason: "request-family-answered" } as const;

      // A turn not known when it was recorded (its thread could not be read):
      // the thread's latest turn asks again.
      const run =
        entry.runId === null
          ? latestRun(runs)
          : runs.find((candidate) => candidate.id === entry.runId);
      if (run === undefined || run.rootNodeId === null)
        return { type: "skipped", reason: "run-gone" } as const;
      let by: ClosedQuestions.ReopenedBy = "card";
      // Only a restart continues a turn, and only one that started asks again.
      if (
        restarted &&
        continuationExpected(runs, run.id, yield* projectContinues(thread.projectId))
      ) {
        const continuation = runs.find(
          (candidate) => candidate.restartContinuationOfRunId === run.id,
        );
        if (continuation !== undefined) {
          // Asked again by the agent while it runs; whether it did shows once it ends.
          if (!ENDED_RUN_STATUSES.has(continuation.status))
            return { type: "waiting", reason: "continuation-running" } as const;
          // The agent asked (a question or approval of its own): that is in Needs you.
          // It failed, or went on without asking: the card asks after all.
          if (askedSince(runtimeRequests, continuation.requestedAt, entry.requestId)) by = "agent";
        } else {
          const now = yield* Clock.currentTimeMillis;
          const since = awaitingSince.get(entry.requestId) ?? now;
          awaitingSince.set(entry.requestId, since);
          // The continuation can skip the turn or fail: a card asks after all.
          if (now - since < CONTINUATION_WAIT_MS)
            return { type: "waiting", reason: "continuation" } as const;
        }
      }
      yield* postNote(entry, run, by);
      if (by === "card") yield* askAgain(entry, run, run.rootNodeId);
      return { type: "reopened", by } as const;
    });

  /** Whether nothing should be reopened now: held, or a drain under way. */
  const updateUnderway = Effect.gen(function* () {
    return (yield* hold.isHeld) || (yield* store.isDraining);
  });

  /**
   * One pass over what is recorded and not reopened; nothing while held or
   * draining. A drain that starts during the pass stops it after the entry it
   * is on, and each entry is marked as soon as it is reopened.
   */
  const reopenPending = store.reopening(
    Effect.gen(function* () {
      if (yield* updateUnderway) return [];
      const pending = yield* store.pending;
      if (pending.length === 0) return [];
      // The update these were closed for still waits for its install.
      if (yield* installRequestOpen) return [];
      const outcomes: Array<{ readonly requestId: string; readonly outcome: ReopenOutcome }> = [];
      const finish = (requestId: string, by: ClosedQuestions.ReopenedBy | null) =>
        Effect.gen(function* () {
          attempts.delete(requestId);
          awaitingSince.delete(requestId);
          // A mark that cannot be written is tried again on the next pass; the
          // writes that reopened it repeat nothing then.
          if (!(yield* store.markReopened([{ requestId, by }])))
            yield* Effect.logWarning("service-update.closed-questions.mark-failed", { requestId });
        });
      for (const entry of pending) {
        if (yield* updateUnderway) break;
        const result = yield* reopenOne(entry).pipe(Effect.result);
        if (result._tag === "Success") {
          if (result.success.type === "waiting") continue;
          yield* finish(
            entry.requestId,
            result.success.type === "reopened" ? result.success.by : null,
          );
          outcomes.push({ requestId: entry.requestId, outcome: result.success });
          continue;
        }
        const failures = (attempts.get(entry.requestId) ?? 0) + 1;
        attempts.set(entry.requestId, failures);
        yield* Effect.logWarning("service-update.closed-questions.reopen-failed", {
          requestId: entry.requestId,
          threadId: entry.threadId,
          attempt: failures,
          cause: result.failure,
        });
        if (failures >= MAX_REOPEN_ATTEMPTS) {
          yield* finish(entry.requestId, null);
          outcomes.push({
            requestId: entry.requestId,
            outcome: { type: "skipped", reason: "gave-up" },
          });
        }
      }
      if (outcomes.length > 0)
        yield* Effect.logWarning("service-update.closed-questions.reopened", {
          reopened: outcomes.filter((entry) => entry.outcome.type === "reopened").length,
          skipped: outcomes.filter((entry) => entry.outcome.type === "skipped").length,
        });
      return outcomes;
    }),
  );

  return { reopenOne, reopenPending };
});

/** Looks right after start, then every `REOPEN_POLL_MS`. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reopener = yield* makeReopener;
    yield* reopener.reopenPending.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("service-update.closed-questions.pass-failed", { cause }),
      ),
      Effect.andThen(Effect.sleep(Duration.millis(REOPEN_POLL_MS))),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
