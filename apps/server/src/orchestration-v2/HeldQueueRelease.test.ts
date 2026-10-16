import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
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

const projectId = ProjectId.make("project:held-queue");
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
        { name: "held-queue" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Release worker",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

type Sender = "user" | "worker" | "schedule" | "system";

const send = (
  threadId: ThreadId,
  text: string,
  type: "start_immediately" | "queue_after_active",
  from: Sender = "worker",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      ...(from === "schedule"
        ? { scheduledTaskId: ScheduledTaskId.make("scheduled-task:nightly"), createdBy: "agent" }
        : from === "user"
          ? { createdBy: "user" }
          : from === "system"
            ? { createdBy: "system" }
            : { createdBy: "agent" }),
      creationSource: from === "user" ? "web" : from === "worker" ? "mcp" : "server",
    });
  });

/** Each run as `status` or `status:held`, oldest first. */
const runs = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`);
  });

const stop = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const active = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.status !== "queued",
    )!;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`stop:${threadId}`),
      threadId,
      runId: active.id,
      holdQueue: true,
    });
  });

/** Ends the newest run that is not queued, the way a provider's final event does. */
const completeActiveRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
      (candidate) =>
        candidate.status !== "queued" &&
        candidate.status !== "interrupted" &&
        candidate.status !== "completed",
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

it.effect("a handoff that starts a held thread delivers the held queue after it, in order", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:held-release");
    yield* createThread(threadId);
    yield* send(threadId, "release brief", "start_immediately", "user");
    yield* send(threadId, "handoff 1", "queue_after_active");
    // The restart (here: Stop) cuts the run and holds what was waiting.
    yield* stop(threadId);
    assert.deepEqual(yield* runs(threadId), ["interrupted", "queued:held"]);

    // The coordinator's "resume" message starts a turn: the held handoff now follows it.
    yield* send(threadId, "resume after cancel", "start_immediately");
    const resumed = yield* runs(threadId);
    assert.deepEqual(resumed.slice(0, 2), ["interrupted", "queued"]);
    assert.notInclude(resumed[2]!, "queued");
    // Handoffs sent while that turn runs queue behind it, not into a hold.
    yield* send(threadId, "handoff 2", "queue_after_active");
    yield* send(threadId, "handoff 3", "queue_after_active");
    assert.deepEqual((yield* runs(threadId)).slice(3), ["queued", "queued"]);
    assert.isFalse(yield* projections.canStartQueuedRun(threadId));

    // When the turn finishes, nothing in the queue is held, so it drains.
    yield* completeActiveRun(threadId);
    assert.isTrue(yield* projections.canStartQueuedRun(threadId));
    const shell = yield* projections.getThreadShell(threadId);
    assert.isUndefined(shell?.heldQueuedCount);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an automatic delivery leaves the hold for the user, and the shell counts it", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:held-automatic");
    yield* createThread(threadId);
    yield* send(threadId, "brief", "start_immediately", "user");
    yield* send(threadId, "handoff 1", "queue_after_active");
    yield* stop(threadId);

    // A scheduled run starts the thread without anyone deciding about its queue.
    yield* send(threadId, "nightly check", "start_immediately", "schedule");
    // A wake-like automatic message queued behind it joins the hold, keeping the order.
    yield* send(threadId, "nightly follow-up", "queue_after_active", "schedule");
    const state = yield* runs(threadId);
    assert.equal(state[1], "queued:held");
    assert.equal(state[3], "queued:held");
    yield* completeActiveRun(threadId);
    assert.isFalse(yield* projections.canStartQueuedRun(threadId));
    // Lists see the held messages (SQL shell and projection shell agree).
    assert.equal((yield* projections.getThreadShell(threadId))?.heldQueuedCount, 2);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(ProjectionStore.threadShellFromProjection(projection).heldQueuedCount, 2);

    // The user's own message continues the thread and releases them.
    yield* send(threadId, "go on", "start_immediately", "user");
    assert.isFalse((yield* runs(threadId)).some((run) => run.endsWith(":held")));
  }).pipe(Effect.provide(layerTest)),
);

it("only someone continuing the thread releases a held queue", () => {
  const sent = { text: "Go on", attachments: [], createdBy: "agent" } as const;
  assert.isTrue(Orchestrator.messageReleasesHeldQueue(sent));
  assert.isTrue(Orchestrator.messageReleasesHeldQueue({ ...sent, createdBy: "user" }));
  // The server's own messages (idle compaction) are not someone deciding about the queue.
  assert.isFalse(Orchestrator.messageReleasesHeldQueue({ ...sent, createdBy: "system" }));
  // Native maintenance does not continue the work, whoever sends it.
  assert.isFalse(
    Orchestrator.messageReleasesHeldQueue({ ...sent, text: " /compact ", createdBy: "user" }),
  );
  assert.isFalse(Orchestrator.messageReleasesHeldQueue({ ...sent, text: "/logout" }));
  assert.isFalse(
    Orchestrator.messageReleasesHeldQueue({
      ...sent,
      scheduledTaskId: ScheduledTaskId.make("scheduled-task:nightly"),
    }),
  );
});

it.effect("the server's idle /compact runs without releasing a held queue", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:held-compact");
    yield* createThread(threadId);
    yield* send(threadId, "brief", "start_immediately", "user");
    yield* send(threadId, "handoff 1", "queue_after_active");
    yield* stop(threadId);

    yield* send(threadId, "/compact", "start_immediately", "system");
    const state = yield* runs(threadId);
    assert.equal(state[1], "queued:held");
    assert.notInclude(state[2]!, "queued");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("tells a sender whether its message joined a held queue or released one", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const threadId = ThreadId.make("thread:held-send");
    yield* createThread(threadId);
    yield* send(threadId, "brief", "start_immediately", "user");
    yield* send(threadId, "handoff 1", "queue_after_active");
    yield* send(threadId, "handoff 2", "queue_after_active");
    yield* stop(threadId);

    const sent = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:held-send:resume"),
      threadId,
      messageId: MessageId.make("message:held-send:resume"),
      text: "Resume the release",
      attachments: [],
      mode: "auto",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(sent.delivery, "started");
    assert.equal(sent.releasedHeldRuns, 2);
  }).pipe(Effect.provide(layerTest)),
);
