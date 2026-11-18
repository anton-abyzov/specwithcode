// A thread's own adversarial review choice, set the way its advisor choice is.
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
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
  openSession: () => Effect.die("No provider process needed for review choices"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:review-mode");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "orchestrator-review-mode" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** A thread with a run in progress. */
const threadWithRun = (name: string, title = name) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId,
      projectId,
      title,
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
      commandId: CommandId.make(`start-${name}`),
      threadId,
      messageId: MessageId.make(`message:${name}`),
      text: "Work on it",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    return { threadId, run };
  });

const setReviewMode = (threadId: ThreadId, key: string, reviewMode: "on" | "off" | null) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.review-mode.set",
      commandId: CommandId.make(`review-mode-${key}`),
      threadId,
      reviewMode,
    }),
  );

const readChoice = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = (yield* projections.getThreadProjection(threadId)).thread;
    const shell = yield* projections.getThreadShell(threadId);
    return { thread: thread.reviewMode ?? null, shell: shell?.reviewMode ?? null };
  });

it.effect("stores a thread's review choice in its projection and shell", () =>
  Effect.gen(function* () {
    const { threadId } = yield* threadWithRun("mode");
    assert.deepEqual(yield* readChoice(threadId), { thread: null, shell: null });
    for (const [key, mode] of [
      ["on", "on"],
      ["off", "off"],
      ["follow", null],
      ["on-again", "on"],
    ] as const) {
      const result = yield* setReviewMode(threadId, key, mode);
      // An existing event type, so clients from before this choice still read the stream.
      assert.include(
        result.storedEvents.map((stored) => stored.event.type),
        "thread.metadata-updated",
      );
      assert.deepEqual(yield* readChoice(threadId), { thread: mode, shell: mode });
    }
    yield* setReviewMode(threadId, "on-repeat", "on");
    assert.deepEqual(yield* readChoice(threadId), { thread: "on", shell: "on" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a review thread without a review choice of its own", () =>
  Effect.gen(function* () {
    const { threadId } = yield* threadWithRun("review", "Adversarial review: Sign in");
    yield* setReviewMode(threadId, "review-on", "on");
    assert.deepEqual(yield* readChoice(threadId), { thread: null, shell: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gives a delegated child its project's review, not the parent's choice", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* threadWithRun("parent");
    yield* setReviewMode(parent.threadId, "parent-on", "on");
    yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate-child"),
        parentThreadId: parent.threadId,
        parentRunId: parent.run.id as RunId,
        parentNodeId: parent.run.rootNodeId,
        task: "Write the tests",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "settled_only",
        createdBy: "agent",
        creationSource: "mcp",
      }),
    );
    const task = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!;
    assert.deepEqual(yield* readChoice(task.childThreadId!), { thread: null, shell: null });
  }).pipe(Effect.provide(layerTest)),
);
