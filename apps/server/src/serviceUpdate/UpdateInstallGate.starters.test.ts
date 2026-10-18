/**
 * Every source that starts work on its own stays quiet in a process the update helper
 * restarted, until the helper clears its install gate. One test per starter; the
 * orchestrator, provider continuation, pull request sync, Telegram, webhooks and terminals
 * are covered beside their own harnesses.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, DEFAULT_SERVER_SETTINGS, ScheduledTaskId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { stringifyJson } from "../json.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PullRequestWatchReactor from "../orchestration-v2/PullRequestWatchReactor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitAvailability from "../orchestration-v2/UsageLimitAvailability.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { activeProjects } from "../scheduledTasks/ScheduledTaskService.test-fixtures.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Hold from "./ServiceUpdateHold.ts";
import * as Gate from "./UpdateInstallGate.ts";
import { GATE_POLL_MS, awaitGateOpen, makeGatedHold } from "./UpdateInstallGate.testkit.ts";

const NOW = Date.parse("2026-10-12T20:00:00.000Z");

/** Gives forked work real time to reach its next step after the test clock moved. */
const settle = TestClock.withLive(Effect.sleep(Duration.millis(20)));

/** A routine row as a running service keeps it; `overrides` set what a test needs. */
const insertTask = (taskId: string, overrides: Record<string, string | number | null>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const created = "2026-10-12T19:00:00.000Z";
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: taskId,
      title: "task",
      prompt: "Run task",
      enabled: 1,
      schedule_json: '{"type":"interval","everyMs":300000}',
      project_id: "project:test",
      thread_id: null,
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "user",
      creation_source: "web",
      created_at: created,
      updated_at: created,
      next_run_at: created,
      last_run_at: null,
      last_run_status: "never",
      last_run_error: null,
      run_count: 0,
      ...overrides,
    })}`;
  });

/** Every column of every routine, as the update helper hashes them. */
const routineRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`SELECT * FROM scheduled_tasks ORDER BY task_id`,
);

/** The schedule service with a launcher that only counts, held by `hold`. */
const buildScheduledTasks = (hold: Hold.ServiceUpdateHoldShape, launches: Ref.Ref<number>) =>
  Layer.build(
    Layer.provideMerge(
      ScheduledTaskService.layer,
      Layer.mergeAll(
        activeProjects,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Ref.update(launches, (count) => count + 1).pipe(
              Effect.andThen(Effect.die(new Error("launch recorded"))),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ).pipe(Layer.provide(Layer.succeed(Hold.ServiceUpdateHold, hold))),
  );

describe("while an install's gate is live", () => {
  it.effect("the scheduler runs no due work, at registration or on a tick", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const runs = yield* Ref.make(0);
      const ran = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* scheduler.register(
          "due",
          Ref.update(runs, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(ran, undefined)),
          ),
        );
        yield* settle;
        yield* TestClock.adjust("16 seconds");
        yield* settle;
        assert.equal(yield* Ref.get(runs), 0);

        yield* clear;
        assert.isTrue(yield* awaitGateOpen(hold));
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(ran);
      }).pipe(Effect.provide(Scheduler.layer), Effect.provideService(Hold.ServiceUpdateHold, hold));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("usage-limit recovery does not look for threads to resume", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const looked = yield* Ref.make(0);
      const lookedOnce = yield* Deferred.make<void>();
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getLimitRecoveryCandidates: () =>
                Ref.update(looked, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(lookedOnce, undefined)),
                  Effect.as([]),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            }),
            Layer.mock(UsageLimitAvailability.UsageLimitAvailability)({}),
          ),
        ),
        Layer.provide(Layer.succeed(Hold.ServiceUpdateHold, hold)),
      );
      yield* Layer.build(layer);
      yield* settle;
      yield* TestClock.adjust("16 seconds");
      yield* settle;
      assert.equal(yield* Ref.get(looked), 0);

      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(lookedOnce);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a scheduled task that came due during the restart waits for the gate", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const due = "2026-10-12T19:59:00.000Z";
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "due-during-restart",
        title: "task",
        prompt: "Run task",
        enabled: 1,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: "project:test",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: due,
        updated_at: due,
        next_run_at: due,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const launches = yield* Ref.make(0);
      const launched = yield* Deferred.make<void>();
      const context = yield* Layer.build(
        Layer.provideMerge(
          ScheduledTaskService.layer,
          Layer.mergeAll(
            activeProjects,
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Ref.update(launches, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(launched, undefined)),
                  Effect.andThen(Effect.die(new Error("launch recorded"))),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            NodeCrypto.layer,
            Scheduler.layer,
          ),
        ).pipe(Layer.provide(Layer.succeed(Hold.ServiceUpdateHold, hold))),
      );
      yield* settle;
      yield* TestClock.adjust("16 seconds");
      yield* settle;
      assert.equal(yield* Ref.get(launches), 0);
      // "Run now" is refused with the reason, before it writes its receipt.
      const service = Context.get(context, ScheduledTaskService.ScheduledTaskService);
      const refused = yield* Effect.flip(
        service.runNow({
          id: ScheduledTaskId.make("due-during-restart"),
          commandId: CommandId.make("run-now-gated"),
        }),
      );
      assert.equal(refused.message, Hold.SERVICE_UPDATE_VERIFYING_MESSAGE);
      const untouched = yield* sql<{ readonly last_run_status: string }>`
        SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-during-restart'`;
      assert.equal(untouched[0]?.last_run_status, "never");
      const receipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scheduled_task_run_receipts`;
      assert.equal(Number(receipts[0]?.count), 0);

      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(launched);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
    ),
  );

  it.effect("the pull request watch sweep reads nothing and wakes nobody", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const sweeps = yield* Ref.make(0);
      const swept = yield* Deferred.make<void>();
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadsWithPullRequests: () =>
                Ref.update(sweeps, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(swept, undefined)),
                  Effect.as([]),
                ),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            NodeCrypto.layer,
          ),
        ),
        Effect.provideService(Hold.ServiceUpdateHold, hold),
      );
      yield* reactor.start();
      yield* settle;
      yield* TestClock.adjust("3 minutes");
      yield* settle;
      assert.equal(yield* Ref.get(sweeps), 0);

      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.await(swept);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("settled effects are not pruned while the helper compares them", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const pruned = yield* Ref.make(0);
      const prunedOnce = yield* Deferred.make<void>();
      const outbox = {
        pruneSettled: Ref.update(pruned, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(prunedOnce, undefined)),
          Effect.as(0),
        ),
      } as unknown as EffectOutbox.EffectOutboxV2["Service"];
      yield* Layer.build(
        EffectOutbox.layerPruneWorker.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
              Layer.succeed(Hold.ServiceUpdateHold, hold),
            ),
          ),
        ),
      );
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.equal(yield* Ref.get(pruned), 0);

      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(prunedOnce);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a run interrupted by the restart is recovered only once the gate opens", () =>
    Effect.gen(function* () {
      // The old service was stopped mid-run: its row still says 'running'. Recovering it
      // rewrites status, next run, count and time, which the helper's comparison would see.
      const startedAt = "2026-10-12T19:58:00.000Z";
      yield* insertTask("interrupted", {
        next_run_at: "2026-10-12T19:58:00.000Z",
        last_run_at: startedAt,
        last_run_status: "running",
        run_count: 4,
      });
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const before = yield* routineRows;
      const launches = yield* Ref.make(0);
      yield* buildScheduledTasks(hold, launches);
      yield* settle;
      yield* TestClock.adjust("16 seconds");
      yield* settle;
      assert.deepEqual(yield* routineRows, before);

      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* TestClock.adjust(Duration.millis(GATE_POLL_MS));
      let rows = yield* routineRows;
      for (let attempt = 0; attempt < 100 && rows[0]?.last_run_status === "running"; attempt += 1) {
        yield* settle;
        rows = yield* routineRows;
      }
      assert.equal(rows[0]?.last_run_status, "failed");
      assert.equal(rows[0]?.last_run_error, "Run was interrupted by a server restart.");
      assert.equal(Number(rows[0]?.run_count), 5);
      assert.equal(yield* Ref.get(launches), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
    ),
  );

  it.effect("recovery after the gate leaves alone a run that started once it opened", () =>
    Effect.gen(function* () {
      yield* insertTask("interrupted", {
        next_run_at: "2026-10-12T19:58:00.000Z",
        last_run_at: "2026-10-12T19:58:00.000Z",
        last_run_status: "running",
        run_count: 4,
      });
      yield* insertTask("fresh", {
        next_run_at: "2026-10-12T21:00:00.000Z",
        last_run_at: null,
        last_run_status: "never",
        run_count: 0,
      });
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const launches = yield* Ref.make(0);
      yield* buildScheduledTasks(hold, launches);
      yield* settle;

      // The gate opens and, before recovery runs, another worker starts "fresh".
      yield* clear;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running',
        last_run_at = '2026-10-12T20:00:01.000Z' WHERE task_id = 'fresh'`;
      // And "interrupted" was already started again by its own recovery path elsewhere:
      // only the run seen at startup may be recovered.
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* TestClock.adjust(Duration.millis(GATE_POLL_MS));
      const statusOf = (id: string) =>
        sql<{ readonly last_run_status: string; readonly run_count: number }>`
          SELECT last_run_status, run_count FROM scheduled_tasks WHERE task_id = ${id}`;
      let interrupted = yield* statusOf("interrupted");
      for (
        let attempt = 0;
        attempt < 100 && interrupted[0]?.last_run_status === "running";
        attempt += 1
      ) {
        yield* settle;
        interrupted = yield* statusOf("interrupted");
      }
      assert.equal(interrupted[0]?.last_run_status, "failed");
      const fresh = yield* statusOf("fresh");
      assert.equal(fresh[0]?.last_run_status, "running");
      assert.equal(Number(fresh[0]?.run_count), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
    ),
  );

  it.effect("a gate written while the service runs stops a routine due right after it", () =>
    Effect.gen(function* () {
      // M4, 1.0.43 -> 1.0.45: a 5-minute routine came due 1 s after the helper's last row
      // check, and the old service ran it before its 5 s poll read the gate.
      const dueAt = "2026-10-12T20:00:01.000Z";
      yield* insertTask("merge-watcher", {
        next_run_at: dueAt,
        last_run_at: "2026-10-12T19:55:01.000Z",
        last_run_status: "succeeded",
        run_count: 26,
      });
      yield* TestClock.setTime(NOW);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const updates = yield* fs.makeTempDirectoryScoped({ prefix: "update-install-gate-late-" });
      const hold = yield* Hold.makeWithOptions({
        agentStatePath: path.join(updates, "state.json"),
        // No poll runs in this test: only the checks themselves read the gate.
        pollMs: 60 * 60_000,
        isAlive: () => true,
        bootMs: null,
      });
      const launches = yield* Ref.make(0);
      const context = yield* buildScheduledTasks(hold, launches);
      yield* settle;
      const before = yield* routineRows;

      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* fs.writeFileString(
        path.join(updates, Gate.INSTALL_GATE_FILE),
        stringifyJson({ helperPid: 4242, at }),
      );
      yield* TestClock.adjust("16 seconds");
      yield* settle;
      assert.deepEqual(yield* routineRows, before);
      assert.equal(yield* Ref.get(launches), 0);

      const service = Context.get(context, ScheduledTaskService.ScheduledTaskService);
      const refused = yield* Effect.flip(
        service.runNow({
          id: ScheduledTaskId.make("merge-watcher"),
          commandId: CommandId.make("run-now-late-gate"),
        }),
      );
      assert.equal(refused.message, Hold.SERVICE_UPDATE_VERIFYING_MESSAGE);
      assert.deepEqual(yield* routineRows, before);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer)),
    ),
  );
});
