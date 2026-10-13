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
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

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
import { awaitGateOpen, makeGatedHold } from "./UpdateInstallGate.testkit.ts";

const NOW = Date.parse("2026-10-12T20:00:00.000Z");

/** Gives forked work real time to reach its next step after the test clock moved. */
const settle = TestClock.withLive(Effect.sleep(Duration.millis(20)));

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
});
