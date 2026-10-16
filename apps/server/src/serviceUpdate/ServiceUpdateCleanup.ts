/**
 * Clears what Stop leaves behind before a service update, so the update helper's
 * idle check (`_read_state` in `scripts/studio-fleet/update.py`) passes:
 *
 * - a run stuck preparing, starting or running ends `interrupted`, so the person
 *   can continue it by hand after the update; a `waiting` run, whose turn output is
 *   already saved, ends `completed` without its checkpoint, and the turn says
 *   so, unless that checkpoint is being written: then it is left to finish;
 * - a runtime request still pending is cancelled with a reason; its question or
 *   approval stays in the thread's history;
 * - a provider session row that says it works but has no live session behind it
 *   is recorded as stopped, the way a release records it;
 * - every effect the outbox has not settled is cancelled and its worker told,
 *   except a rollback or checkpoint already running, which is left to finish.
 *
 * Each write goes through the event sink, so projections, clients and the
 * terminal-run reactions see it like any other change.
 *
 * @module ServiceUpdateCleanup
 */
import {
  CommandId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

/** Run statuses that are neither queued nor terminal. */
export const STUCK_RUN_STATUSES = ["preparing", "starting", "running", "waiting"] as const;
/** Provider session statuses update.py counts as working. */
export const WORKING_SESSION_STATUSES = ["running", "working", "connecting", "starting"] as const;
/** The command a finished turn's checkpoint runs under (`RunExecutionService` names it so). */
export const CHECKPOINT_CAPTURE_COMMAND_PREFIX = "command:effect:checkpoint.capture:";
/** Shown on a finished turn whose checkpoint the update could not wait for. */
export const CHECKPOINT_SKIPPED_MESSAGE =
  "This turn's checkpoint was skipped to install the SpecWithCode update, so it cannot be rolled back.";

const SETTLED_NODE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const SETTLED_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "superseded",
]);

export type ServiceUpdateCleanupError =
  | SqlError.SqlError
  | EventSink.EventSinkV2Error
  | IdAllocator.IdAllocatorV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | EffectOutbox.EffectOutboxError;

export interface ServiceUpdateCleanupShape {
  /** Ends runs still preparing, starting, running or waiting. */
  readonly finalizeStuckRuns: (input: {
    readonly nonce: string;
    readonly reason: string;
  }) => Effect.Effect<
    { readonly interrupted: number; readonly completed: number },
    ServiceUpdateCleanupError
  >;
  /** Cancels every runtime request still pending. Returns how many. */
  readonly cancelPendingRequests: (input: {
    readonly nonce: string;
    readonly reason: string;
  }) => Effect.Effect<number, ServiceUpdateCleanupError>;
  /**
   * Questions still pending that were asked as a plain message: the orchestrator
   * dismisses these itself (`thread.user-input.dismiss`), the way the person would.
   */
  readonly listMessageModeRequests: Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: RuntimeRequestId }>,
    ServiceUpdateCleanupError
  >;
  /** Records working session rows with no live session as stopped. Returns how many. */
  readonly reconcileOrphanedSessions: Effect.Effect<number, ServiceUpdateCleanupError>;
  /** Cancels every unsettled effect and signals its worker. Returns what it cancelled. */
  readonly cancelUnsettledEffects: (input: {
    readonly reason: string;
  }) => Effect.Effect<ReadonlyArray<EffectOutbox.CancelledEffect>, ServiceUpdateCleanupError>;
}

export class ServiceUpdateCleanup extends Context.Service<
  ServiceUpdateCleanup,
  ServiceUpdateCleanupShape
>()("specweave-studio/serviceUpdate/ServiceUpdateCleanup") {}

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ");

const groupByThread = <Row extends { readonly thread_id: string }>(rows: ReadonlyArray<Row>) => {
  const grouped = new Map<string, Array<Row>>();
  for (const row of rows) {
    const existing = grouped.get(row.thread_id);
    if (existing === undefined) grouped.set(row.thread_id, [row]);
    else existing.push(row);
  }
  return grouped;
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;

  const commit = (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) =>
    input.events.length === 0
      ? Effect.void
      : Effect.flatMap(DateTime.now, (acceptedAt) =>
          eventSink.commitCommand({ ...input, acceptedAt, effects: [] }),
        ).pipe(Effect.asVoid);

  const finalizeStuckRuns: ServiceUpdateCleanupShape["finalizeStuckRuns"] = ({ nonce, reason }) =>
    Effect.gen(function* () {
      // A finished turn whose checkpoint is being written is left to finish it:
      // stopping the capture partway would leave its git work half done.
      const rows = yield* sql.unsafe<{ readonly run_id: string; readonly thread_id: string }>(`
        SELECT r.run_id, r.thread_id FROM orchestration_v2_projection_runs r
         WHERE r.status IN (${quoted(STUCK_RUN_STATUSES)})
           AND NOT (r.status = 'waiting' AND EXISTS (
             SELECT 1 FROM orchestration_v2_effect_outbox e
              WHERE e.command_id = '${CHECKPOINT_CAPTURE_COMMAND_PREFIX}' || r.run_id
                AND e.status = 'running'))
      `);
      let interrupted = 0;
      let completed = 0;
      for (const [rawThreadId, threadRows] of groupByThread(rows)) {
        const threadId = ThreadId.make(rawThreadId);
        const commandId = CommandId.make(`service-update:${nonce}:finalize:${threadId}`);
        const records = yield* projections.getThreadRecords(
          threadId,
          ["runs", "attempts", "nodes", "turnItems"],
          { turnItemTypes: ["run_interrupt_request"] },
        );
        const now = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        let waitingRuns = 0;
        for (const row of threadRows) {
          const run = records.runs.find((candidate) => candidate.id === row.run_id);
          if (
            run === undefined ||
            !(STUCK_RUN_STATUSES as ReadonlyArray<string>).includes(run.status)
          )
            continue;
          // Its turn output is saved; only the checkpoint is skipped.
          const status: OrchestrationV2Run["status"] =
            run.status === "waiting" ? "completed" : "interrupted";
          if (status === "completed") waitingRuns += 1;
          const rootNode = records.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const base = {
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
          };
          const attempt = records.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          if (attempt !== undefined && !SETTLED_ATTEMPT_STATUSES.has(attempt.status)) {
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "run-attempt.updated",
              ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
              payload: {
                ...attempt,
                status: status === "completed" ? "completed" : "interrupted",
                completedAt: now,
              },
            });
          }
          if (rootNode !== undefined && !SETTLED_NODE_STATUSES.has(rootNode.status)) {
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "node.updated",
              nodeId: rootNode.id,
              payload: { ...rootNode, status, completedAt: now },
            });
          }
          // A newer delivery cohort write must not be replaced by this snapshot;
          // the projection keeps the field when the payload leaves it out.
          const { delegatedCompletion: _delegatedCompletion, ...runWithoutCohort } = run;
          events.push({
            ...base,
            id: yield* ids.allocate.event({ threadId, commandId }),
            type: "run.updated",
            ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
            payload: { ...runWithoutCohort, status, completedAt: now },
          });
          // Marks the run as stopped for the update, so it resumes once the
          // service is back. A Stop already recorded (the user's) is kept.
          if (
            status === "interrupted" &&
            run.rootNodeId !== null &&
            run.providerThreadId !== null &&
            !records.turnItems.some(
              (item) => item.runId === run.id && item.type === "run_interrupt_request",
            )
          ) {
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "turn-item.updated",
              nodeId: run.rootNodeId,
              payload: {
                id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-request" }),
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: run.providerThreadId,
                providerTurnId: rootNode?.providerTurnId ?? null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: run.ordinal * 100 + 98,
                status: "completed",
                title: "Interrupt requested",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "run_interrupt_request",
                message: reason,
                cause: "service_update",
              },
            });
          }
          // Where the checkpoint would have been, so the turn shows it has none.
          if (status === "completed" && run.checkpointId === null) {
            events.push({
              ...base,
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "turn-item.updated",
              ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
              payload: {
                id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "checkpoint-skipped" }),
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: run.providerThreadId,
                providerTurnId: rootNode?.providerTurnId ?? null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: run.ordinal * 100 + 99,
                status: "completed",
                title: "Checkpoint skipped",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "system_notice",
                message: CHECKPOINT_SKIPPED_MESSAGE,
              },
            });
          }
          if (status === "completed") completed += 1;
          else interrupted += 1;
        }
        yield* commit({
          commandId,
          threadId,
          commandType: "service-update.finalize-runs",
          events,
          cancelUnsettledEffects: {
            effectTypes: [
              "provider-turn.start",
              "provider-turn.restart",
              "provider-runtime.continue",
              ...(waitingRuns > 0 ? (["checkpoint.capture"] as const) : []),
            ],
            reason,
          },
        });
      }
      return { interrupted, completed };
    });

  const cancelPendingRequests: ServiceUpdateCleanupShape["cancelPendingRequests"] = ({
    nonce,
    reason,
  }) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly runtime_request_id: string; readonly thread_id: string }>`
        SELECT runtime_request_id, thread_id FROM orchestration_v2_projection_runtime_requests
         WHERE status = 'pending'
      `;
      let cancelled = 0;
      for (const [rawThreadId, threadRows] of groupByThread(rows)) {
        const threadId = ThreadId.make(rawThreadId);
        const commandId = CommandId.make(`service-update:${nonce}:requests:${threadId}`);
        const pendingIds = new Set(threadRows.map((row) => row.runtime_request_id));
        const records = yield* projections.getThreadRecords(
          threadId,
          ["runtimeRequests", "nodes", "turnItems"],
          { turnItemTypes: ["approval_request", "user_input_request"] },
        );
        const now = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const request of records.runtimeRequests) {
          if (request.status !== "pending" || !pendingIds.has(request.id)) continue;
          const node = records.nodes.find((candidate) => candidate.id === request.nodeId);
          const runId = node?.runId ?? null;
          events.push({
            id: yield* ids.allocate.event({ threadId, commandId }),
            type: "runtime-request.updated",
            threadId,
            ...(runId === null ? {} : { runId }),
            nodeId: request.nodeId,
            occurredAt: now,
            payload: {
              ...request,
              status: "cancelled",
              resolvedAt: now,
              responseCapability: { type: "not_resumable", reason },
            },
          });
          if (node !== undefined && !SETTLED_NODE_STATUSES.has(node.status)) {
            events.push({
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "node.updated",
              threadId,
              ...(runId === null ? {} : { runId }),
              nodeId: node.id,
              occurredAt: now,
              payload: { ...node, status: "cancelled", completedAt: now },
            });
          }
          const item = records.turnItems.find(
            (candidate) =>
              (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
              candidate.requestId === request.id,
          );
          if (item !== undefined) {
            events.push({
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "turn-item.updated",
              threadId,
              ...(item.runId === null ? {} : { runId: item.runId }),
              ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
              occurredAt: now,
              payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
            });
          }
          cancelled += 1;
        }
        yield* commit({
          commandId,
          threadId,
          commandType: "service-update.cancel-requests",
          events,
        });
      }
      return cancelled;
    });

  const listMessageModeRequests: ServiceUpdateCleanupShape["listMessageModeRequests"] = sql<{
    readonly runtime_request_id: string;
    readonly thread_id: string;
  }>`
    SELECT runtime_request_id, thread_id FROM orchestration_v2_projection_runtime_requests
     WHERE status = 'pending' AND kind = 'user_input'
       AND json_extract(payload_json, '$.responseCapability.type') = 'message'
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        threadId: ThreadId.make(row.thread_id),
        requestId: RuntimeRequestId.make(row.runtime_request_id),
      })),
    ),
  );

  const reconcileOrphanedSessions: ServiceUpdateCleanupShape["reconcileOrphanedSessions"] =
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<{
        readonly provider_session_id: string;
        readonly thread_id: string | null;
      }>(`
        SELECT provider_session_id, thread_id FROM orchestration_v2_projection_provider_sessions
         WHERE status IN (${quoted(WORKING_SESSION_STATUSES)})
      `);
      let stopped = 0;
      for (const row of rows) {
        // A row with no thread has no stream to record the change on; it stays a blocker.
        if (row.thread_id === null) continue;
        const providerSessionId = ProviderSessionId.make(row.provider_session_id);
        const live = yield* providerSessions
          .get(providerSessionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(live)) continue;
        const threadId = ThreadId.make(row.thread_id);
        const records = yield* projections.getThreadRecords(threadId, ["providerSessions"]);
        const session = records.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        if (session === undefined) continue;
        const now = yield* DateTime.now;
        // The same record a release writes for a session it closed.
        yield* eventSink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId, providerSessionId }),
              type: "provider-session.updated",
              threadId,
              driver: session.driver,
              providerInstanceId: session.providerInstanceId,
              occurredAt: now,
              payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
            },
          ],
        });
        stopped += 1;
      }
      return stopped;
    });

  const cancelUnsettledEffects: ServiceUpdateCleanupShape["cancelUnsettledEffects"] = ({
    reason,
  }) => outbox.cancelAllUnsettled({ reason });

  return ServiceUpdateCleanup.of({
    finalizeStuckRuns,
    cancelPendingRequests,
    listMessageModeRequests,
    reconcileOrphanedSessions,
    cancelUnsettledEffects,
  });
});

export const layer = Layer.effect(ServiceUpdateCleanup, make);
