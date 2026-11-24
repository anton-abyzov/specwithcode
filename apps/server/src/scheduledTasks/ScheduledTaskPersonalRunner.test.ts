/**
 * A linked personal assistant's routines (1448 AC-09, C5): each routine fires
 * once, on the seat it was made on, through a runner change in Settings. The
 * runner decides only a copy a seat rested for it and a project whose
 * `userdata` was copied to another machine. Routines that never travel (a
 * worker's thread, a webhook) run on their own seat.
 */
import { assert, it } from "@effect/vitest";
import type { ProjectCoordinatorBinding } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { PERSONAL_RESTING_NOTE } from "./ScheduledTaskPersonalRunner.ts";
import { COORDINATES, fleet, type Machine, ROUTINE } from "./ScheduledTaskRunner.testkit.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const seat = (routineOwner: boolean): ProjectCoordinatorBinding => ({
  epoch: 1,
  state: "active",
  routineOwner,
});
const runnerIs = (runner: Machine, other: Machine) => {
  runner.state.binding = seat(true);
  other.state.binding = seat(false);
};

/** Two linked seats, both coordinating; `m4` is the routine runner. */
const linkedPair = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOON));
  const built = yield* fleet(["m4", "m1"], { personal: true });
  const [m4, m1] = built.machines as [Machine, Machine];
  m4.state.role = COORDINATES;
  m1.state.role = COORDINATES;
  runnerIs(m4, m1);
  return { ...built, m4, m1 };
});

/** One minute on, one due pass on every seat: how many runs each seat started in it. */
const minute = (m4: Machine, m1: Machine, everyoneLooks: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const before = [m4.fires(), m1.fires()] as const;
    yield* TestClock.adjust("1 minute");
    yield* everyoneLooks;
    return { m4: m4.fires() - before[0], m1: m1.fires() - before[1] };
  });

/** A copy m1 rested for m4, as the runner leaves it: its row off, due at the slot m4 fires. */
const restForM4 = (m4: Machine, m1: Machine) =>
  Effect.gen(function* () {
    yield* m1.runner.records.write({
      taskId: ROUTINE,
      state: "disarmed",
      runnerEnvironmentId: m4.environmentId,
      runnerLabel: "m4",
      revision: 0,
      acked: [],
      operationId: null,
      operation: null,
      asked: [],
      copyEnabled: true,
    });
    yield* m1.runner.records.setRowEnabled(ROUTINE, false);
  });

it.effect("a routine that lives on one seat fires there whichever seat is the runner", () =>
  Effect.gen(function* () {
    // A personal assistant's routines are never copied to its other seats, so a
    // routine made on m1 (not the runner) must run on m1, before and after a change.
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    yield* m1.seed({ ownThread: true });
    yield* m1.makeDue(DUE);
    yield* everyoneLooks;
    assert.deepEqual([m4.fires(), m1.fires()], [0, 1]);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 0, m1: 1 });
    runnerIs(m1, m4);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 0, m1: 1 });
    runnerIs(m4, m1);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 0, m1: 1 });
  }),
);

it.effect("routines on both seats each fire once on their own seat through a runner change", () =>
  Effect.gen(function* () {
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    yield* m4.seed({ ownThread: true });
    yield* m1.seed({ ownThread: true });
    yield* m4.makeDue(DUE);
    yield* m1.makeDue(DUE);
    yield* everyoneLooks;
    assert.deepEqual([m4.fires(), m1.fires()], [1, 1]);
    runnerIs(m1, m4);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 1, m1: 1 });
  }),
);

it.effect("a copy rested for the runner stays rested, and the new runner takes it back", () =>
  Effect.gen(function* () {
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    yield* m1.seed({ ownThread: true });
    yield* m1.makeDue(DUE);
    yield* restForM4(m4, m1);
    yield* everyoneLooks;
    assert.equal(m1.fires(), 0);
    runnerIs(m1, m4);
    // Taken back, it is due at its next slot, not at the one it rested on.
    const first = yield* minute(m4, m1, everyoneLooks);
    assert.equal(first.m1, 0);
    assert.equal((yield* m1.row)?.enabled, 1);
    assert.isNull(yield* m1.record);
    for (let i = 0; i < 2; i++) assert.equal((yield* minute(m4, m1, everyoneLooks)).m1, 1);
  }),
);

it.effect("a worker-thread routine on a seat that is not the runner still runs there", () =>
  Effect.gen(function* () {
    const { m1 } = yield* linkedPair;
    yield* m1.sql`INSERT INTO orchestration_v2_projection_threads ${m1.sql.insert({ thread_id: "thread-worker", project_id: m1.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
    yield* m1.seed({ ownThread: false, threadId: "thread-worker" });
    yield* m1.makeDue(DUE);
    yield* m1.due;
    assert.equal(m1.fires(), 1);
  }),
);

it.effect("a webhook routine on a seat that is not the runner still runs there", () =>
  Effect.gen(function* () {
    const { m1 } = yield* linkedPair;
    const task = yield* m1.seed({ ownThread: true, schedule: { type: "webhook" } });
    const body = new TextEncoder().encode("{}");
    const result = yield* m1.service.triggerWebhook({
      hookId: task.id,
      token: task.webhook?.path.split("/").at(-1) ?? "",
      method: "POST",
      path: `/api/hooks/${task.id}`,
      query: "",
      headers: { "content-type": "application/json" },
      body,
      bodyText: "{}",
    });
    assert.equal(result._tag, "accepted");
    for (let i = 0; i < 50 && m1.fires() === 0; i++) yield* TestClock.adjust("1 second");
    assert.equal(m1.fires(), 1);
  }),
);

it.effect("a one-time routine the former runner fired is not fired again by the new runner", () =>
  Effect.gen(function* () {
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    const once = { schedule: { type: "once", at: DUE }, ownThread: true };
    yield* m4.seed(once);
    yield* m1.seed(once);
    yield* m4.makeDue(DUE);
    yield* m1.makeDue(DUE);
    yield* m1.runner.records.write({
      taskId: ROUTINE,
      state: "disarmed",
      runnerEnvironmentId: m4.environmentId,
      runnerLabel: "m4",
      revision: 0,
      acked: [],
      operationId: null,
      operation: null,
      asked: [],
      copyEnabled: true,
    });
    yield* m1.runner.records.setRowEnabled(ROUTINE, false);
    yield* everyoneLooks;
    assert.deepEqual([m4.fires(), m1.fires()], [1, 0]);
    // Settings makes m1 the runner after m4 fired the one slot.
    runnerIs(m1, m4);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 0, m1: 0 });
  }),
);

it.effect("a routine in copied userdata fires only on the runner, and moves with it", () =>
  Effect.gen(function* () {
    // Copying userdata gives both seats the same project and routine ids.
    yield* TestClock.setTime(Date.parse(NOON));
    const built = yield* fleet(["m4", "m1"], { personal: true, copiedUserdata: true });
    const [m4, m1] = built.machines as [Machine, Machine];
    m4.state.role = COORDINATES;
    m1.state.role = COORDINATES;
    runnerIs(m4, m1);
    yield* m4.seed({ ownThread: true });
    yield* m1.seed({ ownThread: true });
    yield* m4.makeDue(DUE);
    yield* m1.makeDue(DUE);
    yield* built.everyoneLooks;
    assert.deepEqual([m4.fires(), m1.fires()], [1, 0]);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(yield* minute(m4, m1, built.everyoneLooks), { m4: 1, m1: 0 });
    runnerIs(m1, m4);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(yield* minute(m4, m1, built.everyoneLooks), { m4: 0, m1: 1 });
  }),
);

it.effect(
  "a one-time routine in copied userdata the runner fired is not fired again after a change",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOON));
      const built = yield* fleet(["m4", "m1"], { personal: true, copiedUserdata: true });
      const [m4, m1] = built.machines as [Machine, Machine];
      m4.state.role = COORDINATES;
      m1.state.role = COORDINATES;
      runnerIs(m4, m1);
      const once = { schedule: { type: "once", at: DUE }, ownThread: true };
      yield* m4.seed(once);
      yield* m1.seed(once);
      yield* m4.makeDue(DUE);
      yield* m1.makeDue(DUE);
      yield* built.everyoneLooks;
      assert.deepEqual([m4.fires(), m1.fires()], [1, 0]);
      runnerIs(m1, m4);
      for (let i = 0; i < 3; i++)
        assert.deepEqual(yield* minute(m4, m1, built.everyoneLooks), { m4: 0, m1: 0 });
    }),
);
