import { assert, it } from "@effect/vitest";
import { COORDINATOR_ROUTINE_COPIES_MAX, type ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  COORDINATOR_ROUTINE_COPIES_MAX_BYTES,
  coordinatorRoutinesDigest,
  routineCopiesComplete,
  type RoutineCopies,
} from "./ScheduledTaskCopies.ts";
import { harness, taskInput } from "./ScheduledTaskService.coordinatorGate.testkit.ts";

const PROJECT = "project-a" as ProjectId;
const STANDBY_PROJECT = "project-b" as ProjectId;
const snapshotOf = (copies: RoutineCopies["Service"]) =>
  copies
    .snapshot({ projectId: PROJECT, logicalProjectId: "logical-a" })
    .pipe(Effect.map((snapshot) => snapshot!));

it.effect("sends only the coordinator's own routines, and a new digest after an edit", () =>
  Effect.gen(function* () {
    const { run, seedThread } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
    yield* seedThread("worker-thread", "project-a");
    yield* run((service) =>
      Effect.gen(function* () {
        const copies = yield* service.routineCopies!();
        yield* service.upsert(taskInput({ id: "b-own" }));
        yield* service.upsert(taskInput({ id: "a-worker", threadId: "worker-thread" }));
        yield* service.upsert(taskInput({ id: "c-webhook", schedule: { type: "webhook" } }));
        const first = yield* snapshotOf(copies);
        assert.deepEqual(
          first.routines.map((copy) => copy.id),
          ["b-own"],
        );
        assert.equal(first.digest, coordinatorRoutinesDigest(first.routines));
        assert.notProperty(first.routines[0] ?? {}, "projectId");

        yield* service.upsert(taskInput({ id: "b-own", prompt: "Edited prompt" }));
        const edited = yield* snapshotOf(copies);
        assert.notEqual(edited.digest, first.digest);
        assert.equal(edited.routines[0]?.prompt, "Edited prompt");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "keeps copies under the same ids on the standby and removes only copies no longer sent",
  () =>
    Effect.gen(function* () {
      const { run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
      yield* run((service) =>
        Effect.gen(function* () {
          const copies = yield* service.routineCopies!();
          // The coordinator's routines, read as it would send them.
          yield* service.upsert(taskInput({ id: "daily" }));
          yield* service.upsert(taskInput({ id: "weekly", title: "Weekly" }));
          const sent = yield* snapshotOf(copies);
          // The standby's own copy of the project, with a routine of its own.
          yield* service.upsert(taskInput({ id: "standby-own", projectId: STANDBY_PROJECT }));
          yield* sql`DELETE FROM scheduled_tasks WHERE project_id = ${PROJECT}`;

          yield* copies.replace({
            projectId: STANDBY_PROJECT,
            logicalProjectId: "logical-a",
            routines: sent.routines,
          });
          const kept = yield* sql<{
            task_id: string;
            thread_id: string | null;
            copied: string | null;
          }>`SELECT task_id, thread_id, json_extract(run_policy_json, '$.copiedFrom') AS copied
           FROM scheduled_tasks WHERE project_id = ${STANDBY_PROJECT} ORDER BY task_id`;
          assert.deepEqual(
            kept.map((row) => [row.task_id, row.thread_id, row.copied]),
            [
              ["daily", null, "logical-a"],
              ["standby-own", null, null],
              ["weekly", null, "logical-a"],
            ],
          );
          const daily = (yield* service.list()).tasks.find((task) => task.id === "daily");
          assert.isTrue(daily?.ownThread);

          // Edited on the standby: still a copy.
          yield* service.upsert(
            taskInput({ id: "daily", projectId: STANDBY_PROJECT, title: "Mine" }),
          );
          // The coordinator deleted "weekly": the copy goes, the standby's own stays.
          yield* copies.replace({
            projectId: STANDBY_PROJECT,
            logicalProjectId: "logical-a",
            routines: sent.routines.filter((copy) => copy.id === "daily"),
          });
          const after = yield* sql<{ task_id: string; title: string; copied: string | null }>`
          SELECT task_id, title, json_extract(run_policy_json, '$.copiedFrom') AS copied
          FROM scheduled_tasks WHERE project_id = ${STANDBY_PROJECT} ORDER BY task_id`;
          assert.deepEqual(
            after.map((row) => [row.task_id, row.title, row.copied]),
            [
              ["daily", "Synthetic review", "logical-a"],
              ["standby-own", "Synthetic review", null],
            ],
          );
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never takes over an id another project uses on the standby", () =>
  Effect.gen(function* () {
    const { run, sql } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        const copies = yield* service.routineCopies!();
        yield* service.upsert(taskInput({ id: "shared", prompt: "Coordinator prompt" }));
        const sent = yield* snapshotOf(copies);
        // On this machine "shared" belongs to project-a; the copy is for project-b.
        yield* copies.replace({
          projectId: STANDBY_PROJECT,
          logicalProjectId: "logical-b",
          routines: sent.routines,
        });
        const rows = yield* sql<{ project_id: string }>`
          SELECT project_id FROM scheduled_tasks WHERE task_id = 'shared'`;
        assert.deepEqual(
          rows.map((row) => row.project_id),
          ["project-a"],
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "drops a routine deleted on the new coordinator from the machine that sent it before",
  () =>
    Effect.gen(function* () {
      const { run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
      yield* run((service) =>
        Effect.gen(function* () {
          const copies = yield* service.routineCopies!();
          // M4 coordinated and sent "review"; then it gave way and stands by for M1,
          // where "review" was deleted. M1 sends no routines at all.
          yield* service.upsert(taskInput({ id: "review" }));
          yield* service.upsert(taskInput({ id: "own-later" }));
          yield* snapshotOf(copies);
          yield* sql`UPDATE scheduled_tasks SET run_policy_json = json_remove(run_policy_json, '$.copiedFrom') WHERE task_id = 'own-later'`;
          yield* copies.replace({
            projectId: PROJECT,
            logicalProjectId: "logical-a",
            routines: [],
          });
          const left = yield* sql<{ task_id: string }>`SELECT task_id FROM scheduled_tasks`;
          assert.deepEqual(
            left.map((row) => row.task_id),
            ["own-later"],
          );
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("sends no routines when they are too large to travel with the notes", () =>
  Effect.gen(function* () {
    const { run } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        const copies = yield* service.routineCopies!();
        yield* service.upsert(
          taskInput({ prompt: "x".repeat(COORDINATOR_ROUTINE_COPIES_MAX_BYTES + 1) }),
        );
        assert.isNull(
          yield* copies.snapshot({ projectId: PROJECT, logicalProjectId: "logical-a" }),
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it("treats a full list as possibly cut, so nothing is removed", () => {
  assert.isTrue(routineCopiesComplete([]));
  assert.isFalse(
    routineCopiesComplete(Array.from({ length: COORDINATOR_ROUTINE_COPIES_MAX }) as never),
  );
});
