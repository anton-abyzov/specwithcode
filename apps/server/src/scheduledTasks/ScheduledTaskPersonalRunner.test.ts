/**
 * A linked personal assistant's routines (1448 AC-09, C5): the seat chosen as
 * the routine runner fires each travelling routine, and exactly one seat does
 * after the runner changes in Settings, in both directions. Routines that
 * never travel (a worker's thread, a webhook) run on their own seat.
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

/** Each minute through both runner changes: exactly one seat starts the routine. */
const flipBothWays = (
  m4: Machine,
  m1: Machine,
  everyoneLooks: Effect.Effect<void>,
  options: { readonly tookBack: boolean },
) =>
  Effect.gen(function* () {
    // Settings makes m1 the runner: only the flag changes, and nobody is asked.
    runnerIs(m1, m4);
    // A copy m1 rested for m4 comes back on at its next slot: the slot m4 fired is not run again.
    const first = yield* minute(m4, m1, everyoneLooks);
    assert.equal(first.m4, 0);
    // Taken back, it is due at its next slot, not at the one it rested on (that
    // minute's occurrence is skipped, never run twice). A copy that never rested
    // fires the minute's occurrence.
    assert.equal(first.m1, options.tookBack ? 0 : 1);
    assert.equal((yield* m1.row)?.enabled, 1);
    assert.isNull(yield* m1.record);
    assert.equal((yield* m4.row)?.last_run_error, PERSONAL_RESTING_NOTE);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 0, m1: 1 });
    // And back to m4.
    runnerIs(m4, m1);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 1, m1: 0 });
    assert.equal((yield* m1.row)?.last_run_error, PERSONAL_RESTING_NOTE);
  });

it.effect("a runner change leaves exactly one seat firing a travelling routine, both ways", () =>
  Effect.gen(function* () {
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    yield* m4.seed({ ownThread: true });
    yield* m1.seed({ ownThread: true });
    yield* m4.makeDue(DUE);
    yield* m1.makeDue(DUE);
    yield* everyoneLooks;
    assert.deepEqual([m4.fires(), m1.fires()], [1, 0]);
    yield* flipBothWays(m4, m1, everyoneLooks, { tookBack: false });
  }),
);

it.effect("the new runner takes back a copy it had rested for the former runner", () =>
  Effect.gen(function* () {
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    yield* m4.seed({ ownThread: true });
    yield* m1.seed({ ownThread: true });
    yield* m4.makeDue(DUE);
    yield* m1.makeDue(DUE);
    // m1's copy rests for m4 as the runner leaves it: its row off, due at the slot m4 fires.
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
    yield* flipBothWays(m4, m1, everyoneLooks, { tookBack: true });
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

it.effect("a link that stopped halfway leaves the resting seat running its routines", () =>
  Effect.gen(function* () {
    const { m4, m1, everyoneLooks } = yield* linkedPair;
    // m1 joined (not the runner); m4, the runner, never did and lists nobody.
    m4.state.unlinked.add(m1.environmentId);
    yield* m1.seed({ ownThread: true });
    yield* m1.makeDue(DUE);
    // Until m4 answers, m1 cannot tell it never joined: it rests.
    yield* m1.due;
    assert.equal(m1.fires(), 0);
    yield* m1.runner.reconcile({ force: true });
    assert.deepEqual(yield* minute(m4, m1, everyoneLooks), { m4: 0, m1: 1 });
    // Once m4 lists m1 and answers, m1 rests again.
    m4.state.unlinked.clear();
    yield* m4.seed({ ownThread: true });
    yield* TestClock.adjust("2 minutes");
    yield* m1.runner.reconcile({ force: true });
    yield* m4.runner.reconcile({ force: true });
    const counted = yield* minute(m4, m1, everyoneLooks);
    assert.equal(counted.m1, 0);
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
