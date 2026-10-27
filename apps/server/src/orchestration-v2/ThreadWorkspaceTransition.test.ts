import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6-astra" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("This deterministic fixture never opens a native process"),
} as ProviderAdapterV2Shape;
const databaseLayer = fixtureProjectDatabase(
  ["prepared", "nonempty", "empty", "unqualified", "pinned"].map((name) =>
    ProjectId.make(`project:${name}`),
  ),
);
const layerTest = Layer.mergeAll(
  databaseLayer,
  ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "workspace-transition" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  ),
);

const setup = Effect.fn(function* (name: string, worktreePath: string | null) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Native worktree fixture",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: worktreePath === null ? null : "prepared",
    worktreePath,
    createdBy: "user",
    creationSource: "web",
  });
  const providerSessionId = ProviderSessionId.make(`session:${name}`);
  yield* projections.apply({
    id: EventId.make(`attach:${name}`),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: providerSessionId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: worktreePath ?? "/repo",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`native-thread:${name}`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: ProviderThreadId.make(`native:${name}`),
      driver: adapter.driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: adapter.driver,
        nativeId: "fixture-native-reference",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return threadId;
});

const outbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ effect_id: string; payload_json: string }>`
    SELECT effect_id, payload_json FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
});

it.effect(
  "rejects a stale passive default after worktree preparation without detaching the native subscription",
  () =>
    Effect.gen(function* () {
      const threadId = yield* setup("prepared", "/repo/prepared-worktree");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("launch:prepared"),
        threadId,
        messageId: MessageId.make("message:prepared"),
        text: "Fixture only; no effect worker runs",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const beforeOutbox = yield* outbox;
      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("passive:prepared"),
          threadId,
          branch: "main",
          worktreePath: null,
          expectedWorktreePath: null,
          expectedEmpty: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.thread.branch, "prepared");
      assert.equal(after.thread.worktreePath, "/repo/prepared-worktree");
      assert.deepEqual(after.providerSessions, before.providerSessions);
      assert.deepEqual(after.providerThreads, before.providerThreads);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(yield* outbox, beforeOutbox);
      assert.isTrue(
        beforeOutbox.some((row) => JSON.parse(row.payload_json).type === "provider-turn.start"),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects a passive default after dispatch even when the observed workspace is still null",
  () =>
    Effect.gen(function* () {
      const threadId = yield* setup("nonempty", null);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("launch:nonempty"),
        threadId,
        messageId: MessageId.make("message:nonempty"),
        text: "Fixture only",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const beforeOutbox = yield* outbox;
      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("passive:nonempty"),
          threadId,
          branch: "main",
          worktreePath: null,
          expectedWorktreePath: null,
          expectedEmpty: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
      assert.deepEqual(yield* outbox, beforeOutbox);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("retains a passive default for an empty thread with the same observed workspace", () =>
  Effect.gen(function* () {
    const threadId = yield* setup("empty", null);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("passive:empty"),
      threadId,
      branch: "main",
      worktreePath: null,
      expectedWorktreePath: null,
      expectedEmpty: true,
    });
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.thread.branch, "main");
    assert.equal(after.providerSessions.length, 1);
    assert.deepEqual(yield* outbox, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "negative control: the original unqualified metadata update schedules Workspace changed detach",
  () =>
    Effect.gen(function* () {
      const threadId = yield* setup("unqualified", "/repo/prepared-worktree");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("manual:unqualified"),
        threadId,
        branch: "main",
        worktreePath: null,
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.thread.worktreePath, null);
      assert.equal(after.providerSessions.length, 0);
      const requests = (yield* outbox).map((row) => JSON.parse(row.payload_json));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].type, "provider-session.detach");
      assert.equal(requests[0].detail, "Workspace changed.");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the agent of a thread pinned to the folder it already runs in", () =>
  Effect.gen(function* () {
    const threadId = yield* setup("pinned", null);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("folder-change:keep:pinned"),
      threadId,
      worktreePath: "/repo",
      expectedWorktreePath: null,
      sameWorkingFolder: true,
    });
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.thread.worktreePath, "/repo");
    assert.equal(after.providerSessions.length, 1);
    assert.deepEqual(yield* outbox, []);
  }).pipe(Effect.provide(layerTest)),
);
