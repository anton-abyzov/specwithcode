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
import * as HandoffTurnGate from "../handoff/HandoffTurnGate.ts";
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

const seed = (
  id: string,
  worktreePath = "/fixture/dirty-unpushed",
  creation: { readonly createdBy: "user" | "agent"; readonly creationSource: "web" | "mcp" } = {
    createdBy: "user",
    creationSource: "web",
  },
  withRun = true,
) =>
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
      ...creation,
    });
    if (!withRun) return threadId;
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
  reason?: "overflow",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(commandId),
      threadId,
      inactive: reason === undefined ? { expectedUpdatedAt } : { expectedUpdatedAt, reason },
    });
  });
const overflow = (threadId: ThreadId) =>
  archive(threadId, `overflow:${threadId}`, DateTime.makeUnsafe(0), "overflow").pipe(Effect.exit);
const refused = (threadId: ThreadId, reason: string) =>
  Effect.gen(function* () {
    const exit = yield* overflow(threadId);
    assert.equal(exit._tag, "Failure");
    assert.include(String(exit), reason);
  });
const seedWorkers = (count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => `worker-${index}`),
    (id) => seed(id, undefined, { createdBy: "agent", creationSource: "mcp" }),
  );

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

it.effect(
  "caps agent and child threads down to the limit, keeping history that Unarchive restores",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const projections = yield* Projections.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const preferences = yield* Settings.ServerSettingsService;
      yield* preferences.updateSettings({ keepActiveThreadsPerProject: 20 });
      const [child, agent, kept] = yield* seedWorkers(22);
      // A coordinator-delegated child, the bulk of an overflowing project.
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.lineage.parentThreadId', ${`project-coordinator:${projectId}`}, '$.lineage.relationshipToParent', 'subagent')
        WHERE thread_id = ${child!}`;
      assert.isNotNull((yield* projections.getThreadShell(child!))!.lineage.parentThreadId);
      const before = yield* projections.getThreadProjection(child!);
      yield* TestClock.adjust(Guard.OVERFLOW_IDLE_MS);
      for (const id of [child!, agent!]) {
        const result = yield* overflow(id);
        assert.equal(result._tag, "Success");
        if (result._tag === "Success")
          assert.deepEqual(
            result.value.storedEvents.map((event) => event.event.type),
            ["thread.archived"],
          );
      }
      // Twenty live threads remain: the project is at its cap.
      yield* refused(kept!, "Project is within its limit");
      assert.isNull((yield* projections.getThread(kept!)).archivedAt);
      const after = yield* projections.getThreadProjection(child!);
      assert.isNotNull(after.thread.archivedAt);
      for (const key of ["runs", "messages", "turnItems", "checkpoints"] as const)
        assert.deepEqual(after[key], before[key]);
      const effects =
        yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE command_id LIKE 'overflow:%'`;
      assert.deepEqual(effects, []);
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive:child"),
        threadId: child!,
      });
      assert.isNull((yield* projections.getThread(child!)).archivedAt);
      assert.deepEqual((yield* projections.getThreadProjection(child!)).runs, before.runs);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "the cap refuses fresh threads, the coordinator, routine targets, drafts, No limit and a race to the cap",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const projections = yield* Projections.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const preferences = yield* Settings.ServerSettingsService;
      const cfg = yield* Config.ServerConfig;
      yield* preferences.updateSettings({ keepActiveThreadsPerProject: 20 });
      const coordinator = yield* seed(`project-coordinator:${projectId}`, undefined, {
        createdBy: "agent",
        creationSource: "mcp",
      });
      const [fresh, routine, other, drafted, raced, user] = yield* seedWorkers(21);
      yield* refused(fresh!, "Thread is active or protected");
      yield* TestClock.adjust(Guard.OVERFLOW_IDLE_MS);
      yield* refused(coordinator, "Project is protected");
      yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
      VALUES ('routine','Keep','Keep',0,'{}',${projectId},${routine!},'{}','{}','full-access','default','user','web','1970-01-01','1970-01-01','never',0)`;
      yield* refused(routine!, "Routine or terminal is protected");
      // A routine elsewhere in the project does not pin every other worker.
      assert.equal((yield* overflow(other!))._tag, "Success");
      yield* Effect.promise(() =>
        putDraft(
          cfg.composerDraftsDir,
          { key: `thread:${drafted}`, prompt: "Unsent", attachments: [], editedAt: 1 },
          1,
        ),
      );
      yield* refused(drafted!, "Saved draft is protected");
      yield* preferences.updateSettings({ keepActiveThreadsPerProject: null });
      yield* refused(raced!, "Project has no thread limit");
      yield* preferences.updateSettings({ keepActiveThreadsPerProject: 20 });
      // Selected at 21 live; the owner archives another chat before the guard checks.
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.archive",
        commandId: CommandId.make("owner-archive"),
        threadId: user!,
      });
      yield* refused(raced!, "Project is within its limit");
      for (const id of [fresh!, coordinator, routine!, drafted!, raced!])
        assert.isNull((yield* projections.getThread(id)).archivedAt);
    }).pipe(Effect.provide(layerTest)),
);

const nativeSubagent = (id: string, parent: string, status: "completed" | "running") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* seed(
      id,
      undefined,
      { createdBy: "agent", creationSource: "mcp" },
      false,
    );
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.creationSource', 'provider', '$.lineage.parentThreadId', ${parent}, '$.lineage.relationshipToParent', 'subagent')
      WHERE thread_id = ${threadId}`;
    // The provider-native receipt lives on the parent, as the provider reported it.
    yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id,thread_id,run_id,parent_node_id,provider,provider_thread_id,child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
      VALUES (${`subagent:${id}`},${parent},NULL,'node','codex',NULL,${threadId},'provider_native',${status},'1970-01-01T00:00:00.000Z',${status === "completed" ? "1970-01-01T00:00:00.000Z" : null},'1970-01-01T00:00:00.000Z','{}')`;
    return threadId;
  });

it.effect("the cap archives a finished provider-native subagent that never had a run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const projections = yield* Projections.ProjectionStoreV2;
    const preferences = yield* Settings.ServerSettingsService;
    yield* preferences.updateSettings({ keepActiveThreadsPerProject: 20 });
    yield* seedWorkers(20);
    // A finished worker with no session left: nothing can send to its subagents.
    const parent = yield* seed("native-parent", undefined, {
      createdBy: "agent",
      creationSource: "mcp",
    });
    const finished = yield* nativeSubagent("native-finished", parent, "completed");
    const working = yield* nativeSubagent("native-working", parent, "running");
    const shell = (yield* projections.getThreadShell(finished))!;
    assert.isNull(shell.latestRunId);
    assert.equal(shell.nativeSubagentStatus, "completed");
    yield* refused(finished, "Thread is active or protected");
    yield* TestClock.adjust(Guard.OVERFLOW_IDLE_MS);
    yield* refused(working, "Thread is active or protected");
    const result = yield* overflow(finished);
    assert.equal(result._tag, "Success");
    assert.isNotNull((yield* projections.getThread(finished)).archivedAt);
    assert.isNull((yield* projections.getThread(working)).archivedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "the cap keeps a finished native subagent its running parent, live session or coordinator can resume",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const projections = yield* Projections.ProjectionStoreV2;
      const preferences = yield* Settings.ServerSettingsService;
      yield* preferences.updateSettings({ keepActiveThreadsPerProject: 20 });
      yield* seedWorkers(20);
      const agent = { createdBy: "agent", creationSource: "mcp" } as const;
      const now = DateTime.makeUnsafe(0);
      // The parent's turn is still running when its subagent finishes.
      const running = yield* seed("running-parent", undefined, agent);
      yield* projections.apply({
        id: EventId.make("run:running-parent:2"),
        type: "run.created",
        threadId: running,
        occurredAt: now,
        payload: {
          id: RunId.make("run:running-parent:2"),
          threadId: running,
          ordinal: 2,
          providerInstanceId: selection.instanceId,
          modelSelection: selection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:running-parent:2"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      // Between turns, but its provider session can still send to the subagent.
      const live = yield* seed("live-parent", undefined, agent);
      yield* projections.apply({
        id: EventId.make("live-parent-session"),
        type: "provider-session.attached",
        threadId: live,
        occurredAt: now,
        payload: {
          id: ProviderSessionId.make("live-parent-session"),
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
      const children = [
        yield* nativeSubagent("child-of-running", running, "completed"),
        yield* nativeSubagent("child-of-live", live, "completed"),
        // Delete-all keeps the coordinator's own subagents; the cap does too.
        yield* nativeSubagent(
          "child-of-coordinator",
          `project-coordinator:${projectId}`,
          "completed",
        ),
        yield* nativeSubagent("child-of-missing", "missing-parent", "completed"),
      ];
      // A subagent of a kept subagent stays with it.
      const nested = yield* nativeSubagent("grandchild", children[2]!, "completed");
      yield* TestClock.adjust(Guard.OVERFLOW_IDLE_MS);
      assert.isNotNull((yield* projections.getThreadShell(running))!.activeRunId);
      for (const id of [...children, nested]) {
        yield* refused(id, "Thread is active or protected");
        assert.isNull((yield* projections.getThread(id)).archivedAt);
      }
    }).pipe(Effect.provide(layerTest)),
);

const handedOff = Layer.succeed(HandoffTurnGate.HandoffTurnGate, {
  check: (threadId) =>
    Effect.succeed(
      threadId === ThreadId.make("worker-0")
        ? "Another machine (B) runs this thread now; this copy is read-only."
        : null,
    ),
});
const layerHandedOff = Layer.mergeAll(
  Harness.layerWithRegistry({ name: "inactive-archive-handoff" }, Registry.layerFromAdapters([]), {
    databaseLayer: database,
    runEffectWorker: false,
  }).pipe(Layer.provide(Layer.mergeAll(guard, handedOff))),
  stores,
  database,
  config,
  settings,
  guard,
  terminalLayer,
  NodeServices.layer,
);

it.effect("the cap never archives a thread another machine runs or may continue", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const projections = yield* Projections.ProjectionStoreV2;
    const preferences = yield* Settings.ServerSettingsService;
    yield* preferences.updateSettings({ keepActiveThreadsPerProject: 20 });
    const [leased, local] = yield* seedWorkers(22);
    yield* TestClock.adjust(Guard.OVERFLOW_IDLE_MS);
    yield* refused(leased!, "Another machine (B) runs this thread now");
    assert.isNull((yield* projections.getThread(leased!)).archivedAt);
    assert.equal((yield* overflow(local!))._tag, "Success");
  }).pipe(Effect.provide(layerHandedOff)),
);
