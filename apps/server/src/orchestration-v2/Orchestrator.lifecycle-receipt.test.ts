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
import { LifecycleEvidenceActivation } from "./ThreadLifecycleAcceptance.ts";
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
const projectId = ProjectId.make("project:lifecycle-receipt");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "lifecycle-receipt" },
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

it.layer(layerTest)("recorded delivery evidence", (it) => {
  it.effect("binds the current request and resolves complete evidence", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, run } = yield* completedThread("accepted");
      yield* record(threadId, run.id, "accepted", report(yield* DateTime.now));
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.settledOverride, "settled");
      assert.equal(thread.settledNote, "Delivery verified: Fix installed in 1.0.93 and verified");
      assert.equal(thread.lifecycleReceipt?.requestId, run.userMessageId);
      assert.equal(thread.lifecycleReceipt?.runId, run.id);
      assert.equal(thread.lifecycleReceipt?.acceptanceRevision, run.id);
      assert.equal(thread.lifecycleReceipt?.reportedBy, "thread:completion-owner");
    }),
  );

  it.effect("keeps outstanding obligations unresolved and persisted", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, run } = yield* completedThread("obligation");
      const now = yield* DateTime.now;
      yield* record(
        threadId,
        run.id,
        "obligation",
        report(now, {
          deployment: { status: "pending", reason: "Waiting for the 1.0.93 release" },
          obligations: [
            {
              kind: "deployment",
              reason: "Release is held for 1.0.92.",
              owner: "release-owner",
              nextEvent: "Installed acceptance receipt",
              needsUserOutput: false,
            },
          ],
        }),
      );
      const thread = yield* projections.getThread(threadId);
      assert.isNull(thread.settledOverride);
      assert.equal(thread.lifecycleReceipt?.obligations[0]?.owner, "release-owner");
    }),
  );

  it.effect("refuses another turn, an unfinished turn and expired evidence", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* completedThread("refused");
      const now = yield* DateTime.now;
      const wrongRun = yield* record(
        threadId,
        RunId.make("run:not-this-one"),
        "wrong-run",
        report(now),
      ).pipe(Effect.flip);
      assert.instanceOf(wrongRun, Orchestrator.OrchestratorDispatchError);
      const expired = yield* record(
        threadId,
        run.id,
        "expired",
        report(now, { validUntil: DateTime.formatIso(DateTime.add(now, { seconds: -1 })) }),
      ).pipe(Effect.flip);
      assert.instanceOf(expired, Orchestrator.OrchestratorDispatchError);
      // A newer request supersedes the completed turn.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("receipt:refused:follow-up"),
        threadId,
        messageId: MessageId.make("receipt:refused:follow-up"),
        text: "One more thing",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const superseded = yield* record(threadId, run.id, "superseded", report(now)).pipe(
        Effect.flip,
      );
      assert.instanceOf(superseded, Orchestrator.OrchestratorDispatchError);
      const thread = yield* projections.getThread(threadId);
      assert.isUndefined(thread.lifecycleReceipt ?? undefined);
      assert.notEqual(thread.settledOverride, "settled");
    }),
  );

  it.effect("records but does not resolve a pinned thread; a reopen clears the evidence", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* completedThread("pinned");
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("receipt:pinned:pin"),
        threadId,
      });
      yield* record(threadId, run.id, "pinned", report(yield* DateTime.now));
      const pinned = yield* projections.getThread(threadId);
      assert.isNull(pinned.settledOverride);
      assert.isDefined(pinned.lifecycleReceipt ?? undefined);

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("receipt:pinned:reopen"),
        threadId,
        reason: "user",
      });
      const reopened = yield* projections.getThread(threadId);
      assert.isNull(reopened.lifecycleReceipt ?? null);
      assert.equal(reopened.lifecycleRevision, "receipt:pinned:reopen");
    }),
  );
});

const autoSettle = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    return yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make(`receipt:${name}:auto-settle`),
        threadId,
        snapshotAt: (yield* projections.getThread(threadId)).updatedAt,
        snapshotSequence: yield* sink.latestSequence({ threadId }),
      }),
    );
  });

it.effect("automatic settlement needs no evidence while the gate is off", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* completedThread("gate-off");
    assert.equal((yield* autoSettle(threadId, "gate-off"))._tag, "Success");
    assert.equal((yield* projections.getThread(threadId)).settledOverride, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("with the gate on, automatic settlement needs current accepted evidence", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, run } = yield* completedThread("gate-on");
    assert.equal((yield* autoSettle(threadId, "gate-on-missing"))._tag, "Failure");
    yield* record(
      threadId,
      run.id,
      "gate-on-waiting",
      report(yield* DateTime.now, {
        obligations: [
          {
            kind: "review",
            reason: "Fresh-context review is pending",
            owner: "completion owner",
            nextEvent: "Review verdict",
            needsUserOutput: false,
          },
        ],
      }),
    );
    assert.equal((yield* autoSettle(threadId, "gate-on-waiting"))._tag, "Failure");
    assert.notEqual((yield* projections.getThread(threadId)).settledOverride, "settled");
  }).pipe(Effect.provide(layerTest), Effect.provideService(LifecycleEvidenceActivation, true)),
);

it.effect("a steer into the turn belongs to its request", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:receipt:steered");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("receipt:steered:create"),
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
      commandId: CommandId.make("receipt:steered:start"),
      threadId,
      messageId: MessageId.make("receipt:steered:prompt"),
      text: "Ship the fix",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const { runs, messages } = yield* projections.getThreadProjection(threadId);
    const run = runs[0]!;
    const now = yield* DateTime.now;
    const later = DateTime.add(now, { seconds: 5 });
    yield* sink.write({
      events: [
        {
          id: EventId.make("receipt:steered:running"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          // A steer joins the running turn as another user message.
          id: EventId.make("receipt:steered:steer"),
          type: "message.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...messages[0]!,
            id: MessageId.make("receipt:steered:steer"),
            text: "Also update the docs",
            runId: run.id,
            createdAt: later,
            updatedAt: later,
          },
        },
      ],
    });
    // Evidence is recorded after the turn, never during it.
    assert.equal(
      (yield* Effect.exit(record(threadId, run.id, "steered-early", report(now))))._tag,
      "Failure",
    );
    yield* sink.write({
      events: [
        {
          id: EventId.make("receipt:steered:complete"),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: { ...run, status: "completed", startedAt: now, completedAt: later },
        },
      ],
    });
    yield* record(threadId, run.id, "steered", report(now));
    assert.equal((yield* projections.getThread(threadId)).settledOverride, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("judges the turn that ran last, not a queued turn cancelled before it started", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const { threadId, run } = yield* completedThread("cancelled-queue");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("receipt:cancelled-queue:queued"),
      threadId,
      messageId: MessageId.make("receipt:cancelled-queue:queued-prompt"),
      text: "One more change",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    // While another request waits to run, nothing can be adjudicated.
    assert.equal(
      (yield* Effect.exit(record(threadId, run.id, "cancelled-queue-waiting", report(now))))._tag,
      "Failure",
    );
    yield* sink.write({
      events: [
        {
          id: EventId.make("receipt:cancelled-queue:cancel"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...queued, status: "cancelled", startedAt: null, completedAt: now },
        },
      ],
    });
    yield* record(threadId, run.id, "cancelled-queue", report(now));
    const thread = yield* projections.getThread(threadId);
    assert.equal(thread.lifecycleReceipt?.runId, run.id);
    assert.equal(thread.settledOverride, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settles a turn that ran last even when a higher ordinal finished first", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const { threadId, run } = yield* completedThread("out-of-order");
    const now = yield* DateTime.now;
    // A continuation started ahead of the held queue and ended before this turn.
    yield* sink.write({
      events: [
        {
          id: EventId.make("receipt:out-of-order:ahead"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...run,
            id: RunId.make("receipt:out-of-order:ahead"),
            ordinal: run.ordinal + 1,
            status: "completed",
            startedAt: DateTime.subtract(now, { minutes: 2 }),
            completedAt: DateTime.subtract(now, { minutes: 1 }),
          },
        },
      ],
    });
    yield* record(threadId, run.id, "out-of-order", report(now));
    const thread = yield* projections.getThread(threadId);
    assert.equal(thread.lifecycleReceipt?.runId, run.id);
    assert.equal(thread.settledOverride, "settled");
  }).pipe(Effect.provide(layerTest)),
);
