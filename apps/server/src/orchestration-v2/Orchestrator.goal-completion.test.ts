import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type LifecycleReceiptReport,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for lifecycle receipts"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:goal-completion");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "goal-completion" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** A thread whose only turn completed; returns its run. */
const completedThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:receipt:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`receipt:${name}:create`),
      threadId,
      projectId,
      title: "Deliver the fix",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`receipt:${name}:start`),
      threadId,
      messageId: MessageId.make(`receipt:${name}:prompt`),
      text: "Ship the fix",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`receipt:${name}:complete`),
      events: [
        {
          id: EventId.make(`receipt:${name}:complete`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    return { threadId, run };
  });

const report = (now: DateTime.Utc, patch: Partial<LifecycleReceiptReport> = {}) => {
  const proof = {
    status: "verified" as const,
    reference: "https://example.test/release/1",
    observedAt: DateTime.formatIso(now),
    scopeRevision: "source-1",
  };
  return {
    kind: "code" as const,
    scope: "Fix installed in 1.0.93 and verified",
    scopeRevision: "source-1",
    validUntil: DateTime.formatIso(DateTime.add(now, { hours: 24 })),
    obligations: [],
    push: proof,
    merge: proof,
    deployment: proof,
    deliverable: proof,
    verification: proof,
    ...patch,
  } satisfies LifecycleReceiptReport;
};

const record = (threadId: ThreadId, runId: RunId, name: string, body: LifecycleReceiptReport) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.lifecycle-receipt.record",
      commandId: CommandId.make(`receipt:${name}:record`),
      threadId,
      runId,
      reportedBy: "thread:completion-owner",
      report: body,
    });
  });

const reloadThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fresh = yield* ProjectionStore.ProjectionStoreV2;
    return yield* fresh.getThread(threadId);
  }).pipe(Effect.provide(ProjectionStore.layer));

const pendingGoal = {
  id: "disk-goal",
  scope: "Reclaim disk space and prevent dependency growth",
  scopeRevision: "disk-goal-1",
  obligations: [
    {
      id: "activation",
      kind: "deployment" as const,
      reason: "Activate merged source",
      owner: "publisher",
      nextEvent: "Installed receipt",
      needsUserOutput: false,
      completion: { status: "pending" as const, reason: "Not installed" },
    },
    {
      id: "cleanup",
      kind: "dependency" as const,
      reason: "Retire eligible worktrees",
      owner: "HOME-DISK",
      nextEvent: "Guarded removal receipt",
      needsUserOutput: false,
      completion: { status: "pending" as const, reason: "Removal incomplete" },
    },
    {
      id: "growth",
      kind: "review" as const,
      reason: "Verify dependency growth prevention",
      owner: "disk owner",
      nextEvent: "Measured acceptance",
      needsUserOutput: false,
      completion: { status: "pending" as const, reason: "Unverified" },
    },
  ],
};
const goalProof = (now: DateTime.Utc) => ({
  ...pendingGoal,
  obligations: pendingGoal.obligations.map((item) => ({
    ...item,
    completion: {
      status: "verified" as const,
      reference: `receipt://${item.id}`,
      observedAt: DateTime.formatIso(now),
      scopeRevision: pendingGoal.scopeRevision,
    },
  })),
});
const settle = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`goal:${name}:settle`),
        threadId,
      }),
    );
  });

it.layer(layerTest)("durable goal completion", (it) => {
  it.effect("rejects future goal proof at recording instead of letting it mature", () =>
    Effect.gen(function* () {
      const { threadId, run } = yield* completedThread("future-proof");
      const now = yield* DateTime.now;
      const futureProof = goalProof(DateTime.add(now, { hours: 1 }));
      const refused = yield* record(
        threadId,
        run.id,
        "future-proof",
        report(now, { goal: futureProof }),
      ).pipe(Effect.exit);
      assert.equal(refused._tag, "Failure");
      assert.isUndefined((yield* reloadThread(threadId)).lifecycleReceipt?.goal);
    }),
  );

  it.effect("new pending requirements reopen a settled goal without starting execution", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, run } = yield* completedThread("extended-goal");
      const now = yield* DateTime.now;
      yield* record(threadId, run.id, "extended-accepted", report(now, { goal: goalProof(now) }));
      assert.equal((yield* projections.getThread(threadId)).settledOverride, "settled");
      const extended = {
        ...goalProof(now),
        obligations: [
          ...goalProof(now).obligations,
          { ...pendingGoal.obligations[1]!, id: "additional-cleanup" },
        ],
      };
      yield* record(threadId, run.id, "extended-pending", report(now, { goal: extended }));
      const restored = yield* reloadThread(threadId);
      assert.isNull(restored.settledOverride);
      assert.isNull(restored.settledAt);
      assert.equal(restored.lifecycleReceipt?.goal?.obligations.length, 4);
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.runs[0]?.status, "completed");
      assert.equal((yield* settle(threadId, "extended-goal"))._tag, "Failure");
    }),
  );

  it.effect(
    "1131 source completion and merge cannot close cleanup/activation/growth obligations",
    () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { threadId, run } = yield* completedThread("1131-source");
        yield* record(
          threadId,
          run.id,
          "1131-source",
          report(yield* DateTime.now, { scope: "1131 source milestone merged", goal: pendingGoal }),
        );
        assert.notEqual((yield* projections.getThread(threadId)).settledOverride, "settled");
        assert.equal((yield* settle(threadId, "1131-source"))._tag, "Failure");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const auto = yield* orchestrator
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("goal:1131-auto"),
            threadId,
            snapshotAt: (yield* projections.getThread(threadId)).updatedAt,
            snapshotSequence: yield* sink.latestSequence({ threadId }),
          })
          .pipe(Effect.exit);
        assert.equal(auto._tag, "Failure");
        // A fresh projection service reads the persisted optional goal from the fixture SQL store.
        const restored = yield* reloadThread(threadId);
        assert.deepEqual(restored.lifecycleReceipt?.goal, pendingGoal);
        // A later narrow report cannot silently discard the required goal work.
        yield* record(threadId, run.id, "1131-narrow", report(yield* DateTime.now));
        assert.deepEqual(
          (yield* projections.getThread(threadId)).lifecycleReceipt?.goal,
          pendingGoal,
        );
        assert.equal((yield* settle(threadId, "1131-narrow"))._tag, "Failure");
      }),
  );

  it.effect("keeps obligations through reopen and a new completed run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const { threadId, run } = yield* completedThread("resume");
      yield* record(
        threadId,
        run.id,
        "resume-first",
        report(yield* DateTime.now, { goal: pendingGoal }),
      );
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("goal:reopen"),
        threadId,
        reason: "user",
      });
      assert.deepEqual(
        (yield* projections.getThread(threadId)).lifecycleReceipt?.goal,
        pendingGoal,
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("goal:resume"),
        threadId,
        messageId: MessageId.make("goal:resume"),
        text: "Continue the goal",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const next = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("goal:resume-completed"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...next, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* record(threadId, next.id, "resume-next", report(now));
      const restored = yield* reloadThread(threadId);
      assert.equal(restored.lifecycleReceipt?.runId, next.id);
      assert.deepEqual(restored.lifecycleReceipt?.goal, pendingGoal);
      assert.equal((yield* settle(threadId, "resume-next"))._tag, "Failure");
    }),
  );

  it.effect("accepts verified completion of every obligation in the same transaction", () =>
    Effect.gen(function* () {
      const { threadId, run } = yield* completedThread("all-complete");
      yield* record(
        threadId,
        run.id,
        "all-pending",
        report(yield* DateTime.now, { goal: pendingGoal }),
      );
      const now = yield* DateTime.now;
      yield* record(threadId, run.id, "all-verified", report(now, { goal: goalProof(now) }));
      const restored = yield* reloadThread(threadId);
      assert.equal(restored.settledOverride, "settled");
      assert.equal(restored.lifecycleReceipt?.goal?.obligations.length, 3);
    }),
  );

  it.effect("rejects removed or redefined requirements without changing stored evidence", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, run } = yield* completedThread("narrowed");
      yield* record(
        threadId,
        run.id,
        "narrowed-first",
        report(yield* DateTime.now, { goal: pendingGoal }),
      );
      for (const [index, goal] of [
        { ...pendingGoal, id: "source-only" },
        { ...pendingGoal, obligations: pendingGoal.obligations.slice(0, 1) },
        {
          ...pendingGoal,
          obligations: pendingGoal.obligations.map((item) => ({
            ...item,
            reason: "Source merged",
          })),
        },
        { ...pendingGoal, obligations: [pendingGoal.obligations[0]!, pendingGoal.obligations[0]!] },
      ].entries()) {
        const refused = yield* record(
          threadId,
          run.id,
          `narrowed-${index}`,
          report(yield* DateTime.now, { goal }),
        ).pipe(Effect.exit);
        assert.equal(refused._tag, "Failure");
      }
      assert.deepEqual(
        (yield* projections.getThread(threadId)).lifecycleReceipt?.goal,
        pendingGoal,
      );
    }),
  );

  it.effect("lets an accepted scoped worker finish while its parent's goal stays open", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* completedThread("parent");
      yield* record(
        parent.threadId,
        parent.run.id,
        "parent",
        report(yield* DateTime.now, { goal: pendingGoal }),
      );
      const worker = yield* completedThread("worker");
      const sink = yield* EventSink.EventSinkV2;
      const workerThread = yield* projections.getThread(worker.threadId);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("goal:worker-lineage"),
            type: "thread.metadata-updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: {
              ...workerThread,
              createdBy: "agent",
              creationSource: "mcp",
              lineage: {
                parentThreadId: parent.threadId,
                relationshipToParent: "subagent",
                rootThreadId: parent.threadId,
              },
            },
          },
        ],
      });
      // An independent completion owner accepts this worker's delivered repair proposal.
      yield* record(
        worker.threadId,
        worker.run.id,
        "worker",
        report(yield* DateTime.now, { scope: "R5 repair proposal accepted by source owner" }),
      );
      assert.equal((yield* projections.getThread(worker.threadId)).settledOverride, "settled");
      assert.isUndefined((yield* projections.getThread(worker.threadId)).lifecycleReceipt?.goal);
      assert.notEqual((yield* projections.getThread(parent.threadId)).settledOverride, "settled");
      assert.deepEqual(
        (yield* projections.getThread(parent.threadId)).lifecycleReceipt?.goal,
        pendingGoal,
      );
    }),
  );

  it.effect("recording all completion evidence never resumes an explicit Stop", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const { threadId, run } = yield* completedThread("stopped");
      yield* record(
        threadId,
        run.id,
        "stopped-pending",
        report(yield* DateTime.now, { goal: pendingGoal }),
      );
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("goal:stop"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("goal:stop"),
              type: "run_interrupt_request",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "completed",
              title: "Interrupt requested",
              message: "Stopped",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      yield* record(threadId, run.id, "stopped-verified", report(now, { goal: goalProof(now) }));
      const restored = yield* projections.getThreadProjection(threadId);
      assert.notEqual(restored.thread.settledOverride, "settled");
      assert.equal(restored.runs.length, 1);
      assert.equal(restored.runs[0]?.status, "completed");
      assert.equal(
        restored.turnItems.find(
          (item) => item.id === "goal:stop" && item.type === "run_interrupt_request",
        )?.type,
        "run_interrupt_request",
      );
      assert.equal(
        restored.thread.lifecycleReceipt?.goal?.obligations[0]?.completion.status,
        "verified",
      );
    }),
  );
});
