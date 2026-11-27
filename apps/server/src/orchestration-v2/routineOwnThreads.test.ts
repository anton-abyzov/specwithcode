import { assert, it } from "@effect/vitest";
import { type ScheduledTask, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as Sqlite from "../persistence/Sqlite.ts";
import { bindOwnThread } from "../scheduledTasks/ScheduledTaskOwnThread.ts";
import { harness, taskInput } from "../scheduledTasks/ScheduledTaskService.coordinatorGate.testkit.ts";
import { routineOwnThreadIds } from "./routineOwnThreads.ts";

it.effect("lists only the threads routines started as their own (1506)", () =>
  Effect.gen(function* () {
    const { run, seedThread } = yield* harness;
    yield* seedThread("person-thread", "project-a");
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ id: "own" }));
        // A routine that posts into a person's thread does not own it.
        yield* service.upsert(taskInput({ id: "bound", threadId: "person-thread" }));
      }),
    );
    yield* bindOwnThread({
      taskId: "own" as ScheduledTask["id"],
      replacing: null,
      threadId: ThreadId.make("routine-thread"),
      updatedAt: "2026-11-27T12:00:00.000Z",
    });
    assert.deepEqual([...(yield* routineOwnThreadIds)], ["routine-thread"]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("is empty without a database", () =>
  Effect.gen(function* () {
    assert.equal((yield* routineOwnThreadIds).size, 0);
  }),
);
