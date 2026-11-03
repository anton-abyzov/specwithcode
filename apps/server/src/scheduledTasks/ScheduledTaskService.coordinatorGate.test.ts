import { assert, it } from "@effect/vitest";
import type { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  HANDOFF_ROUTINE_WAIT,
  RESTING_ROUTINE_NOTE,
  makeRoutineCoordinatorGate,
} from "./ScheduledTaskCoordinatorGate.ts";
import {
  ACTIVE,
  TRANSFERRED,
  harness,
  roleService,
  taskInput,
  type Role,
} from "./ScheduledTaskService.coordinatorGate.testkit.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

it.effect(
  "rests a coordinator routine on a copy that does not coordinate, then runs it after takeover",
  () =>
    Effect.gen(function* () {
      const { state, run, sql, row } = yield* harness;
      yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput());
          state.role = TRANSFERRED;
          yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T11:59:00.000Z'`;
          yield* state.due;
          assert.equal(state.launches, 0);
          const rested = yield* row;
          assert.equal(rested?.last_run_error, RESTING_ROUTINE_NOTE);
          assert.equal(rested?.next_run_at, "2026-11-03T12:01:00.000Z");
          assert.equal(rested?.run_count, 0);
          // A manual run on the resting copy is refused with the same reason.
          const refused = yield* service.runNow({ id: "routine" as never }).pipe(Effect.flip);
          assert.include(refused.message, "another machine runs this project's coordinator");

          // This copy takes over: the next due run fires here.
          state.role = { active: true, epoch: 2, state: "active" };
          yield* TestClock.adjust("1 minute");
          yield* state.due;
          assert.equal(state.launches, 1);
          assert.equal((yield* row)?.run_count, 1);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "keeps a run due while the coordinator is fenced or handing off, then fires it once",
  () =>
    Effect.gen(function* () {
      const { state, run, sql, row } = yield* harness;
      yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput());
          yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T11:59:00.000Z'`;
          state.fence = "Fenced: not heard from the standby.";
          yield* state.due;
          state.fence = null;
          state.role = { active: false, epoch: 1, state: "transferring" };
          yield* state.due;
          assert.equal(state.launches, 0);
          const waiting = yield* row;
          assert.equal(waiting?.next_run_at, "2026-11-03T11:59:00.000Z");
          assert.isNull(waiting?.last_run_error);
          const refused = yield* service.runNow({ id: "routine" as never }).pipe(Effect.flip);
          assert.include(refused.message, HANDOFF_ROUTINE_WAIT);

          state.role = ACTIVE;
          yield* state.due;
          yield* state.due;
          assert.equal(state.launches, 1);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never gates a routine bound to a worker thread", () =>
  Effect.gen(function* () {
    const { state, run, sql, seedThread } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
    yield* seedThread("worker-thread", "project-a");
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ threadId: "worker-thread" }));
        state.role = TRANSFERRED;
        state.fence = "Fenced";
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T11:59:00.000Z'`;
        yield* state.due;
        assert.equal(state.sends, 1);
        assert.equal(state.launches, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never gates a webhook routine, which stays with the machine its URL points to", () =>
  Effect.gen(function* () {
    const { state } = yield* harness;
    const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id: ProjectId) => Effect.succeed(Option.some(routineProject(id))),
    });
    state.role = TRANSFERRED;
    const hold = yield* Effect.gen(function* () {
      return yield* makeRoutineCoordinatorGate({
        role: roleService(state),
        wakeGate: { check: () => Effect.succeed("Fenced") },
        projects: yield* ProjectStore.ProjectStoreV2,
      })({
        projectId: "project-a" as ProjectId,
        ownThread: true,
        schedule: { type: "webhook" } as never,
      });
    }).pipe(Effect.provide(projects));
    assert.isNull(hold);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("says a daily run was skipped on hold, not asleep, when its coordinator waited", () =>
  Effect.gen(function* () {
    const { state, run, sql, row } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T10:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }));
        state.fence = "Fenced";
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T09:00:00.000Z'`;
        yield* state.due;
        assert.equal(state.launches, 0);
        const note = (yield* row)?.last_run_error ?? "";
        assert.include(note, "on hold");
        assert.notInclude(note, "asleep");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("clears the resting note when this copy takes over", () =>
  Effect.gen(function* () {
    const { state, run, sql, row } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        state.role = TRANSFERRED;
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T11:59:00.000Z'`;
        yield* state.due;
        assert.equal((yield* row)?.last_run_error, RESTING_ROUTINE_NOTE);
        state.role = { active: true, epoch: 3, state: "active" };
        yield* state.publishTookOver();
        assert.isNull((yield* row)?.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "notes a daily run skipped while the machine was off, and clears it on the next run",
  () =>
    Effect.gen(function* () {
      const { state, run, sql, row } = yield* harness;
      yield* TestClock.setTime(Date.parse("2026-11-03T10:00:00.000Z"));
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(
            taskInput({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }),
          );
          yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T09:00:00.000Z'`;
          yield* state.due;
          assert.equal(state.launches, 0);
          const skipped = yield* row;
          assert.include(skipped?.last_run_error ?? "", "Skipped the 09:00 run");
          assert.include(skipped?.last_run_error ?? "", "off or asleep");
          assert.isAbove(
            Date.parse(skipped?.next_run_at ?? ""),
            Date.parse("2026-11-03T10:00:00Z"),
          );

          yield* TestClock.setTime(Date.parse(skipped?.next_run_at ?? ""));
          yield* state.due;
          assert.equal(state.launches, 1);
          assert.isNull((yield* row)?.last_run_error);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("gives a resting copy's missed daily run the resting note, not the skip note", () =>
  Effect.gen(function* () {
    const { state, run, sql, row } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-11-03T10:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }));
        state.role = TRANSFERRED;
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-03T09:00:00.000Z'`;
        yield* state.due;
        assert.equal(state.launches, 0);
        assert.equal((yield* row)?.last_run_error, RESTING_ROUTINE_NOTE);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires a routine on exactly one machine across a takeover and give-way", () =>
  Effect.gen(function* () {
    // Two machines holding the same routine: M4 coordinates, M1 stands by.
    const m4 = { role: ACTIVE, fence: null as string | null };
    const m1 = { role: { active: false, epoch: 1, state: "transferred" } as Role, fence: null };
    const project = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id: ProjectId) => Effect.succeed(Option.some(routineProject(id))),
    });
    const gate = (machine: { role: Role; fence: string | null }) =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        return makeRoutineCoordinatorGate({
          role: roleService(machine),
          wakeGate: { check: () => Effect.sync(() => machine.fence) },
          projects,
        });
      }).pipe(Effect.provide(project));
    const fireOn4 = yield* gate(m4);
    const fireOn1 = yield* gate(m1);
    const task = {
      projectId: "project-a" as ProjectId,
      ownThread: true,
      schedule: { type: "interval", everyMs: 60000 },
    } as const;
    const firing = Effect.gen(function* () {
      const holds = [yield* fireOn4(task), yield* fireOn1(task)];
      return holds.map((hold) => hold === null);
    });

    assert.deepEqual(yield* firing, [true, false]);
    // M4 goes quiet; M1 takes over at epoch 2 while M4 still holds epoch 1.
    // M4 has not heard from its standby, so its wake fence keeps it waiting.
    m1.role = { active: true, epoch: 2, state: "active" };
    m4.fence = "Fenced";
    assert.deepEqual(yield* firing, [false, true]);
    assert.equal((yield* fireOn4(task))?.kind, "wait");
    // M4 hears it gave way: its copy rests for good.
    m4.role = { active: false, epoch: 2, state: "transferred" };
    m4.fence = null;
    assert.deepEqual(yield* firing, [false, true]);
    assert.equal((yield* fireOn4(task))?.kind, "rest");
  }),
);
