import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:start-only");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
// No effect worker: runs stay unstarted, so each test decides when one ends.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "start-only" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const busyThread = ThreadId.make("thread:start-only");
const heldThread = ThreadId.make("thread:start-only-held");

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Release notes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const message = (name: string, threadId: ThreadId = busyThread) => ({
  projectId,
  commandId: CommandId.make(`command:${name}`),
  threadId,
  messageId: MessageId.make(`message:${name}`),
  text: `Message from linux-mini's coordinator: ${name}`,
  notification: {
    source: { kind: "background_task" as const },
    outcome: "updated" as const,
    summary: "From linux-mini's coordinator.",
  },
  attachments: [],
  mode: "queue" as const,
  startOnly: true,
  createdBy: "agent" as const,
  creationSource: "server" as const,
});

/** Each run as `status` or `status:held`, oldest first. */
const statuses = (threadId: ThreadId = busyThread) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).runs.map(
      (run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`,
    );
  });

const threadId = busyThread;

const completeActiveRun = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const run = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
    (candidate) => candidate.status !== "queued" && candidate.status !== "completed",
  )!;
  const now = yield* DateTime.now;
  yield* projections.apply({
    id: EventId.make(`event:${run.id}:completed`),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
});

it.effect("a start-only send to a busy thread is refused, queues nothing, and can go later", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* createThread(busyThread);
    const first = yield* threads.sendToThread(message("first"));
    assert.equal(first.delivery, "started");

    const refused = yield* threads.sendToThread(message("second")).pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    // Nothing waits in the thread's queue to start later on its own.
    assert.deepEqual(yield* statuses(), [first.run.status]);

    // Nothing was recorded either: the same command starts once the thread is idle.
    yield* completeActiveRun;
    const later = yield* threads.sendToThread(message("second"));
    assert.equal(later.delivery, "started");
    assert.equal((yield* statuses()).filter((status) => status.startsWith("queued")).length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a start-only send to an idle thread with a held queue starts and leaves the hold", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* createThread(heldThread);
    const dispatch = (text: string, type: "start_immediately" | "queue_after_active") =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${text}`),
        threadId: heldThread,
        messageId: MessageId.make(`message:${text}`),
        text,
        attachments: [],
        dispatchMode: { type },
        createdBy: "user",
        creationSource: "web",
      });
    yield* dispatch("brief", "start_immediately");
    yield* dispatch("follow-up", "queue_after_active");
    const active = (yield* orchestrator.getThreadProjection(heldThread)).runs.find(
      (run) => run.status !== "queued",
    )!;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:held"),
      threadId: heldThread,
      runId: active.id,
      holdQueue: true,
    });
    assert.deepEqual(yield* statuses(heldThread), ["interrupted", "queued:held"]);

    const sent = yield* threads.sendToThread(message("held", heldThread));
    assert.equal(sent.delivery, "started");
    // The person's hold stays, and nothing of the message waits in the queue.
    const after = yield* statuses(heldThread);
    assert.deepEqual(after.slice(0, 2), ["interrupted", "queued:held"]);
    assert.equal(after.length, 3);
    assert.isFalse(after[2]!.startsWith("queued"));
  }).pipe(Effect.provide(layerTest)),
);
