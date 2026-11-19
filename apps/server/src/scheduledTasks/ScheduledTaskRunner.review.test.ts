/**
 * The cases the review of the routine runner asked for (1390 AC-45,
 * T21-01 to T21-12): each machine's own database and scheduler, real
 * coordinator bindings in the project rows, and the runs counted where they
 * were started.
 */
import { assert, it } from "@effect/vitest";
import type { ScheduledTask } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { wouldFire379 } from "./ScheduledTaskRunner.release379.testkit.ts";
import {
  COORDINATES,
  fleet,
  type Machine,
  ROUTINE,
  STANDBY,
} from "./ScheduledTaskRunner.testkit.ts";
import { routineCopyOf } from "./ScheduledTaskCopies.ts";
import { taskInput } from "./ScheduledTaskService.coordinatorGate.testkit.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const start = TestClock.setTime(Date.parse(NOON));
const settle = (machine: Machine) => machine.runner.reconcile({ force: true });
const listed = (machine: Machine) =>
  machine.service
    .list()
    .pipe(Effect.map((list) => list.tasks.find((task) => task.id === ROUTINE) as ScheduledTask));
/** A coordinator started beside the project's own: active, and never handed the role. */
const BESIDE = { active: true, epoch: 1, state: "active" } as const;

// --- T21-01 --------------------------------------------------------------------------------

const firstPoll = (order: ReadonlyArray<"alpha" | "beta">, linkDown: boolean) =>
  Effect.gen(function* () {
    yield* start;
    // The look runs as a server runs it, with each due pass: nothing is settled by hand.
    const { machines, network, fires } = yield* fleet(["alpha", "beta"], { pace: 0 });
    const [alpha, beta] = machines as [Machine, Machine];
    beta.state.role = BESIDE;
    beta.state.beside = true;
    yield* alpha.seed();
    yield* beta.seed();
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    if (linkDown) network.offline.add("beta");
    for (const name of order) yield* (name === "alpha" ? alpha : beta).due;
    return { alpha, beta, fires };
  });

it.effect("T21-01: two coordinators due on their first poll with the link down fire once", () =>
  Effect.gen(function* () {
    const { alpha, beta, fires } = yield* firstPoll(["alpha", "beta"], true);
    assert.equal(fires(), 1);
    // The machine that ran it under the release before goes on running it.
    assert.equal(alpha.fires(), 1);
    assert.equal(beta.fires(), 0);
  }),
);

it.effect("T21-01: with the link up, the incumbent polling first fires once", () =>
  Effect.gen(function* () {
    const { alpha, fires } = yield* firstPoll(["alpha", "beta"], false);
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
  }),
);

it.effect("T21-01: with the link up, the other coordinator polling first never fires", () =>
  Effect.gen(function* () {
    const { alpha, beta, fires } = yield* firstPoll(["beta", "alpha"], false);
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
    assert.equal(beta.fires(), 0);
  }),
);

// --- T21-02 --------------------------------------------------------------------------------

it.effect("T21-02: a settled runner fires after its project's coordinator was transferred", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    // A real transfer: alpha's project row now carries a transferred binding.
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    beta.state.role = { active: true, epoch: 2, state: "active" };
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(alpha.fires(), 1);
    assert.equal(beta.fires(), 0);
    assert.equal(fires(), 1);
    assert.isNull((yield* alpha.row)?.last_run_error ?? null);
  }),
);

// --- T21-03 --------------------------------------------------------------------------------

it.effect("T21-03: the release before never fires a copy that confirmed it rests", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    assert.equal((yield* beta.record)?.state, "disarmed");
    // Beta is put back on the release before, coordinates, and is cut off from alpha.
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    const fired = yield* wouldFire379(
      beta.sql,
      {
        role: undefined,
        wakeGate: { check: () => Effect.succeed(null) },
        // Its own row, with a binding that coordinates.
        projects: {
          get: () =>
            Effect.succeed(
              Option.some({
                projectId: beta.projectId,
                workspaceSettings: { coordinatorBinding: { epoch: 3, state: "active" } },
              } as unknown as ProjectStore.ProjectRow),
            ),
        } as unknown as ProjectStore.ProjectStoreV2["Service"],
      },
      DateTime.makeUnsafe(Date.parse(NOON)),
    );
    assert.deepEqual(fired, []);
    yield* everyoneLooks;
    assert.equal(alpha.fires(), 1);
    // And the copy still reads on for a person, as it is on at its runner.
    assert.isTrue((yield* listed(beta)).enabled);
  }),
);

// --- T21-04 --------------------------------------------------------------------------------

const lostDisarmReply = (restart: boolean) =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network, everyoneLooks, fires } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    // Beta rests its copy; its answer never arrives.
    network.dropAnswer = (_from, to, op) => to === "beta" && op === "runner-disarm";
    yield* settle(alpha);
    assert.equal((yield* beta.record)?.state, "disarmed");
    // The coordinator changes hands before alpha asks again, and the link is back.
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    beta.state.role = { active: true, epoch: 2, state: "active" };
    network.dropAnswer = () => false;
    if (restart) yield* alpha.reopen;
    yield* settle(alpha);
    yield* settle(beta);
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    return { alpha, beta, fires };
  });

it.effect("T21-04: a lost disarm reply and a role change still leave one machine firing", () =>
  Effect.gen(function* () {
    const { fires } = yield* lostDisarmReply(false);
    assert.equal(fires(), 1);
  }),
);

it.effect("T21-04: the same after the first machine's server started again", () =>
  Effect.gen(function* () {
    const { fires } = yield* lostDisarmReply(true);
    assert.equal(fires(), 1);
  }),
);

// --- T21-06, T21-08, T21-09: the move and Bring back ---------------------------------------

const LATER = "2026-11-03T18:00:00.000Z";
const move = (from: Machine, to: Machine, task: ScheduledTask) =>
  from.transfer!.moveOut({
    task,
    target: to.environmentId,
    targetLabel: to.name,
    copy: routineCopyOf({ ...task, ownThread: true })!,
    boundThreadId: null,
  });
const bringBack = (to: Machine, from: Machine) =>
  to.transfer!.bringBack({
    task: { id: ROUTINE, projectId: to.projectId },
    target: from.environmentId,
    targetLabel: from.name,
    wasEnabled: true,
  });
/** Alpha runs the routine, every copy rests, and it moved to beta. */
const movedToBeta = Effect.gen(function* () {
  yield* start;
  const all = yield* fleet(["alpha", "beta"]);
  const [alpha, beta] = all.machines as [Machine, Machine];
  const task = yield* alpha.seed();
  yield* beta.seed();
  yield* settle(alpha);
  assert.deepInclude(yield* move(alpha, beta, task), { kind: "moved" });
  return { ...all, alpha, beta, task };
});

it.effect("T21-06: a routine a person turned off while it moved never runs afterwards", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network, everyoneLooks, fires } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    // The person's own change, made while the other machine answers the stage.
    let disable: Exit.Exit<unknown, unknown> | null = null;
    network.during = (_from, _to, op) =>
      op === "runner-stage" && disable === null
        ? alpha.service.setEnabled({ id: ROUTINE, enabled: false }).pipe(
            Effect.exit,
            Effect.map((exit) => void (disable = exit)),
          )
        : Effect.void;
    yield* move(alpha, beta, task);
    network.during = undefined;
    yield* alpha.reopen;
    yield* move(alpha, beta, task);
    yield* alpha.makeDue(DUE);
    yield* beta.sql`UPDATE scheduled_tasks SET next_run_at = ${DUE} WHERE task_id = ${ROUTINE} AND enabled = 1`;
    yield* everyoneLooks;
    const turnedOff = disable !== null && Exit.isSuccess(disable);
    assert.isFalse(turnedOff && fires() > 0, "it ran after a person turned it off");
    // The move claimed it first, so the change was refused: nobody was told it is off.
    assert.isFalse(turnedOff);
    assert.equal(alpha.fires(), 0);
    assert.equal(beta.fires(), 1);
  }),
);

it.effect("T21-06: a routine turned off before its move began stays off, here and there", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    // What Away read before the person turned it off.
    const snapshot = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    yield* alpha.service.setEnabled({ id: ROUTINE, enabled: false });
    assert.deepInclude(yield* move(alpha, beta, snapshot), { kind: "failed", offHere: false });
    yield* alpha.reopen;
    yield* alpha.sql`UPDATE scheduled_tasks SET next_run_at = ${DUE} WHERE task_id = ${ROUTINE} AND enabled = 1`;
    yield* beta.sql`UPDATE scheduled_tasks SET next_run_at = ${DUE} WHERE task_id = ${ROUTINE} AND enabled = 1`;
    yield* everyoneLooks;
    assert.equal(fires(), 0);
    assert.isFalse((yield* listed(alpha)).enabled);
    assert.equal((yield* alpha.record)?.state, "settled");
  }),
);

it.effect("T21-08: Bring back does not take a failed read on the runner for a release", () =>
  Effect.gen(function* () {
    const { alpha, beta, everyoneLooks } = yield* movedToBeta;
    beta.state.listFails = true;
    assert.deepInclude(yield* bringBack(alpha, beta), { kind: "failed" });
    beta.state.listFails = false;
    assert.notOk((yield* alpha.row)?.enabled);
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    // Only the machine that still runs it fired.
    assert.equal(beta.fires(), 1);
    assert.equal(alpha.fires(), 0);
  }),
);

it.effect("T21-09: a release whose answer was lost is answered again with its run state", () =>
  Effect.gen(function* () {
    const { alpha, beta, network, everyoneLooks, fires } = yield* movedToBeta;
    yield* beta.sql`UPDATE scheduled_tasks SET next_run_at = ${LATER}, run_count = 7 WHERE task_id = ${ROUTINE}`;
    let lost = false;
    network.dropAnswer = (_from, _to, op) =>
      !lost && (op === "release" || op === "runner-release") ? (lost = true) : false;
    assert.deepInclude(yield* bringBack(alpha, beta), { kind: "failed" });
    assert.notOk((yield* alpha.row)?.enabled);
    yield* alpha.reopen;
    yield* beta.reopen;
    assert.deepInclude(yield* bringBack(alpha, beta), { kind: "returned" });
    // What the routine did on the other machine came back with it.
    assert.deepInclude(yield* alpha.row, { enabled: 1, run_count: 7, next_run_at: LATER });
    assert.isUndefined(yield* beta.row);
    yield* alpha.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
  }),
);

it.effect("T21-09: a return this machine could not save stays pending, then finishes", () =>
  Effect.gen(function* () {
    const { alpha, beta, everyoneLooks, fires } = yield* movedToBeta;
    yield* beta.sql`UPDATE scheduled_tasks SET next_run_at = ${LATER}, run_count = 7 WHERE task_id = ${ROUTINE}`;
    const heal = yield* alpha.breakTable("scheduled_tasks", "UPDATE");
    // Released there, not saved here: not returned, so Bring back tries again.
    assert.deepInclude(yield* bringBack(alpha, beta), { kind: "failed" });
    yield* heal;
    assert.notOk((yield* alpha.row)?.enabled);
    assert.equal((yield* alpha.record)?.state, "disarmed");
    yield* alpha.reopen;
    assert.deepInclude(yield* bringBack(alpha, beta), { kind: "returned" });
    assert.deepInclude(yield* alpha.row, { enabled: 1, run_count: 7, next_run_at: LATER });
    assert.notEqual((yield* alpha.record)?.state, "disarmed");
    yield* alpha.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
  }),
);

// --- T21-07 --------------------------------------------------------------------------------

it.effect("T21-07: a copy whose row could not be deleted never fires", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const heal = yield* beta.breakTable("scheduled_tasks", "DELETE");
    yield* beta.service.delete({ id: ROUTINE }).pipe(Effect.result);
    // Deleted on its runner; beta's own row is still there.
    assert.isUndefined(yield* alpha.row);
    assert.isDefined(yield* beta.row);
    // Beta coordinates, and the routine is due: the row left behind must not run.
    alpha.state.role = STANDBY;
    beta.state.role = COORDINATES;
    yield* beta.makeDue(DUE);
    yield* beta.due;
    assert.equal(beta.fires(), 0);
    assert.isNotNull(yield* beta.record);
    // Once the row can be deleted, the next look finishes the delete.
    yield* heal;
    yield* settle(beta);
    assert.isUndefined(yield* beta.row);
    assert.isNull(yield* beta.record);
  }),
);

// --- T21-10 --------------------------------------------------------------------------------

it.effect("T21-10: a title-only change on a copy never reverts the runner's prompt", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: "The runner's new prompt" }),
    );
    // The revision reaches the copy; no coordinator replica has brought the definition.
    yield* settle(alpha);
    // The form on beta: what the list shows, with only the title changed.
    const shown = yield* listed(beta);
    yield* beta.service
      .upsert(
        taskInput({
          id: ROUTINE,
          projectId: beta.projectId,
          title: "Only the title",
          prompt: shown.prompt,
          ...(shown.revision === undefined ? {} : { expectedRevision: shown.revision }),
        }),
      )
      .pipe(Effect.result);
    assert.equal((yield* listed(alpha)).prompt, "The runner's new prompt");
  }),
);

// --- T21-12 --------------------------------------------------------------------------------

it.effect("T21-12: a save whose revision could not advance changes nothing", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const healInsert = yield* alpha.breakTable("scheduled_task_revisions", "INSERT");
    const healUpdate = yield* alpha.breakTable("scheduled_task_revisions", "UPDATE");
    const onRunner = yield* alpha.service
      .upsert(taskInput({ id: ROUTINE, projectId: alpha.projectId, title: "Saved on the runner" }))
      .pipe(Effect.result);
    assert.equal(onRunner._tag, "Failure");
    assert.equal((yield* alpha.row)?.title, "Synthetic review");
    // The same for a change a copy sends.
    const fromCopy = yield* beta.service
      .upsert(taskInput({ id: ROUTINE, projectId: beta.projectId, title: "Sent from the copy" }))
      .pipe(Effect.result);
    assert.equal(fromCopy._tag, "Failure");
    assert.equal((yield* alpha.row)?.title, "Synthetic review");
    yield* healInsert;
    yield* healUpdate;
    assert.equal((yield* listed(alpha)).revision, 0);
  }),
);
