import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as Cleanup from "./ServiceUpdateCleanup.ts";
import * as Preparation from "./ServiceUpdatePreparation.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process in the cleanup fixture"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:update-cleanup");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerHarness = ProviderReplayHarness.layerWithRegistry(
  { name: "update-cleanup" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerStores = Layer.mergeAll(
  IdAllocator.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
).pipe(Layer.provide(layerDatabase));
const layerTest = Cleanup.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(layerHarness, layerStores, layerDatabase)),
);

/** The rows `_read_state` in update.py counts as busy. */
const busyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const terminal = Preparation.TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(", ");
  const working = Preparation.WORKING_SESSION_STATUSES.map((status) => `'${status}'`).join(", ");
  const effects = Preparation.TERMINAL_EFFECT_STATUSES.map((status) => `'${status}'`).join(", ");
  const rows = yield* sql.unsafe<{ readonly kind: string; readonly count: number }>(`
    SELECT 'run' AS kind, COUNT(*) AS count FROM orchestration_v2_projection_runs
     WHERE status NOT IN (${terminal})
    UNION ALL SELECT 'request', COUNT(*) FROM orchestration_v2_projection_runtime_requests
     WHERE status = 'pending'
    UNION ALL SELECT 'effect', COUNT(*) FROM orchestration_v2_effect_outbox
     WHERE status IS NULL OR status NOT IN (${effects})
    UNION ALL SELECT 'session', COUNT(*) FROM orchestration_v2_projection_provider_sessions
     WHERE status IN (${working})
  `);
  return Object.fromEntries(rows.map((row) => [row.kind, Number(row.count)]));
});

it.effect("ends stuck runs, cancels requests and effects, and stops orphaned sessions", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const cleanup = yield* Cleanup.ServiceUpdateCleanup;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:update-cleanup");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-update-cleanup"),
      threadId,
      projectId,
      title: "Cleanup",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

    // A session row that says it works, with no live session behind it.
    const sessionId = ProviderSessionId.make("session:orphan");
    yield* projections.apply({
      id: EventId.make("attach-orphan"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "running",
        cwd: "/repo",
        model: "gpt-5.1-codex",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });

    // A run that never reached its provider, and one whose output is saved.
    for (const [ordinal, status] of [
      [1, "starting"],
      [2, "waiting"],
    ] as const) {
      const runId = RunId.make(`run:${status}`);
      const nodeId = NodeId.make(`node:${status}`);
      yield* projections.apply({
        id: EventId.make(`node:${status}`),
        type: "node.updated",
        threadId,
        runId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status: status === "waiting" ? "waiting" : "running",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`run:${status}`),
        type: "run.updated",
        threadId,
        runId,
        nodeId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${status}`),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }

    // A pending approval left behind by an ended run.
    const requestId = RuntimeRequestId.make("request:left");
    const requestNodeId = NodeId.make("node:request");
    yield* projections.apply({
      id: EventId.make("request:left"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: requestNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("node:request"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestNodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: requestNodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("item:request"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:request"),
        threadId,
        runId: null,
        nodeId: requestNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        questions: [],
      },
    });

    // An effect nobody will run.
    yield* outbox.enqueue([
      {
        id: "effect:left",
        commandId: CommandId.make("effect-left"),
        threadId,
        request: { type: "terminal.cleanup" },
      },
    ]);

    assert.deepEqual(yield* busyRows, { run: 2, request: 1, effect: 1, session: 1 });

    assert.deepEqual(
      yield* cleanup.finalizeStuckRuns({ nonce: "test", reason: Preparation.STOP_REASON }),
      { interrupted: 1, completed: 1 },
    );
    assert.equal(
      yield* cleanup.cancelPendingRequests({ nonce: "test", reason: Preparation.STOP_REASON }),
      1,
    );
    // This request was asked live, so the orchestrator cannot dismiss it.
    assert.deepEqual(yield* cleanup.listMessageModeRequests, []);
    assert.equal(yield* cleanup.reconcileOrphanedSessions, 1);
    assert.deepEqual(
      (yield* cleanup.cancelUnsettledEffects({ reason: Preparation.STOP_REASON })).map((effect) => [
        effect.effectId,
        effect.effectType,
        effect.threadId,
      ]),
      [["effect:left", "terminal.cleanup", threadId]],
    );

    assert.deepEqual(yield* busyRows, { run: 0, request: 0, effect: 0, session: 0 });

    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "nodes", "runtimeRequests", "turnItems", "providerSessions"],
      { turnItemTypes: ["user_input_request", "system_notice"] },
    );
    const statusOf = <T extends { readonly id: string; readonly status: string }>(
      rows: ReadonlyArray<T>,
      id: string,
    ) => rows.find((row) => row.id === id)?.status;
    // The interrupted run can be continued; the saved one is complete.
    assert.equal(statusOf(records.runs, "run:starting"), "interrupted");
    assert.equal(statusOf(records.runs, "run:waiting"), "completed");
    assert.equal(statusOf(records.nodes, "node:starting"), "interrupted");
    assert.equal(statusOf(records.nodes, "node:waiting"), "completed");
    assert.equal(statusOf(records.runtimeRequests, "request:left"), "cancelled");
    assert.equal(statusOf(records.nodes, "node:request"), "cancelled");
    assert.equal(statusOf(records.turnItems, "item:request"), "cancelled");
    assert.equal(statusOf(records.providerSessions, "session:orphan"), "stopped");
    // The completed turn says it has no checkpoint to roll back to.
    const notices = records.turnItems.filter((item) => item.type === "system_notice");
    assert.deepEqual(
      notices.map((item) => [item.runId, item.type === "system_notice" ? item.message : null]),
      [[RunId.make("run:waiting"), Cleanup.CHECKPOINT_SKIPPED_MESSAGE]],
    );

    // A second pass finds nothing to do.
    assert.deepEqual(
      yield* cleanup.finalizeStuckRuns({ nonce: "again", reason: Preparation.STOP_REASON }),
      { interrupted: 0, completed: 0 },
    );
    assert.equal(
      yield* cleanup.cancelPendingRequests({ nonce: "again", reason: Preparation.STOP_REASON }),
      0,
    );
    assert.equal(yield* cleanup.reconcileOrphanedSessions, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists questions asked as a plain message for the orchestrator to dismiss", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const cleanup = yield* Cleanup.ServiceUpdateCleanup;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:update-cleanup-message");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-update-cleanup-message"),
      threadId,
      projectId,
      title: "Question",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const requestId = RuntimeRequestId.make("request:message");
    yield* projections.apply({
      id: EventId.make("request:message"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: NodeId.make("node:message"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    assert.deepEqual(yield* cleanup.listMessageModeRequests, [{ threadId, requestId }]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps running rollbacks, checkpoints and all MCP retirements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const cleanup = yield* Cleanup.ServiceUpdateCleanup;
    const threadId = ThreadId.make("thread:update-cleanup-effects");
    const rollback = (id: string) => ({
      id,
      commandId: CommandId.make(`command:${id}`),
      threadId,
      request: {
        type: "provider-thread.rollback" as const,
        providerThreadId: ProviderThreadId.make("provider-thread:rollback"),
        checkpointId: CheckpointId.make("checkpoint:1"),
        scopeId: CheckpointScopeId.make("scope:1"),
        restoreFiles: true,
      },
    });
    yield* outbox.enqueue([
      rollback("effect:rollback-running"),
      rollback("effect:rollback-backoff"),
      {
        id: "effect:capture-running",
        commandId: CommandId.make("command:capture-running"),
        threadId,
        request: {
          type: "checkpoint.capture",
          runId: RunId.make("run:capture"),
          scopeId: CheckpointScopeId.make("scope:1"),
        },
      },
      ...["effect:invalidate-pending", "effect:invalidate-running"].map((id) => ({
        id,
        commandId: CommandId.make(`command:${id}`),
        threadId,
        request: { type: "mcp-credential.invalidate" as const },
      })),
    ]);
    // Three are mid-way; the others wait in retry backoff.
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running'
      WHERE effect_id IN ('effect:rollback-running', 'effect:capture-running', 'effect:invalidate-running')`;

    const cancelled = yield* cleanup.cancelUnsettledEffects({ reason: Preparation.STOP_REASON });
    assert.deepEqual(
      cancelled.map((effect) => [effect.effectId, effect.effectType, effect.commandId]),
      [["effect:rollback-backoff", "provider-thread.rollback", "command:effect:rollback-backoff"]],
    );
    const statuses = yield* sql<{ readonly effect_id: string; readonly status: string }>`
      SELECT effect_id, status FROM orchestration_v2_effect_outbox
       WHERE thread_id = ${threadId} ORDER BY effect_id
    `;
    assert.deepEqual(
      statuses.map((row) => [row.effect_id, row.status]),
      [
        ["effect:capture-running", "running"],
        ["effect:invalidate-pending", "pending"],
        ["effect:invalidate-running", "running"],
        ["effect:rollback-backoff", "cancelled"],
        ["effect:rollback-running", "running"],
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a finished turn whose checkpoint is being written", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const cleanup = yield* Cleanup.ServiceUpdateCleanup;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:update-cleanup-capture");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-update-cleanup-capture"),
      threadId,
      projectId,
      title: "Capture",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const runId = RunId.make("run:capturing");
    yield* projections.apply({
      id: EventId.make("run:capturing"),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:capturing"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "waiting",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* outbox.enqueue([
      {
        id: `effect:checkpoint.capture:${runId}`,
        commandId: CommandId.make(`${Cleanup.CHECKPOINT_CAPTURE_COMMAND_PREFIX}${runId}`),
        threadId,
        request: {
          type: "checkpoint.capture",
          runId,
          scopeId: CheckpointScopeId.make("scope:capturing"),
        },
      },
    ]);
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running'
      WHERE thread_id = ${threadId}`;

    assert.deepEqual(
      yield* cleanup.finalizeStuckRuns({ nonce: "capture", reason: Preparation.STOP_REASON }),
      { interrupted: 0, completed: 0 },
    );
    const records = yield* projections.getThreadRecords(threadId, ["runs"]);
    assert.equal(records.runs.find((run) => run.id === runId)?.status, "waiting");
    const effects = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}`;
    assert.deepEqual(
      effects.map((row) => row.status),
      ["running"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "with threadIds ends only those threads, leaving the turn interrupted so the person can continue it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const cleanup = yield* Cleanup.ServiceUpdateCleanup;
      const now = yield* DateTime.now;
      const waitingThread = ThreadId.make("thread:update-cleanup-stale");
      const busyThread = ThreadId.make("thread:update-cleanup-busy");
      for (const threadId of [waitingThread, busyThread]) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${threadId}`),
          threadId,
          projectId,
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        // A turn its provider started, waiting on the person's answer.
        const runId = RunId.make(`run:${threadId}`);
        const nodeId = NodeId.make(`node:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projections.apply({
          id: EventId.make(`node:${threadId}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`run:${threadId}`),
          type: "run.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:${threadId}`),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`request:${threadId}`),
          type: "runtime-request.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:${threadId}`),
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make(`session:${threadId}`),
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }

      assert.deepEqual(
        yield* cleanup.finalizeStuckRuns({
          nonce: "stale",
          reason: Preparation.STALE_WAIT_REASON,
          threadIds: [waitingThread],
        }),
        { interrupted: 1, completed: 0 },
      );
      assert.equal(
        yield* cleanup.cancelPendingRequests({
          nonce: "stale",
          reason: Preparation.STALE_WAIT_REASON,
          threadIds: [waitingThread],
        }),
        1,
      );

      const records = (threadId: ThreadId) =>
        projections.getThreadRecords(threadId, ["runs", "runtimeRequests", "turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
        });
      const stale = yield* records(waitingThread);
      assert.deepEqual(
        stale.runs.map((row) => row.status),
        ["interrupted"],
      );
      assert.deepEqual(
        stale.runtimeRequests.map((row) => [row.status, row.responseCapability]),
        [["cancelled", { type: "not_resumable", reason: Preparation.STALE_WAIT_REASON }]],
      );
      // Marked stopped for the update, with the reason, so the turn can be continued.
      assert.deepEqual(
        stale.turnItems.map((item) =>
          item.type === "run_interrupt_request" ? [item.cause, item.message] : null,
        ),
        [["service_update", Preparation.STALE_WAIT_REASON]],
      );
      // The other thread's turn and request are untouched.
      const busy = yield* records(busyThread);
      assert.deepEqual(
        busy.runs.map((row) => row.status),
        ["running"],
      );
      assert.deepEqual(
        busy.runtimeRequests.map((row) => row.status),
        ["pending"],
      );
      assert.deepEqual(busy.turnItems, []);
    }).pipe(Effect.provide(layerTest)),
);
