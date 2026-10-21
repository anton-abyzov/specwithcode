import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  RunId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Reactor from "./ScheduledTaskRunReactor.ts";
import * as Service from "./ScheduledTaskService.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

const taskInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
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
});

const serviceLayer = Service.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id: ProjectId) => Effect.succeed(Option.some(routineProject(id))),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: () => Effect.succeed({ threadId: "synthetic", resumed: false } as never),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ProcessRunner.ProcessRunner)({}),
      Layer.mock(Scheduler.Scheduler)({
        register: () => Effect.void,
        heldMsBetween: () => Effect.succeed(0),
      }),
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);

const at = (isoValue: string) => DateTime.makeUnsafe(isoValue);

it.effect("records a dispatched routine's failed turn on the task once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T19:00:00.000Z"));
    const service = yield* Service.ScheduledTaskService;
    const { task } = yield* service.upsert(taskInput);
    const ran = yield* service.runNow({ id: task.id });
    assert.equal(ran.task.lastRunStatus, "succeeded", ran.task.lastRunError ?? "");
    assert.isNull(ran.task.lastRunError);

    const input = {
      id: task.id,
      requestedAt: at("2026-10-21T19:00:00.100Z"),
      error: "This provider instance is disabled.",
    };
    assert.equal(yield* service.recordTurnFailure(input), "recorded");
    const [stored] = (yield* service.list()).tasks;
    assert.equal(stored?.lastRunStatus, "failed");
    assert.equal(stored?.lastRunError, "This provider instance is disabled.");
    assert.equal(stored?.runCount, 1);
    assert.equal(stored?.nextRunAt, ran.task.nextRunAt);
    assert.equal(yield* service.recordTurnFailure(input), "stale");
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("reports running while the dispatch is not recorded yet", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T19:00:00.000Z"));
    const service = yield* Service.ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    const { task } = yield* service.upsert(taskInput);
    yield* service.runNow({ id: task.id });
    yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', last_run_error = NULL`;
    const input = {
      id: task.id,
      requestedAt: at("2026-10-21T19:00:00.100Z"),
      error: "This provider instance is disabled.",
    };
    assert.equal(yield* service.recordTurnFailure(input), "running");
    const [stored] = (yield* service.list()).tasks;
    assert.equal(stored?.lastRunStatus, "running");
    assert.isNull(stored?.lastRunError);
  }).pipe(Effect.provide(serviceLayer)),
);

it.effect("leaves a later run alone when an older turn fails", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-21T19:00:00.000Z"));
    const service = yield* Service.ScheduledTaskService;
    const { task } = yield* service.upsert(taskInput);
    yield* service.runNow({ id: task.id });
    const outcome = yield* service.recordTurnFailure({
      id: task.id,
      requestedAt: at("2026-10-21T18:59:59.000Z"),
      error: "Older turn failed.",
    });
    assert.equal(outcome, "stale");
    const [stored] = (yield* service.list()).tasks;
    assert.equal(stored?.lastRunStatus, "succeeded");
    assert.isNull(stored?.lastRunError);
    const unknown = yield* service.recordTurnFailure({
      id: ScheduledTaskId.make("missing"),
      requestedAt: at("2026-10-21T19:00:01.000Z"),
      error: "Nothing to record.",
    });
    assert.equal(unknown, "stale");
  }).pipe(Effect.provide(serviceLayer)),
);

const threadId = ThreadId.make("thread-routine");
const userMessageId = MessageId.make("message-routine");
const failedRun = (status: OrchestrationV2Run["status"]) =>
  ({
    type: "run.updated",
    payload: {
      id: RunId.make("run-routine"),
      threadId,
      userMessageId,
      status,
      requestedAt: at("2026-10-21T19:00:00.100Z"),
    },
  }) as unknown as OrchestrationV2DomainEvent;

const reactorHarness = (input: {
  readonly scheduledTaskId?: string;
  readonly errorMessage?: string;
  readonly outcomes: Array<"recorded" | "running" | "stale">;
}) => {
  const recorded: Array<{ id: string; error: string; requestedAt: string }> = [];
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: () =>
        Effect.succeed({
          messages: [
            {
              id: userMessageId,
              ...(input.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.scheduledTaskId }),
            },
          ],
          turnItems:
            input.errorMessage === undefined
              ? []
              : [
                  {
                    type: "error",
                    runId: RunId.make("run-routine"),
                    failure: { message: input.errorMessage },
                  },
                ],
        } as never),
    }),
    Layer.mock(Service.ScheduledTaskService)({
      recordTurnFailure: (failure) =>
        Effect.sync(() => {
          recorded.push({
            id: failure.id,
            error: failure.error,
            requestedAt: DateTime.formatIso(failure.requestedAt),
          });
          return input.outcomes.shift() ?? "stale";
        }),
    }),
  );
  return { recorded, layer };
};

it.effect("copies the failed turn's error to its routine, waiting for the dispatch record", () =>
  Effect.gen(function* () {
    const harness = reactorHarness({
      scheduledTaskId: "routine",
      errorMessage: "This provider instance is disabled.",
      outcomes: ["running", "recorded"],
    });
    yield* Effect.gen(function* () {
      const reactor = yield* Reactor.make;
      yield* reactor.observeEvent(failedRun("completed"));
      assert.deepEqual(harness.recorded, []);
      const observing = yield* Effect.forkChild(reactor.observeEvent(failedRun("failed")));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(observing);
    }).pipe(Effect.provide(harness.layer));
    assert.deepEqual(harness.recorded, [
      {
        id: "routine",
        error: "This provider instance is disabled.",
        requestedAt: "2026-10-21T19:00:00.100Z",
      },
      {
        id: "routine",
        error: "This provider instance is disabled.",
        requestedAt: "2026-10-21T19:00:00.100Z",
      },
    ]);
  }),
);

it.effect(
  "ignores failed turns that no routine sent and falls back when no error item exists",
  () =>
    Effect.gen(function* () {
      const manual = reactorHarness({ outcomes: [] });
      yield* Reactor.make.pipe(
        Effect.flatMap((reactor) => reactor.observeEvent(failedRun("failed"))),
        Effect.provide(manual.layer),
      );
      assert.deepEqual(manual.recorded, []);

      const silent = reactorHarness({ scheduledTaskId: "routine", outcomes: ["recorded"] });
      yield* Reactor.make.pipe(
        Effect.flatMap((reactor) => reactor.observeEvent(failedRun("failed"))),
        Effect.provide(silent.layer),
      );
      assert.equal(silent.recorded[0]?.error, Reactor.TURN_FAILED_FALLBACK);
    }),
);
