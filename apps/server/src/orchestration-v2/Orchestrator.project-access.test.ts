import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectRuntimeAccess from "../project/ProjectRuntimeAccess.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
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

it.effect("delegated chats inherit project access over the caller draft", () =>
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
    const run = parent.runs[0]!;
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
    assert.equal(child.thread.runtimeMode, "full-access");
    assert.deepEqual(child.thread.modelSelection, modelSelection);
  }).pipe(Effect.provide(layerTest)),
);
it.effect("project inheritance cannot raise a limited caller above its dispatch permission", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:limited-caller");
    const result = yield* Effect.exit(
      orchestrator
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-limited"),
          threadId,
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
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(yield* orchestrator.getThreadShell(threadId), null);
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
