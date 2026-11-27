import { assert, it } from "@effect/vitest";
import { type ScheduledTask, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as Sqlite from "../persistence/Sqlite.ts";
import { bindOwnThread } from "../scheduledTasks/ScheduledTaskOwnThread.ts";
import {
  harness,
  taskInput,
} from "../scheduledTasks/ScheduledTaskService.coordinatorGate.testkit.ts";
import { continuedRunId, routineThreadIds, skipsRowUltracode } from "./routineThreads.ts";

it.effect("lists the threads routines run in, their own or a person's (1506)", () =>
  Effect.gen(function* () {
    const { run, seedThread } = yield* harness;
    yield* seedThread("person-thread", "project-a");
    yield* seedThread("quiet-thread", "project-a");
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ id: "own" }));
        yield* service.upsert(taskInput({ id: "bound", threadId: "person-thread" }));
      }),
    );
    yield* bindOwnThread({
      taskId: "own" as ScheduledTask["id"],
      replacing: null,
      threadId: ThreadId.make("routine-thread"),
      updatedAt: "2026-11-27T12:00:00.000Z",
    });
    assert.deepEqual([...(yield* routineThreadIds)].toSorted(), [
      "person-thread",
      "routine-thread",
    ]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("is empty without a database", () =>
  Effect.gen(function* () {
    assert.equal((yield* routineThreadIds).size, 0);
  }),
);

it("skips row Ultracode for a routine's thread and the coordinator only", () => {
  const routines = new Set(["routine-thread"]);
  const project = { workspaceSettings: { coordinatorThreadId: "coordinator" } };
  assert.isTrue(skipsRowUltracode("routine-thread", routines, project));
  assert.isTrue(skipsRowUltracode("coordinator", routines, project));
  assert.isFalse(skipsRowUltracode("worker", routines, project));
  assert.isFalse(skipsRowUltracode("worker", routines, { workspaceSettings: null }));
});

it("finds the run an automatic continuation continues, and nothing for other messages", () => {
  assert.equal(continuedRunId("limit-fallback:t:1:run:t:1:ordinal:2", "t:1"), "run:t:1:ordinal:2");
  assert.equal(continuedRunId("provider-fallback:t1:hop-2:r1", "t1"), "r1");
  assert.equal(continuedRunId("limit-credits:t1:r3", "t1"), "r3");
  assert.isNull(continuedRunId("limit-fallback:other:r1", "t1"));
  assert.isNull(continuedRunId("routine:task-1:t1", "t1"));
  assert.isNull(continuedRunId("m1", "t1"));
});
