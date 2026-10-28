import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMove from "./ThreadMoveService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sourceProjectId = ProjectId.make("project:move-source");
const targetProjectId = ProjectId.make("project:move-target");
const archivedProjectId = ProjectId.make("project:move-archived");
const otherProjectId = ProjectId.make("project:move-other");
const scratchProjectId = ProjectId.make("project:move-scratch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const targetModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.2-codex" };

const projectRow = (id: ProjectId, title: string, archived = false) => ({
  id,
  title,
  workspaceRoot: `/repos/${title}`,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: id === targetProjectId ? targetModel : modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, archived },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
});
const projectsById = new Map([
  [sourceProjectId, projectRow(sourceProjectId, "specweave")],
  [targetProjectId, projectRow(targetProjectId, "EasyChamp")],
  [archivedProjectId, projectRow(archivedProjectId, "Old", true)],
  [otherProjectId, projectRow(otherProjectId, "vskill")],
  [scratchProjectId, projectRow(scratchProjectId, "No project")],
]);

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;

// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const layerDatabase = fixtureProjectDatabase([
  sourceProjectId,
  targetProjectId,
  archivedProjectId,
  otherProjectId,
  scratchProjectId,
]);
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "thread-move" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerThreads = ThreadManagement.layer.pipe(Layer.provideMerge(layerOrchestrator));
const layerProjects = Layer.succeed(ProjectService.ProjectService, {
  create: () => Effect.die("unused"),
  bootstrap: () => Effect.die("unused"),
  update: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  deleteThreads: () => Effect.die("unused"),
  getById: (id) => Effect.succeed(Option.fromNullishOr(projectsById.get(id))),
  getByWorkspaceRoot: () => Effect.succeed(Option.none()),
  snapshot: Effect.die("unused"),
  getShell: () => Effect.die("unused"),
  listShells: () => Effect.die("unused"),
} as ProjectService.ProjectService["Service"]);
const layerLaunch = ThreadLaunch.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreads,
      layerProjects,
      CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
      IdAllocator.layer,
      WorktreeSetupTracker.layer,
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
      Layer.mock(GitWorkflow.GitWorkflowService)({ isRepository: () => Effect.succeed(true) }),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      }),
      Layer.mock(TextGeneration.TextGeneration)({}),
      ServerSettings.layerTest(),
      ProviderRegistryMock.layer(),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        folderForThread: () => Effect.succeed(Option.none()),
      }),
    ),
  ),
);
const layerTest = ThreadMove.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerThreads,
      layerLaunch,
      layerProjects,
      // The target project asks for approvals; its threads must too.
      ServerSettings.layerTest({
        projectSettingsOverrides: {
          [targetProjectId]: { defaultRuntimeMode: "approval-required" },
        },
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratch: (projectId) => Effect.succeed(projectId === scratchProjectId),
      }),
    ),
  ),
);

const createThread = (threadId: ThreadId, projectId = sourceProjectId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Audit EasyChamp",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const moveCommand = (
  threadId: ThreadId,
  targetThreadId: ThreadId,
  overrides: Partial<ThreadMove.ThreadMoveCommand> = {},
): ThreadMove.ThreadMoveCommand => ({
  type: "thread.move-to-project",
  commandId: CommandId.make(`move:${threadId}`),
  threadId,
  targetProjectId,
  targetThreadId,
  createdBy: "user",
  creationSource: "web",
  ...overrides,
});

const liveStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);

it.effect("restarts a cancelled thread empty in the target project and archives the source", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const source = ThreadId.make("thread:move-idle");
    const target = ThreadId.make("thread:move-idle-target");
    yield* createThread(source);
    yield* send(source, "Audit EasyChamp", "start_immediately");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("user-cancel"),
      threadId: source,
    });

    const result = yield* moves.move(moveCommand(source, target));
    assert.equal(result.started, false);

    const moved = yield* orchestrator.getThreadProjection(target);
    assert.equal(moved.thread.projectId, targetProjectId);
    assert.deepEqual(moved.thread.modelSelection, targetModel);
    assert.equal(moved.thread.runtimeMode, "approval-required");
    assert.equal(moved.thread.worktreePath, null);
    assert.equal(moved.thread.movedFrom?.threadId, source);
    assert.equal(moved.thread.movedFrom?.projectId, sourceProjectId);
    // Fresh: no history and nothing resumed from the cancelled turn.
    assert.equal(moved.runs.length, 0);
    assert.equal(moved.messages.length, 0);

    const original = yield* orchestrator.getThreadProjection(source);
    assert.equal(original.thread.projectId, sourceProjectId);
    assert.notEqual(original.thread.archivedAt, null);
    assert.equal(original.thread.movedTo?.threadId, target);
    assert.equal(original.thread.movedTo?.projectId, targetProjectId);
    // History stays where it happened.
    assert.equal(original.messages.length, 1);

    const shell = yield* orchestrator.getThreadShell(source);
    assert.equal(shell?.movedTo?.threadId, target);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops a working thread, discards its queue and starts the request in the target", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const source = ThreadId.make("thread:move-running");
    const target = ThreadId.make("thread:move-running-target");
    yield* createThread(source);
    yield* send(source, "first", "start_immediately");
    yield* send(source, "queued follow-up", "queue_after_active");
    const parentRun = (yield* orchestrator.getThreadProjection(source)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate:move"),
      parentThreadId: source,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "child audit",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const child = (yield* orchestrator.getThreadProjection(source)).subagents.find(
      (task) => task.prompt === "child audit",
    )!.childThreadId!;

    const result = yield* moves.move(
      moveCommand(source, target, {
        start: { messageId: MessageId.make("message:move-start"), text: "Audit EasyChamp" },
      }),
    );
    assert.equal(result.started, true);

    const original = yield* orchestrator.getThreadProjection(source);
    assert.isFalse(original.runs.some((run) => liveStatuses.has(run.status)));
    assert.equal(
      original.runs.find((run) => run.queuePosition !== null),
      undefined,
    );
    const childProjection = yield* orchestrator.getThreadProjection(child);
    assert.isFalse(childProjection.runs.some((run) => liveStatuses.has(run.status)));

    const moved = yield* orchestrator.getThreadProjection(target);
    assert.equal(moved.runs.length, 1);
    assert.deepEqual(
      moved.messages.map((message) => message.text),
      ["Audit EasyChamp"],
    );

    // The old thread cannot be talked back into the wrong project.
    const late = yield* Effect.exit(send(source, "keep going", "start_immediately"));
    assert.isTrue(Exit.isFailure(late));
    assert.include(String(late), "moved to another project");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a repeated move replays instead of creating a second thread", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const source = ThreadId.make("thread:move-retry");
    const target = ThreadId.make("thread:move-retry-target");
    yield* createThread(source);
    yield* moves.move(moveCommand(source, target));
    yield* moves.move(moveCommand(source, target));
    const moved = yield* orchestrator.getThreadProjection(target);
    assert.equal(moved.thread.movedFrom?.threadId, source);

    const elsewhere = yield* Effect.exit(
      moves.move(
        moveCommand(source, ThreadId.make("thread:move-retry-other"), {
          commandId: CommandId.make("move:again"),
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(elsewhere));
    assert.include(String(elsewhere), "already moved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moves an archived thread without unarchiving it, and keeps it from waking", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const source = ThreadId.make("thread:move-archived-source");
    const target = ThreadId.make("thread:move-archived-target");
    yield* createThread(source);
    yield* send(source, "Audit EasyChamp", "start_immediately");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("archived-cancel"),
      threadId: source,
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archived-archive"),
      threadId: source,
    });

    yield* moves.move(moveCommand(source, target));
    const original = yield* orchestrator.getThreadProjection(source);
    assert.notEqual(original.thread.archivedAt, null);
    assert.equal(original.thread.movedTo?.threadId, target);
    assert.equal(
      (yield* orchestrator.getThreadProjection(target)).thread.movedFrom?.threadId,
      source,
    );

    // Restored or not, it never works again: no turn, no pull request watch.
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("archived-unarchive"),
      threadId: source,
    });
    const late = yield* Effect.exit(send(source, "one more", "start_immediately"));
    assert.isTrue(Exit.isFailure(late));
    assert.include(String(late), "moved to another project");
    const watch = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("archived-watch"),
        threadId: source,
        host: "github.com",
        repository: "anton-abyzov/specwithcode",
        number: 439,
        watching: true,
      }),
    );
    assert.isTrue(Exit.isFailure(watch));
    assert.include(String(watch), "no longer watches pull requests");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a retry into a different project is refused instead of mislinking", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const source = ThreadId.make("thread:move-retarget");
    const target = ThreadId.make("thread:move-retarget-target");
    yield* createThread(source);
    yield* moves.move(moveCommand(source, target, { targetProjectId: otherProjectId }));

    const retry = yield* Effect.exit(moves.move(moveCommand(source, target)));
    assert.isTrue(Exit.isFailure(retry));
    assert.include(String(retry), "already started into another project");
    const original = yield* orchestrator.getThreadProjection(source);
    assert.equal(original.thread.movedTo?.projectId, otherProjectId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gives a No-project chat to the project as it is, still working", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const chat = ThreadId.make("thread:move-scratch-chat");
    yield* createThread(chat, scratchProjectId);
    yield* send(chat, "Lane C: implement 0951", "start_immediately");
    yield* send(chat, "also check the docs", "queue_after_active");
    const before = yield* orchestrator.getThreadProjection(chat);

    const result = yield* moves.move(
      moveCommand(chat, ThreadId.make("thread:move-scratch-unused"), {
        start: { messageId: MessageId.make("message:scratch-start"), text: "ignored" },
      }),
    );
    assert.equal(result.targetThreadId, chat);
    assert.equal(result.started, false);

    const after = yield* orchestrator.getThreadProjection(chat);
    assert.equal(after.thread.projectId, targetProjectId);
    // It now works with the project's access, from its next turn.
    assert.equal(after.thread.runtimeMode, "approval-required");
    assert.equal(after.thread.archivedAt, null);
    assert.equal(after.thread.movedTo ?? null, null);
    assert.equal(after.thread.worktreePath, before.thread.worktreePath);
    assert.deepEqual(
      after.runs.map((run) => [run.id, run.status]),
      before.runs.map((run) => [run.id, run.status]),
    );
    assert.equal(after.messages.length, before.messages.length);
    assert.isTrue(after.runs.some((run) => liveStatuses.has(run.status)));
    assert.equal(
      yield* orchestrator.getThreadShell(ThreadId.make("thread:move-scratch-unused")),
      null,
    );

    // From now on it is an ordinary thread of that project.
    const repeat = yield* Effect.exit(
      moves.move(moveCommand(chat, ThreadId.make("thread:move-scratch-unused"))),
    );
    assert.include(String(repeat), "already in that project");
    const later = yield* Effect.exit(send(chat, "more", "queue_after_active"));
    assert.isTrue(Exit.isSuccess(later));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an in-place move that lost a race to another move is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const chat = ThreadId.make("thread:move-scratch-race");
    yield* createThread(chat, scratchProjectId);
    const adopt = (projectId: ProjectId, suffix: string) =>
      orchestrator.dispatch({
        type: "thread.project.adopt",
        commandId: CommandId.make(`adopt:${chat}:${suffix}`),
        threadId: chat,
        fromProjectId: scratchProjectId,
        projectId,
      });

    yield* adopt(targetProjectId, "first");
    // Both moves passed the Scratch check; the second must not move it out of a real project.
    const second = yield* Effect.exit(adopt(otherProjectId, "second"));
    assert.isTrue(Exit.isFailure(second));
    assert.include(String(second), "moved to another project");
    assert.equal((yield* orchestrator.getThreadProjection(chat)).thread.projectId, targetProjectId);

    // The same move again is a no-op.
    const again = yield* Effect.exit(adopt(targetProjectId, "again"));
    assert.isTrue(Exit.isSuccess(again));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses coordinators, agents, the same project and unavailable projects", () =>
  Effect.gen(function* () {
    const moves = yield* ThreadMove.ThreadMoveService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const plain = ThreadId.make("thread:move-refused");
    const coordinator = ThreadId.make(`project-coordinator:${sourceProjectId}`);
    yield* createThread(plain);
    yield* createThread(coordinator);
    const target = ThreadId.make("thread:move-refused-target");

    const refused = (command: ThreadMove.ThreadMoveCommand) =>
      moves.move(command).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
    assert.include(yield* refused(moveCommand(coordinator, target)), "coordinator stays");
    assert.include(
      yield* refused(moveCommand(plain, target, { createdBy: "agent" })),
      "Only you can move",
    );
    assert.include(
      yield* refused(moveCommand(plain, target, { targetProjectId: sourceProjectId })),
      "already in that project",
    );
    assert.include(
      yield* refused(moveCommand(plain, target, { targetProjectId: archivedProjectId })),
      "Resume or restore Old",
    );
    assert.include(
      yield* refused(
        moveCommand(plain, target, { targetProjectId: ProjectId.make("project:elsewhere") }),
      ),
      "not on this machine",
    );
    // Nothing was created or archived by a refused move.
    const shell = yield* orchestrator.getThreadShell(target);
    assert.equal(shell, null);
    const source = yield* orchestrator.getThreadProjection(plain);
    assert.equal(source.thread.archivedAt, null);
  }).pipe(Effect.provide(layerTest)),
);
