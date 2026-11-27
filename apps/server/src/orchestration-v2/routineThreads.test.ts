import { assert, it } from "@effect/vitest";
import { type ScheduledTask, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as Sqlite from "../persistence/Sqlite.ts";
import { bindOwnThread } from "../scheduledTasks/ScheduledTaskOwnThread.ts";
import {
  harness,
  taskInput,
} from "../scheduledTasks/ScheduledTaskService.coordinatorGate.testkit.ts";
import { routineThreadIds, skipsRowUltracode } from "./routineThreads.ts";

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
