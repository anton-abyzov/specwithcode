import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type TerminalMetadataStreamEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Terminals from "../terminal/Manager.ts";
import { putDraft } from "../composerDrafts/draftFiles.ts";
import * as Guard from "./InactiveThreadArchiveGuard.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("inactive-archive");
const database = fixtureProjectDatabase([projectId]);
const stores = Layer.mergeAll(Projections.layer, Projects.layer).pipe(Layer.provide(database));
const config = Config.layerTest(process.cwd(), { prefix: "inactive-archive-test-" }).pipe(
  Layer.provide(NodeServices.layer),
);
const settings = Settings.layerTest();
let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
const terminalLayer = Layer.effect(
  Terminals.TerminalManager,
  Effect.gen(function* () {
    const locks = yield* KeyedLock.make<string>();
    return {
      withThreadLifecycleLock: locks.withLock,
      subscribeMetadata: (listener) => {
        terminalListener = listener;
        return listener({ type: "snapshot", terminals: [] }).pipe(
          Effect.as(() => {
            terminalListener = undefined;
          }),
        );
      },
    } as Terminals.TerminalManager["Service"];
  }),
);
const guard = Guard.layer.pipe(
  Layer.provide(Layer.mergeAll(stores, database, config, settings, terminalLayer)),
);
const runtime = Harness.layerWithRegistry(
  { name: "inactive-archive" },
  Registry.layerFromAdapters([]),
  { databaseLayer: database, runEffectWorker: false },
).pipe(Layer.provide(guard));
const layerTest = Layer.mergeAll(
  runtime,
  stores,
  database,
  config,
  settings,
  guard,
  terminalLayer,
  NodeServices.layer,
);
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };

const seed = (id: string, worktreePath = "/fixture/dirty-unpushed") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const threadId = ThreadId.make(id);
    const at = DateTime.makeUnsafe(0);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId,
      projectId,
      title: "Keep history",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "retained",
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make(`run:${id}`),
      type: "run.created",
      threadId,
      occurredAt: at,
      payload: {
        id: RunId.make(`run:${id}`),
        threadId,
        ordinal: 1,
        providerInstanceId: selection.instanceId,
        modelSelection: selection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${id}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    return threadId;
  });
const archive = (
  threadId: ThreadId,
  commandId: string,
  expectedUpdatedAt = DateTime.makeUnsafe(0),
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(commandId),
      threadId,
      inactive: { expectedUpdatedAt },
    });
  });

it.effect(
  "conditionally archives after 30 days without effects, record changes or checkout mutation",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const projections = yield* Projections.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "retained-archive-worktree-" });
      const retained = path.join(folder, "unsent-local-work.txt");
      yield* fs.writeFileString(retained, "Uncommitted and unpushed work stays here");
      const id = yield* seed("archive-ready", folder);
      const before = yield* projections.getThreadProjection(id);
      yield* TestClock.adjust(30 * Guard.DAY_MS);
      const result = yield* archive(id, "archive:ready");
      assert.deepEqual(
        result.storedEvents.map((event) => event.event.type),
        ["thread.archived"],
      );
      const after = yield* projections.getThreadProjection(id);
      assert.isNotNull(after.thread.archivedAt);
      assert.equal(after.thread.worktreePath, before.thread.worktreePath);
      assert.equal(after.thread.branch, before.thread.branch);
      for (const key of [
        "runs",
        "messages",
        "turnItems",
        "providerSessions",
        "checkpoints",
      ] as const)
        assert.deepEqual(after[key], before[key]);
      const effects =
        yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE command_id = 'archive:ready'`;
      assert.deepEqual(effects, []);
      assert.equal(yield* fs.readFileString(retained), "Uncommitted and unpushed work stays here");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects stale activity, Never, saved drafts, schedules and pins at mutation", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const projections = yield* Projections.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const preferences = yield* Settings.ServerSettingsService;
    const cfg = yield* Config.ServerConfig;
    const stale = yield* seed("stale");
    const never = yield* seed("never");
    const drafted = yield* seed("drafted");
    const pinned = yield* seed("pinned");
    yield* TestClock.adjust(31 * Guard.DAY_MS);
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* engine.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("pin"),
      threadId: pinned,
    });
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("fresh"),
      threadId: stale,
      title: "Fresh activity",
    });
    assert.isTrue((yield* archive(stale, "stale-archive").pipe(Effect.exit))._tag === "Failure");
    yield* preferences.updateSettings({ archiveInactiveThreadsAfterDays: null });
    assert.isTrue((yield* archive(never, "never-archive").pipe(Effect.exit))._tag === "Failure");
    yield* preferences.updateSettings({ archiveInactiveThreadsAfterDays: 30 });
    yield* Effect.promise(() =>
      putDraft(
        cfg.composerDraftsDir,
        { key: `thread:${drafted}`, prompt: "Unsent", attachments: [], editedAt: 1 },
        1,
      ),
    );
    assert.isTrue((yield* archive(drafted, "draft-archive").pipe(Effect.exit))._tag === "Failure");
    const pinShell = yield* projections.getThreadShell(pinned);
    assert.isTrue(
      (yield* archive(pinned, "pinned-archive", pinShell!.updatedAt).pipe(Effect.exit))._tag ===
        "Failure",
    );
    // All routine metadata is authoritative; an unrelated routine in this project is conservative protection too.
    yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
    VALUES ('routine','Keep','Keep',0,'{}',${projectId},${never},'{}','{}','full-access','default','user','web','1970-01-01','1970-01-01','never',0)`;
    assert.isTrue(
      (yield* archive(never, "scheduled-archive").pipe(Effect.exit))._tag === "Failure",
    );
    for (const id of [stale, never, drafted, pinned])
      assert.isNull((yield* projections.getThread(id)).archivedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "protects coordinators, personal assistants, live handles, unfinished tools and Stop controls",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const projections = yield* Projections.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const coordinator = yield* seed(`project-coordinator:${projectId}`);
      const personal = yield* seed("personal-chat");
      const live = yield* seed("live-provider");
      const tool = yield* seed("background-tool");
      const stopped = yield* seed("stop-control");
      const terminal = yield* seed("open-terminal");
      const now = DateTime.makeUnsafe(0);
      yield* projections.apply({
        id: EventId.make("live-session"),
        type: "provider-session.attached",
        threadId: live,
        occurredAt: now,
        payload: {
          id: ProviderSessionId.make("live-session"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: selection.instanceId,
          status: "ready",
          cwd: "/fixture/dirty-unpushed",
          model: "test",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const [id, type] of [
        [tool, "command_execution"],
        [stopped, "run_interrupt_request"],
      ] as const) {
        yield* projections.apply({
          id: EventId.make(`control:${id}`),
          type: "turn-item.updated",
          threadId: id,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`control:${id}`),
            threadId: id,
            runId: RunId.make(`run:${id}`),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            ...(type === "command_execution"
              ? { type, status: "running", input: "retain background task" }
              : { type, status: "completed", message: "Stop", cause: "user" }),
          },
        });
      }
      yield* TestClock.adjust(31 * Guard.DAY_MS);
      for (const id of [coordinator, live, tool, stopped]) {
        assert.isTrue((yield* archive(id, `protected:${id}`).pipe(Effect.exit))._tag === "Failure");
        assert.isNull((yield* projections.getThread(id)).archivedAt);
      }
      yield* terminalListener!({
        type: "upsert",
        terminal: {
          threadId: terminal,
          terminalId: "shell",
          cwd: "/fixture",
          worktreePath: null,
          status: "running",
          pid: 1,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: true,
          label: "Retain",
          updatedAt: "1970-01-01T00:00:00Z",
        },
      });
      assert.isTrue(
        (yield* archive(terminal, "terminal-archive").pipe(Effect.exit))._tag === "Failure",
      );
      yield* sql`UPDATE projection_projects SET workspace_settings_json = '{"kind":"personal"}' WHERE project_id = ${projectId}`;
      assert.isTrue(
        (yield* archive(personal, "personal-archive").pipe(Effect.exit))._tag === "Failure",
      );
    }).pipe(Effect.provide(layerTest)),
);

const openedTerminal = (threadId: ThreadId): TerminalMetadataStreamEvent => ({
  type: "upsert",
  terminal: {
    threadId,
    terminalId: "concurrent",
    cwd: "/fixture",
    worktreePath: null,
    status: "running",
    pid: 1,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "Retain",
    updatedAt: "1970-01-01T00:00:00Z",
  },
});

it.effect("serializes terminal admission until the yielding archive commit finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const id = yield* seed("commit-versus-open");
    yield* TestClock.adjust(31 * Guard.DAY_MS);
    const guard = yield* Guard.InactiveThreadArchiveGuard;
    const terminals = yield* Terminals.TerminalManager;
    const committing = yield* Deferred.make<void>();
    const finishCommit = yield* Deferred.make<void>();
    const opening = yield* Deferred.make<void>();
    const order: string[] = [];
    const archiveFiber = yield* guard
      .protect(
        {
          type: "thread.archive",
          commandId: CommandId.make("guard:commit-open"),
          threadId: id,
          inactive: { expectedUpdatedAt: DateTime.makeUnsafe(0) },
        },
        Deferred.succeed(committing, undefined).pipe(
          Effect.andThen(Deferred.await(finishCommit)),
          Effect.andThen(Effect.sync(() => order.push("archive committed"))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(committing);
    const terminalFiber = yield* Deferred.succeed(opening, undefined).pipe(
      Effect.andThen(
        terminals.withThreadLifecycleLock(
          id,
          terminalListener!(openedTerminal(id)).pipe(
            Effect.andThen(Effect.sync(() => order.push("terminal opened"))),
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(opening);
    yield* Effect.yieldNow;
    assert.deepEqual(order, []);
    yield* Deferred.succeed(finishCommit, undefined);
    yield* Fiber.join(archiveFiber);
    yield* Fiber.join(terminalFiber);
    assert.deepEqual(order, ["archive committed", "terminal opened"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects archive after an earlier terminal admission publishes its live metadata", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const id = yield* seed("open-versus-commit");
    yield* TestClock.adjust(31 * Guard.DAY_MS);
    const guard = yield* Guard.InactiveThreadArchiveGuard;
    const terminals = yield* Terminals.TerminalManager;
    const opened = yield* Deferred.make<void>();
    const finishOpen = yield* Deferred.make<void>();
    let archived = false;
    const terminalFiber = yield* terminals
      .withThreadLifecycleLock(
        id,
        terminalListener!(openedTerminal(id)).pipe(
          Effect.andThen(Deferred.succeed(opened, undefined)),
          Effect.andThen(Deferred.await(finishOpen)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(opened);
    const archiveFiber = yield* guard
      .protect(
        {
          type: "thread.archive",
          commandId: CommandId.make("guard:open-commit"),
          threadId: id,
          inactive: { expectedUpdatedAt: DateTime.makeUnsafe(0) },
        },
        Effect.sync(() => {
          archived = true;
        }),
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Effect.yieldNow;
    assert.isFalse(archived);
    yield* Deferred.succeed(finishOpen, undefined);
    yield* Fiber.join(terminalFiber);
    assert.equal((yield* Fiber.join(archiveFiber))._tag, "Failure");
    assert.isFalse(archived);
  }).pipe(Effect.provide(layerTest)),
);
