import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectRuntimeAccess from "../project/ProjectRuntimeAccess.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;

const projectId = ProjectId.make("project:project-access");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "project-access" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  {
    databaseLayer: layerDatabase,
    runEffectWorker: false,
    projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
  },
);
it.effect("new project chats use the saved project mode over a stale creation draft", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:project-access");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-project-access"),
      threadId,
      projectId,
      title: "Project access",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.runtimeMode, "full-access");
    assert.deepEqual(projection.thread.modelSelection, modelSelection);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("creation waits for the project permission update gate", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const acquired = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const saving = yield* orchestrator
      .withProjectPermissionUpdate(
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(acquired);
    const threadId = ThreadId.make("thread:blocked-by-permission-save");
    const creating = yield* orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-after-save"),
        threadId,
        projectId,
        title: "Project access",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(yield* orchestrator.getThreadShell(threadId), null);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(saving);
    yield* Fiber.join(creating);
    assert.equal(
      (yield* orchestrator.getThreadProjection(threadId)).thread.runtimeMode,
      "full-access",
    );
  }).pipe(Effect.provide(layerTest)),
);

// An agent's command carries its caller's mode, already inherited and capped
// by the MCP layer; the project's saved mode only fills in for a person's draft.
it.effect("an agent's delegated chat keeps the mode its caller passed over the project mode", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:project-access-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent"),
      threadId,
      projectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent"),
      threadId,
      messageId: MessageId.make("parent-message"),
      text: "Delegate",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(parent.thread.runtimeMode, "full-access");
    const run = parent.runs[0]!;
    // The agent asked for a narrower worker than itself; the project does not widen it.
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate"),
      parentThreadId: threadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Review",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updated = yield* orchestrator.getThreadProjection(threadId);
    const child = yield* orchestrator.getThreadProjection(updated.subagents[0]!.childThreadId!);
    assert.equal(child.thread.runtimeMode, "approval-required");
    assert.deepEqual(child.thread.modelSelection, modelSelection);
  }).pipe(Effect.provide(layerTest)),
);

const coordinatorCases = (["codex", "claudeAgent"] as const).map((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const caseInstanceId = ProviderInstanceId.make(driverName);
  const caseAdapter = {
    instanceId: caseInstanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driverName === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for metadata controls"),
  } as ProviderAdapterV2Shape;
  const supervisedProjectId = ProjectId.make(`project:supervised-${driverName}`);
  return {
    driverName,
    driver,
    modelSelection: { instanceId: caseInstanceId, model: "test-model" },
    projectId: supervisedProjectId,
    layer: ProviderReplayHarness.layerWithRegistry(
      { name: `project-access-full-coordinator-${driverName}` },
      ProviderAdapterRegistry.layerFromAdapters([caseAdapter]),
      {
        databaseLayer: fixtureProjectDatabase([supervisedProjectId]),
        runEffectWorker: false,
        projectSettingsOverrides: {
          [supervisedProjectId]: { defaultRuntimeMode: "approval-required" },
        },
      },
    ),
  };
});

it.effect.each(coordinatorCases)(
  "a Full access $driverName coordinator's workers run on Full access in an approval-required project",
  ({ driver, modelSelection: selection, projectId: supervised, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const coordinatorId = ThreadId.make("thread:full-coordinator");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-coordinator"),
        threadId: coordinatorId,
        projectId: supervised,
        title: "Coordinator",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // The person sets the coordinator itself to Full access; the project default stays lower.
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-coordinator"),
        threadId: coordinatorId,
        runtimeMode: "full-access",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-coordinator"),
        threadId: coordinatorId,
        messageId: MessageId.make("coordinator-message"),
        text: "Delegate",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const coordinator = yield* orchestrator.getThreadProjection(coordinatorId);
      assert.equal(coordinator.thread.runtimeMode, "full-access");
      const run = coordinator.runs[0]!;

      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate-full"),
        parentThreadId: coordinatorId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Run the tests",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const delegated = (yield* orchestrator.getThreadProjection(coordinatorId)).subagents[0]!;
      assert.equal(
        (yield* orchestrator.getThreadProjection(delegated.childThreadId!)).thread.runtimeMode,
        "full-access",
      );

      const workerId = ThreadId.make("thread:full-worker");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-worker"),
        threadId: workerId,
        projectId: supervised,
        title: "Worker",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(workerId)).thread.runtimeMode,
        "full-access",
      );

      // A fork copies the worker's context and, for an agent, the worker's mode.
      const providerThreadId = ProviderThreadId.make("provider-thread:full-worker");
      const workerRunId = RunId.make("run:full-worker");
      const workerMessageId = MessageId.make("full-worker-message");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("full-worker-provider-thread"),
            type: "provider-thread.updated",
            threadId: workerId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: selection.instanceId,
              providerSessionId: null,
              appThreadId: workerId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-full-worker", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("full-worker-run"),
            type: "run.created",
            threadId: workerId,
            runId: workerRunId,
            occurredAt: now,
            payload: {
              id: workerRunId,
              threadId: workerId,
              ordinal: 1,
              providerInstanceId: selection.instanceId,
              modelSelection: selection,
              providerThreadId,
              userMessageId: workerMessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "failed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("full-worker-item"),
            type: "turn-item.updated",
            threadId: workerId,
            runId: workerRunId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("full-worker-item"),
              threadId: workerId,
              runId: workerRunId,
              nodeId: null,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              createdBy: "agent",
              creationSource: "mcp",
              inputIntent: "turn_start",
              messageId: workerMessageId,
              text: "Fix the build",
              attachments: [],
            },
          },
        ],
      });
      const forkId = ThreadId.make("thread:full-worker-fork");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-worker"),
        sourceThreadId: workerId,
        targetThreadId: forkId,
        sourcePoint: { type: "run", runId: workerRunId },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const fork = yield* orchestrator.getThreadProjection(forkId);
      assert.equal(fork.thread.runtimeMode, "full-access");
      assert.lengthOf(fork.contextTransfers, 1);

      // A person's new chat still starts on the project's saved mode.
      const personId = ThreadId.make("thread:person-draft");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-person"),
        threadId: personId,
        projectId: supervised,
        title: "Person",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(personId)).thread.runtimeMode,
        "approval-required",
      );
    }).pipe(Effect.provide(layer)),
);

// Rewritten from the 0916 version, which expected the project's Full access to
// lift this caller's chat and then be refused: an agent's mode is now its own.
it.effect("a limited caller keeps its own mode and still cannot ask for a broader one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const limited = Effect.provideService(DispatchModeLimit, {
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    const kept = ThreadId.make("thread:limited-caller");
    yield* orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-limited"),
        threadId: kept,
        projectId,
        title: "Limited",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(limited);
    assert.equal(
      (yield* orchestrator.getThreadProjection(kept)).thread.runtimeMode,
      "approval-required",
    );

    const raised = ThreadId.make("thread:limited-caller-raised");
    const result = yield* Effect.exit(
      orchestrator
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-limited-raised"),
          threadId: raised,
          projectId,
          title: "Limited",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(limited),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(yield* orchestrator.getThreadShell(raised), null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "project saves persist access for active and archived chats through the real orchestrator",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const id of ["active-access", "archived-access"]) {
        const threadId = ThreadId.make(id);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId,
          projectId,
          title: id,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-access"),
        threadId: ThreadId.make("archived-access"),
      });
      const snapshot = yield* orchestrator.getShellSnapshot();
      assert.equal(snapshot.threads.length, 1);
      assert.equal(snapshot.archivedThreads.length, 1);
      assert.equal(snapshot.threads[0]!.deletedAt, null);
      assert.equal(snapshot.threads[0]!.projectId, projectId);
      const access = yield* ProjectRuntimeAccess.make;
      yield* access.updateSettings({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
      });
      for (const id of ["active-access", "archived-access"]) {
        assert.equal(
          (yield* orchestrator.getThreadProjection(ThreadId.make(id))).thread.runtimeMode,
          "full-access",
          id,
        );
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerSettings.layerTest({}),
          ProviderReplayHarness.layerWithRegistry(
            { name: "project-fanout" },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            { databaseLayer: layerDatabase, runEffectWorker: false },
          ),
        ),
      ),
    ),
);
