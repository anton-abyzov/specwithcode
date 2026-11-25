import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  type ProjectId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
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

// Text a nested cause can carry that must never reach the task record agents and the UI read.
const PRIVATE_DETAIL = "token=sk-private-value at /Users/someone/private/state.json";

const serviceWithLaunchFailure = (failure: unknown) =>
  Service.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (id: ProjectId) => Effect.succeed(Option.some(routineProject(id))),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: () => Effect.fail(failure as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(null),
        }),
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

const lastRunErrorAfterRun = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-24T19:00:00.000Z"));
  const service = yield* Service.ScheduledTaskService;
  const { task } = yield* service.upsert(taskInput);
  const ran = yield* service.runNow({ id: task.id });
  assert.equal(ran.task.lastRunStatus, "failed");
  return ran.task.lastRunError ?? "";
});

it.effect("keeps a failed dispatch's own reason, without its nested cause or stack", () =>
  Effect.gen(function* () {
    const lastRunError = yield* lastRunErrorAfterRun;
    assert.equal(lastRunError, "The provider refused the turn.");
  }).pipe(
    Effect.provide(
      serviceWithLaunchFailure(
        new Error("The provider refused the turn.", { cause: new Error(PRIVATE_DETAIL) }),
      ),
    ),
  ),
);

it.effect("keeps an orchestration refusal short and free of nested detail", () =>
  Effect.gen(function* () {
    const lastRunError = yield* lastRunErrorAfterRun;
    assert.notInclude(lastRunError, "sk-private-value");
    assert.notInclude(lastRunError, "/Users/someone");
    assert.notInclude(lastRunError, "\n");
    assert.isAbove(lastRunError.length, 0);
  }).pipe(
    Effect.provide(
      serviceWithLaunchFailure(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command-1"),
          commandType: "thread.turn.start",
          cause: { error: new Error(PRIVATE_DETAIL) },
        }),
      ),
    ),
  ),
);
