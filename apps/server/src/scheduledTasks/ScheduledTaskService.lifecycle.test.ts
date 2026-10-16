import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, ScheduledTaskUpsertInput, type ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectCoordinator from "../project/ProjectCoordinatorService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./ScheduledTaskService.ts";
import { DEFAULT_PROJECT_WORKSPACE_SETTINGS } from "../../../../packages/contracts/src/projectWorkspace.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

const decodeTaskInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeTaskInput({
    id: "routine",
    title: "Synthetic review",
    prompt: "Review synthetic fixture",
    enabled: true,
    projectId: "project-a",
    schedule: { type: "interval", everyMs: 60000 },
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });
const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = {
    policy: "active",
    launches: 0,
    sends: 0,
    dispatchGate: Effect.void,
    dispatchStarted: Effect.void,
    due: Effect.void as Effect.Effect<void, never, SqlClient.SqlClient>,
    heldMs: 0,
    sent: [] as Array<{ readonly modelSelection?: unknown }>,
    nextTurnModel: undefined as { instanceId: string; model: string } | undefined,
  };
  const dependencies = () =>
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id: ProjectId) =>
          Effect.sync(() =>
            state.policy === "deleted"
              ? Option.none()
              : Option.some({
                  ...routineProject(id),
                  workspaceSettings: {
                    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                    paused: state.policy === "paused",
                    archived: state.policy === "archived",
                  },
                }),
          ),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: () =>
          Effect.sync(() => {
            state.launches++;
          }).pipe(
            Effect.andThen(Effect.suspend(() => state.dispatchStarted)),
            Effect.andThen(Effect.suspend(() => state.dispatchGate)),
            Effect.as({ threadId: "synthetic", resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            state.sends++;
            state.sent.push(input);
            return {} as never;
          }),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ProjectCoordinator.ProjectCoordinatorService)({
        nextTurnModel: () => Effect.sync(() => state.nextTurnModel as never),
      }),
      Layer.mock(Scheduler.Scheduler)({
        register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<R>();
            state.due = work.pipe(Effect.provideContext(context), Effect.orDie);
          }),
        heldMsBetween: () => Effect.sync(() => state.heldMs),
      }),
    );
  const run = <A, E, R>(
    body: (service: Service.ScheduledTaskService["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Service.ScheduledTaskService;
        return yield* body(service);
      }).pipe(Effect.provide(Service.layer.pipe(Layer.provide(dependencies())))),
    );
  const seedThread = (id: string, projectId: string, deletedAt: string | null = null) =>
    sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: id, project_id: projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: deletedAt, payload_json: "{}" })}`;
  return { state, run, sql, seedThread };
});

it.effect("refuses manual and due routines for paused, archived or deleted projects", () =>
  Effect.gen(function* () {
    const { state, run, sql } = yield* harness;
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        for (const policy of ["paused", "archived", "deleted"]) {
          state.policy = policy;
          const failure = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
          assert.include(failure.message, policy === "deleted" ? "unavailable" : policy);
          yield* sql`UPDATE scheduled_tasks SET next_run_at = '1970-01-01T00:00:00.000Z'`;
          yield* state.due;
          assert.equal(state.launches, 0);
          const [row] = yield* sql<{
            run_count: number;
            last_run_status: string;
          }>`SELECT run_count,last_run_status FROM scheduled_tasks`;
          assert.equal(row?.run_count, 0);
          assert.equal(row?.last_run_status, "never");
        }
        state.policy = "active";
        yield* state.due;
        yield* state.due;
        assert.equal(state.launches, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("runs a fixed-time slot held back by an update hold instead of skipping it", () =>
  Effect.gen(function* () {
    const { state, run, sql } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-07-01T09:30:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }));
        const slot = "2026-07-01T09:00:00.000Z";
        const nextRunAt = Effect.map(
          sql<{ next_run_at: string }>`SELECT next_run_at FROM scheduled_tasks`,
          (rows) => rows[0]?.next_run_at,
        );
        // Thirty minutes late with nothing held: missed, moved to the next occurrence.
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${slot}`;
        yield* state.due;
        assert.equal(state.launches, 0);
        assert.isAbove(Date.parse((yield* nextRunAt) ?? ""), Date.parse("2026-07-01T09:30:00Z"));

        // The same slot, but the scheduler sat out 25 of those minutes for an update.
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${slot}`;
        state.heldMs = 25 * 60_000;
        yield* state.due;
        assert.equal(state.launches, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("requires the bound thread to belong to the routine project and still exist", () =>
  Effect.gen(function* () {
    const { run, state, seedThread } = yield* harness;
    yield* seedThread("foreign", "project-b");
    yield* seedThread("deleted", "project-a", "2026-10-09T00:00:00Z");
    yield* seedThread("valid", "project-a");
    yield* run((service) =>
      Effect.gen(function* () {
        for (const threadId of ["foreign", "deleted", "missing"]) {
          const { task } = yield* service.upsert(taskInput({ threadId }));
          assert.include(
            (yield* service.runNow({ id: task.id }).pipe(Effect.flip)).message,
            "destination",
          );
        }
        assert.equal(state.sends, 0);
        const { task } = yield* service.upsert(taskInput({ threadId: "valid" }));
        yield* service.runNow({ id: task.id });
        assert.equal(state.sends, 1);
        assert.equal(state.launches, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("runs in a bound thread on the coordinator's next model, not the one saved with it", () =>
  Effect.gen(function* () {
    const { run, state, seedThread } = yield* harness;
    yield* seedThread("bound", "project-a");
    yield* run((service) =>
      Effect.gen(function* () {
        // Saved while the coordinator was on its fallback: never reused.
        const { task } = yield* service.upsert(taskInput({ threadId: "bound" }));
        yield* service.runNow({ id: task.id });
        assert.isFalse("modelSelection" in state.sent[0]!);
        state.nextTurnModel = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
        yield* service.runNow({ id: task.id, commandId: CommandId.make("second-run") });
        assert.deepEqual(state.sent[1]?.modelSelection, state.nextTurnModel);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "replays completed manual commands once across service restart and refuses command reuse",
  () =>
    Effect.gen(function* () {
      const { run, state, sql } = yield* harness;
      const commandId = CommandId.make("retryable-run");
      const original = yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(taskInput());
          const first = yield* service.runNow({ id: task.id, commandId });
          assert.deepEqual(yield* service.runNow({ id: task.id, commandId }), first);
          return first;
        }),
      );
      yield* run((service) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* service.runNow({ id: original.task.id, commandId }), original);
          assert.equal(state.launches, 1);
          const [row] = yield* sql<{ run_count: number }>`SELECT run_count FROM scheduled_tasks`;
          assert.equal(row?.run_count, 1);
          const other = yield* service.upsert(taskInput({ id: "other-routine" }));
          assert.include(
            (yield* service.runNow({ id: other.task.id, commandId }).pipe(Effect.flip)).message,
            "another routine",
          );
          yield* service.runNow({
            id: original.task.id,
            commandId: CommandId.make("intentional-next-run"),
          });
          assert.equal(state.launches, 2);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("does not redeliver an uncertain pre-crash command", () =>
  Effect.gen(function* () {
    const { run, state, sql } = yield* harness;
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        yield* sql`INSERT INTO scheduled_task_run_receipts (command_id,task_id,project_id,task_created_at,started_at) VALUES ('pending-run',${task.id},${task.projectId},${task.createdAt},${task.createdAt})`;
        const failure = yield* service
          .runNow({ id: task.id, commandId: CommandId.make("pending-run") })
          .pipe(Effect.flip);
        assert.include(failure.message, "already admitted");
        assert.equal(failure.reason, "run_outcome_unknown");
        assert.equal(state.launches, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("retains an uncertain receipt after dispatch succeeds but saving its result fails", () =>
  Effect.gen(function* () {
    const { run, state, sql } = yield* harness;
    const commandId = CommandId.make("receipt-write-failure");
    const task = yield* run((service) =>
      service.upsert(taskInput()).pipe(Effect.map((result) => result.task)),
    );
    yield* sql`CREATE TEMP TRIGGER reject_completed_run_receipt
      BEFORE UPDATE OF result_json ON scheduled_task_run_receipts
      WHEN NEW.result_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'synthetic result receipt failure'); END`;
    const failure = yield* run((service) =>
      service.runNow({ id: task.id, commandId }).pipe(Effect.flip),
    );
    assert.equal(failure.reason, "run_outcome_unknown");
    assert.include(failure.message, "Run dispatched but its receipt could not be saved");
    assert.equal(state.launches, 1);
    assert.equal(state.sends, 0);
    const rows = () => sql`SELECT * FROM scheduled_task_run_receipts WHERE command_id=${commandId}`;
    const pending = yield* rows();
    assert.equal(pending.length, 1);
    assert.isNull(pending[0]!.result_json);
    assert.equal(
      (yield* sql<{
        run_count: number;
      }>`SELECT run_count FROM scheduled_tasks WHERE task_id=${task.id}`)[0]?.run_count,
      1,
    );
    yield* sql`DROP TRIGGER reject_completed_run_receipt`;
    // Rebuild the service after the transient storage fault is gone: uncertainty still forbids replay.
    const retried = yield* run((service) =>
      service.runNow({ id: task.id, commandId }).pipe(Effect.flip),
    );
    assert.equal(retried.reason, "run_outcome_unknown");
    assert.include(retried.message, "already admitted");
    assert.equal(state.launches, 1);
    assert.equal(state.sends, 0);
    assert.deepEqual(yield* rows(), pending);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("rejects concurrent manual retries without changing the running owner's record", () =>
  Effect.gen(function* () {
    const { run, state, sql } = yield* harness;
    const started = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    state.dispatchStarted = Deferred.succeed(started, undefined).pipe(Effect.asVoid);
    state.dispatchGate = Deferred.await(release);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        const commandId = CommandId.make("concurrent-command");
        const first = yield* service.runNow({ id: task.id, commandId }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        assert.include(
          (yield* service.runNow({ id: task.id, commandId }).pipe(Effect.flip)).message,
          "already admitted",
        );
        yield* service
          .runNow({ id: task.id, commandId: CommandId.make("other-command") })
          .pipe(Effect.flip);
        const [running] = yield* sql<{
          last_run_status: string;
          run_count: number;
        }>`SELECT last_run_status,run_count FROM scheduled_tasks`;
        assert.equal(running?.last_run_status, "running");
        assert.equal(running?.run_count, 0);
        assert.equal(state.launches, 1);
        yield* Deferred.succeed(release, undefined);
        const completed = yield* Fiber.join(first);
        assert.equal(completed.task.lastRunStatus, "succeeded");
        assert.equal(completed.task.runCount, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "deletion purges receipt content and a late completion cannot restore it after recreation",
  () =>
    Effect.gen(function* () {
      const { run, state, sql } = yield* harness;
      const started = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      state.dispatchStarted = Deferred.succeed(started, undefined).pipe(Effect.asVoid);
      state.dispatchGate = Deferred.await(release);
      yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(taskInput());
          const commandId = CommandId.make("deleted-command");
          const first = yield* service.runNow({ id: task.id, commandId }).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* service.delete({ id: task.id });
          // The test clock deliberately reuses createdAt: the receipt tombstone must
          // defeat this ABA case without relying on wall-clock uniqueness.
          yield* service.upsert(taskInput());
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          const [receipt] = yield* sql<{
            result_json: string | null;
            task_created_at: string;
          }>`SELECT result_json,task_created_at FROM scheduled_task_run_receipts WHERE command_id = ${commandId}`;
          assert.equal(receipt?.result_json, null);
          assert.equal(receipt?.task_created_at, "");
          const failure = yield* service.runNow({ id: task.id, commandId }).pipe(Effect.flip);
          assert.equal(failure.reason, "run_command_conflict");
          assert.equal(state.launches, 1);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
