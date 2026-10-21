import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectCoordinator from "../project/ProjectCoordinatorService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./ScheduledTaskService.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

const START_ISO = "2026-10-21T06:40:00.000Z";
const START = Date.parse(START_ISO);
const TEN_MINUTES = 10 * 60_000;
const THREAD = "thread-on-copilot";
const COORDINATOR = "coordinator-aide";
const NOT_PREPARED =
  "Copilot 1.0.101 is not prepared. Use Install / update agent in Settings → Providers.";

const decodeTaskInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeTaskInput({
    title: "Inbox sweep",
    prompt: "Check the inbox and summarise anything new.",
    enabled: true,
    projectId: "aide",
    threadId: THREAD,
    schedule: { type: "interval", everyMs: TEN_MINUTES },
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const provider = (
  instanceId: string,
  driver: string,
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.98",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: START_ISO,
  models: [],
  slashCommands: [],
  skills: [],
  ...over,
});

const copilotReady = provider("acpRegistry_copilot", "acpRegistry", {
  displayName: "GitHub Copilot",
});
// The read taken after the failed run: still not ready.
const copilotNotPrepared: ServerProvider = {
  ...copilotReady,
  status: "error",
  message: NOT_PREPARED,
  checkedAt: "2026-10-21T06:50:00.000Z",
};
const codexReady = provider("codex", "codex", { displayName: "Codex" });

const harness = (initial: ReadonlyArray<ServerProvider>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const state = {
      providers: initial,
      sent: [] as Array<{ readonly threadId: string; readonly instanceId: string | undefined }>,
      poll: undefined as Effect.Effect<void> | undefined,
      // What the coordinator service resolves the bound thread's next turn to.
      nextTurn: undefined as ModelSelection | undefined,
      nextTurnAsked: [] as Array<string | null>,
      coordinatorWakes: 0,
      launched: [] as Array<string>,
    };
    const threadRow = (threadId: string, instanceId: string) =>
      sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "aide",
        title: "Inbox sweep",
        default_provider: "acpRegistry",
        provider_instance_id: instanceId,
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-10-21T00:00:00.000Z",
        updated_at: "2026-10-21T00:00:00.000Z",
        deleted_at: null,
        payload_json: "{}",
      })}`;
    yield* threadRow(THREAD, "acpRegistry_copilot");
    yield* threadRow(COORDINATOR, "acpRegistry_copilot");
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id: ProjectId) =>
          Effect.succeedSome({
            ...routineProject(id),
            workspaceSettings: {
              ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              coordinatorThreadId: ThreadId.make(COORDINATOR),
            },
          }),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            state.launched.push(input.modelSelection.instanceId);
            const threadId = ThreadId.make(`own-thread-${state.launched.length}`);
            yield* Effect.orDie(threadRow(threadId, input.modelSelection.instanceId));
            return { threadId, resumed: false, projection: { messages: [] } } as never;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            state.sent.push({
              threadId: input.threadId,
              instanceId: input.modelSelection?.instanceId,
            });
            return {} as never;
          }),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ProcessRunner.ProcessRunner)({}),
      Layer.mock(ProjectCoordinator.ProjectCoordinatorService)({
        start: () =>
          Effect.sync(() => {
            state.coordinatorWakes++;
            return { threadId: ThreadId.make(COORDINATOR), created: false };
          }),
        nextTurnModel: (_projectId, threadId) =>
          Effect.sync(() => {
            state.nextTurnAsked.push(threadId);
            return state.nextTurn;
          }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => state.providers),
      }),
      // The poll is run by hand so each fire is observed after it finished.
      Layer.mock(Scheduler.Scheduler)({
        register: (_name, runDueWork) =>
          Effect.map(Effect.context(), (context) => {
            state.poll = Effect.orDie(Effect.provideContext(runDueWork, context));
          }),
        heldMsBetween: () => Effect.succeed(0),
      }),
    );
    const run = <A, E, R>(
      body: (service: Service.ScheduledTaskService["Service"]) => Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Service.ScheduledTaskService;
          return yield* body(service);
        }).pipe(Effect.provide(Service.layer.pipe(Layer.provide(dependencies)))),
      );
    /** Moves the clock to the task's next run and runs the due poll once. */
    const fireNext = Effect.gen(function* () {
      const [row] = yield* sql<{ next_run_at: string }>`SELECT next_run_at FROM scheduled_tasks`;
      yield* TestClock.setTime(Date.parse(row!.next_run_at) + 1_000);
      yield* state.poll!;
    });
    const taskRow = Effect.map(
      sql<{
        enabled: number;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
        schedule_json: string;
      }>`SELECT enabled, last_run_status, last_run_error, next_run_at, run_count, schedule_json FROM scheduled_tasks`,
      (rows) => rows[0]!,
    );
    /** A thread's latest run failed because its provider could not open a session. */
    const failRunOnCopilot = (completedAt: string, threadId: string = THREAD) =>
      Effect.gen(function* () {
        const runId = `run-${threadId}`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: runId,
          thread_id: threadId,
          ordinal: 1,
          provider: "acpRegistry",
          provider_instance_id: "acpRegistry_copilot",
          provider_thread_id: null,
          status: "failed",
          requested_at: "2026-10-21T06:44:00.000Z",
          completed_at: completedAt,
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
          turn_item_id: `item-${threadId}`,
          thread_id: threadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal: 1,
          type: "error",
          status: "failed",
          updated_at: completedAt,
          payload_json: JSON.stringify({
            type: "error",
            failure: {
              class: "provider_error",
              code: "provider_unavailable",
              message: NOT_PREPARED,
              retryable: false,
            },
          }),
        })}`;
      });
    return { state, run, fireNext, taskRow, failRunOnCopilot };
  });

it.effect(
  "skips a 10-minute routine whose thread failed as provider_unavailable, then fires once a newer read is ready",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
        copilotNotPrepared,
        codexReady,
      ]);
      yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput());
          const before = yield* taskRow;

          yield* fireNext;
          assert.deepEqual(state.sent, []);
          const skipped = yield* taskRow;
          assert.equal(skipped.last_run_status, "failed");
          assert.equal(
            skipped.last_run_error,
            `Skipped: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
          );
          // Not paused and the schedule is untouched: the next fire checks again.
          assert.equal(skipped.enabled, 1);
          assert.equal(skipped.schedule_json, before.schedule_json);
          assert.equal(skipped.run_count, 1);
          assert.isAbove(Date.parse(skipped.next_run_at!), Date.parse(before.next_run_at!));

          yield* fireNext;
          assert.deepEqual(state.sent, []);
          assert.equal((yield* taskRow).run_count, 2);

          // A ready read from before the failure does not clear it; a newer one does.
          state.providers = [copilotReady, codexReady];
          yield* fireNext;
          assert.deepEqual(state.sent, []);

          state.providers = [
            { ...copilotReady, checkedAt: "2026-10-21T07:30:00.000Z" },
            codexReady,
          ];
          yield* fireNext;
          // An unpinned run keeps the thread's provider: no model is sent.
          assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: undefined }]);
          const fired = yield* taskRow;
          assert.equal(fired.last_run_status, "succeeded");
          assert.isNull(fired.last_run_error);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires as before when the provider is unknown or awaiting its first check", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const awaiting = provider("acpRegistry_copilot", "acpRegistry", {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Provider status has not been checked in this session yet.",
    });
    const { state, run, fireNext, taskRow } = yield* harness([awaiting]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        state.providers = [codexReady];
        yield* fireNext;
        assert.equal(state.sent.length, 2);
        assert.equal((yield* taskRow).last_run_status, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "skips while the thread's latest run failed as provider_unavailable until a later check finds it ready",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      // The snapshot was taken before the failure and still reads ready.
      const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([copilotReady]);
      yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput());
          yield* fireNext;
          assert.deepEqual(state.sent, []);
          assert.equal(
            (yield* taskRow).last_run_error,
            `Skipped: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
          );

          state.providers = [{ ...copilotReady, checkedAt: "2026-10-21T07:30:00.000Z" }];
          yield* fireNext;
          assert.equal(state.sent.length, 1);
          assert.equal((yield* taskRow).last_run_status, "succeeded");
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a pinned routine's own provider and never reroutes it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
      copilotNotPrepared,
      codexReady,
    ]);
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    yield* run((service) =>
      Effect.gen(function* () {
        // Pinned to Codex: the thread's broken Copilot does not matter.
        const { task } = yield* service.upsert(
          taskInput({ modelPinned: true, modelSelection: { instanceId: "codex", model: "gpt-5" } }),
        );
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: "codex" }]);

        // Pinned to the broken Copilot: skipped, not moved to the ready Codex.
        yield* service.upsert(
          taskInput({
            id: task.id,
            modelPinned: true,
            modelSelection: { instanceId: "acpRegistry_copilot", model: "claude-opus-5.5" },
          }),
        );
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        assert.match((yield* taskRow).last_run_error ?? "", /^Skipped: GitHub Copilot/);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires on a provider that reports warning but can still run turns", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // Installed and checked, but subscription sign-in unverified: turns still run.
    const copilotWarning = provider("acpRegistry_copilot", "acpRegistry", {
      displayName: "GitHub Copilot",
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify the subscription sign-in.",
    });
    const { state, run, fireNext, taskRow } = yield* harness([copilotWarning]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        const fired = yield* taskRow;
        assert.equal(fired.last_run_status, "succeeded");
        assert.isNull(fired.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a coordinator thread on the model its next turn resolves to", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // The coordinator thread last ran on the broken Copilot; the user moved
    // the coordinator model to Codex to recover.
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
      copilotNotPrepared,
      codexReady,
    ]);
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    state.nextTurn = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: "codex" }]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");

        // Back on the broken Copilot: skipped with its reason.
        state.nextTurn = {
          instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
          model: "claude-opus-5.5",
        };
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        assert.equal(
          (yield* taskRow).last_run_error,
          `Skipped: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a threadless routine on the coordinator it wakes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // The coordinator's last run failed on Copilot, which its next turn still uses.
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
      copilotNotPrepared,
      codexReady,
    ]);
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z", COORDINATOR);
    state.nextTurn = {
      instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
      model: "claude-opus-5.5",
    };
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ threadId: null }));
        yield* fireNext;
        // Asked before the coordinator is started, the way a wake resolves it.
        assert.deepEqual(state.nextTurnAsked, [null]);
        assert.equal(state.coordinatorWakes, 0);
        assert.deepEqual(state.sent, []);
        assert.equal(
          (yield* taskRow).last_run_error,
          `Skipped: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
        );

        // The coordinator model moved to Codex: the wake goes through.
        state.nextTurn = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
        yield* fireNext;
        assert.equal(state.coordinatorWakes, 1);
        assert.deepEqual(state.sent, [{ threadId: COORDINATOR, instanceId: "codex" }]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a routine that starts its own thread on the model the launch uses", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const copilotDisabled: ServerProvider = { ...copilotReady, enabled: false };
    const { state, run, fireNext, taskRow } = yield* harness([copilotDisabled, codexReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        // Unpinned: the launch still starts the thread on the routine's model.
        yield* service.upsert(
          taskInput({
            threadId: null,
            ownThread: true,
            modelSelection: { instanceId: "acpRegistry_copilot", model: "claude-opus-5.5" },
          }),
        );
        yield* fireNext;
        assert.deepEqual(state.launched, []);
        assert.equal(
          (yield* taskRow).last_run_error,
          "Skipped: GitHub Copilot cannot start on this machine: It is disabled.",
        );

        state.providers = [copilotReady, codexReady];
        yield* fireNext;
        assert.deepEqual(state.launched, ["acpRegistry_copilot"]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("skips a signed-out or unavailable provider without any failed run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const signedOut: ServerProvider = {
      ...copilotReady,
      auth: { status: "unauthenticated" },
    };
    const unavailable: ServerProvider = {
      ...copilotReady,
      availability: "unavailable",
      unavailableReason: "GitHub Copilot is not supported on this platform.",
    };
    const { state, run, fireNext, taskRow } = yield* harness([signedOut]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.equal(
          (yield* taskRow).last_run_error,
          "Skipped: GitHub Copilot cannot start on this machine: It is signed out.",
        );
        state.providers = [unavailable];
        yield* fireNext;
        assert.equal(
          (yield* taskRow).last_run_error,
          "Skipped: GitHub Copilot cannot start on this machine: GitHub Copilot is not supported on this platform.",
        );
        assert.deepEqual(state.sent, []);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires on states a session start repairs when no run failed on it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // An on-demand ACP agent whose binary is not on disk yet: a session start installs it.
    const notDownloaded = provider("acpRegistry_copilot", "acpRegistry", {
      displayName: "GitHub Copilot",
      installed: false,
      version: "1.0.101",
      status: "warning",
      message: "GitHub Copilot 1.0.101 has not been prepared.",
    });
    // One health probe timed out: a real start refreshes the status and runs.
    const probeTimedOut = provider("claudeAgent", "claudeAgent", {
      displayName: "Claude",
      status: "error",
      message: "Claude is installed but failed to run. Timed out.",
    });
    const { state, run, fireNext, taskRow } = yield* harness([notDownloaded, probeTimedOut]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: undefined }]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");

        yield* service.upsert(
          taskInput({
            id: task.id,
            modelPinned: true,
            modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5.5" },
          }),
        );
        yield* fireNext;
        assert.deepEqual(state.sent[1], { threadId: THREAD, instanceId: "claudeAgent" });
        const fired = yield* taskRow;
        assert.equal(fired.last_run_status, "succeeded");
        assert.isNull(fired.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
