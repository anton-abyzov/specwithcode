// The advisor's orchestration: a thread's own advisor choice, and the
// read-only child an `advisor` consult starts.
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
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const advisorSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-2",
};
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for advisor records"),
} as ProviderAdapterV2Shape;
const advisorAdapter = {
  ...adapter,
  instanceId: advisorSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:advisor");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "orchestrator-advisor" },
    ProviderAdapterRegistry.layerFromAdapters([adapter, advisorAdapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** A thread with a run in progress, in the given modes. */
const threadWithRun = (
  name: string,
  modes: { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode } = {
    runtimeMode: "full-access",
    interactionMode: "default",
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId,
      projectId,
      title: name,
      modelSelection,
      ...modes,
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

const setAdvisorMode = (threadId: ThreadId, key: string, advisorMode: "on" | "off" | null) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.advisor-mode.set",
      commandId: CommandId.make(`advisor-mode-${key}`),
      threadId,
      advisorMode,
    }),
  );

const delegate = (
  parent: { threadId: ThreadId; run: { id: RunId; rootNodeId: unknown } },
  key: string,
  purpose?: "advisor",
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate-${key}`),
      parentThreadId: parent.threadId,
      parentRunId: parent.run.id,
      parentNodeId: parent.run.rootNodeId as never,
      task: "Review the work so far",
      modelSelection: purpose === "advisor" ? advisorSelection : modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      completionWake: "settled_only",
      ...(purpose === undefined ? {} : { purpose }),
      createdBy: "agent",
      creationSource: "mcp",
    }),
  );

it.effect("stores a thread's advisor choice in its projection and shell", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId } = yield* threadWithRun("mode");
    const read = Effect.gen(function* () {
      const thread = (yield* projections.getThreadProjection(threadId)).thread;
      const shell = yield* projections.getThreadShell(threadId);
      return { thread: thread.advisorMode ?? null, shell: shell?.advisorMode ?? null };
    });
    assert.deepEqual(yield* read, { thread: null, shell: null });
    for (const [key, mode] of [
      ["on", "on"],
      ["off", "off"],
      ["follow", null],
      ["on-again", "on"],
    ] as const) {
      const result = yield* setAdvisorMode(threadId, key, mode);
      assert.include(
        result.storedEvents.map((stored) => stored.event.type),
        "thread.metadata-updated",
      );
      assert.deepEqual(yield* read, { thread: mode, shell: mode });
    }
    // Setting the same choice again changes nothing.
    yield* setAdvisorMode(threadId, "on-repeat", "on");
    assert.deepEqual(yield* read, { thread: "on", shell: "on" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("starts an advisor child read-only and marked, without the parent's advisor choice", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // A plan-mode, full-access parent, so the child's modes prove they were forced.
    const parent = yield* threadWithRun("advised", {
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    yield* setAdvisorMode(parent.threadId, "advised-on", "on");
    yield* delegate(parent, "advisor", "advisor");
    const task = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!;
    assert.equal(task.purpose, "advisor");
    assert.equal(task.runId, parent.run.id);
    const child = (yield* projections.getThreadProjection(task.childThreadId!)).thread;
    assert.equal(child.purpose, "advisor");
    assert.equal(child.runtimeMode, "approval-required");
    assert.equal(child.interactionMode, "default");
    assert.isUndefined(child.advisorMode);
    assert.equal(child.lineage.relationshipToParent, "subagent");
    const shell = yield* projections.getThreadShell(task.childThreadId!);
    assert.equal(shell?.purpose, "advisor");
    assert.isUndefined(shell?.advisorMode);

    // A later change to the task's wake policy keeps it an advisor consult.
    yield* orchestrator.dispatch({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("advisor-wake-policy"),
      parentThreadId: parent.threadId,
      taskId: task.id,
      completionWake: "always",
    });
    const updated = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!;
    assert.equal(updated.completionWake, "always");
    assert.equal(updated.purpose, "advisor");

    // An advisor child keeps no advisor choice of its own.
    yield* setAdvisorMode(task.childThreadId!, "child-on", "on");
    const after = (yield* projections.getThreadProjection(task.childThreadId!)).thread;
    assert.isUndefined(after.advisorMode);
    assert.equal(after.purpose, "advisor");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses delegation from an advisor child", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* threadWithRun("advisor-parent");
    yield* delegate(parent, "advisor-child", "advisor");
    const childThreadId = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!
      .childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    const childRun = child.runs[0] ?? {
      id: RunId.make("run:advisor-child"),
      rootNodeId: parent.run.rootNodeId,
    };
    for (const purpose of [undefined, "advisor"] as const) {
      const exit = yield* Effect.exit(
        delegate({ threadId: childThreadId, run: childRun }, `from-advisor-${purpose}`, purpose),
      );
      assert.equal(exit._tag, "Failure");
      assert.include(String(JSON.stringify(exit)), "An advisor cannot delegate work");
    }
    assert.lengthOf((yield* projections.getThreadProjection(childThreadId)).subagents, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gives an ordinary delegated child neither the advisor choice nor the mark", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* threadWithRun("ordinary");
    yield* setAdvisorMode(parent.threadId, "ordinary-on", "on");
    yield* delegate(parent, "ordinary-child");
    const task = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!;
    assert.isUndefined(task.purpose);
    const child = (yield* projections.getThreadProjection(task.childThreadId!)).thread;
    assert.isUndefined(child.advisorMode);
    assert.isUndefined(child.purpose);
    assert.equal(child.interactionMode, "plan");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a stuck advisor child the way a consult does: no wake-up, stopped, archived", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* threadWithRun("stuck");
    yield* delegate(parent, "stuck-advisor", "advisor");
    // The call that gave up waiting armed a wake-up, as `wait` does.
    const task = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("stuck-wake-policy"),
      parentThreadId: parent.threadId,
      taskId: task.id,
      completionWake: "always",
    });
    const childThreadId = task.childThreadId!;
    const childBefore = yield* projections.getThreadProjection(childThreadId);
    assert.isAbove(childBefore.runs.length, 0);

    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence();
    // The same three commands, in the same order, as the consult's `abandon`.
    yield* orchestrator.dispatch({
      type: "delegated_task.completion-delivery.dispose",
      commandId: CommandId.make("stuck-dispose"),
      parentThreadId: parent.threadId,
      taskId: task.id,
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stuck-stop"),
      threadId: childThreadId,
      reason: "The advisor waited on a request nobody answers.",
      cause: "delegated_cancel",
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("stuck-archive"),
      threadId: childThreadId,
    });

    // The stopped run ends the task, so the next consult does not pick it up again.
    const ended = yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === task.id &&
          ["completed", "failed", "cancelled", "interrupted"].includes(stored.event.payload.status),
      ),
      Stream.runHead,
    );
    assert.isTrue(ended._tag === "Some");
    const after = (yield* projections.getThreadProjection(parent.threadId)).subagents[0]!;
    assert.include(["failed", "cancelled", "interrupted"], after.status);
    assert.equal(after.completionDelivery?.state, "disposed");
    assert.equal(after.purpose, "advisor");
    const shell = yield* projections.getThreadShell(childThreadId);
    assert.isNotNull(shell?.archivedAt ?? null);
    assert.isNull(shell?.activeRunId ?? null);
  }).pipe(Effect.provide(layerTest)),
);
