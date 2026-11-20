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
import type { AwayPeerPost } from "../away/awayPeerCall.ts";
import { makeTransferOut379, wouldFire379 } from "./ScheduledTaskRunner.release379.testkit.ts";
import {
  COORDINATES,
  fleet,
  type Machine,
  ROUTINE,
  STANDBY,
  shownOn,
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
    // Its next run posts into the thread the first one started: admitted the same way.
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(alpha.fires(), 2);
    assert.equal(fires(), 2);
    assert.isNull((yield* alpha.row)?.last_run_error ?? null);
  }),
);

it.effect("a copy that arrives after its machine agreed to rest is saved resting", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* settle(alpha);
    assert.equal((yield* beta.record)?.state, "disarmed");
    assert.isUndefined(yield* beta.row);
    // The coordinator's replica brings the row: off for the release before, on in the list.
    const copies = yield* beta.service.routineCopies!();
    yield* copies.replace({
      projectId: beta.projectId,
      logicalProjectId: "logical-a",
      routines: [routineCopyOf({ ...task, ownThread: true })!],
    });
    assert.notOk((yield* beta.row)?.enabled);
    assert.isTrue((yield* listed(beta)).enabled);
    assert.equal((yield* beta.record)?.copyEnabled, true);
  }),
);

it.effect(
  "two coordinators that both hold it off and claim at once never rest for each other",
  () =>
    Effect.gen(function* () {
      yield* start;
      const { machines, network } = yield* fleet(["alpha", "beta"]);
      const [alpha, beta] = machines as [Machine, Machine];
      beta.state.role = BESIDE;
      beta.state.beside = true;
      yield* alpha.seed();
      yield* beta.seed();
      yield* alpha.service.setEnabled({ id: ROUTINE, enabled: false });
      yield* beta.service.setEnabled({ id: ROUTINE, enabled: false, ...(yield* shownOn(beta)) });
      // Beta's claim leaves while alpha's is on its way.
      let crossed = false;
      network.before = (from, _to, op) =>
        from === "alpha" && op === "runner-disarm" && !crossed
          ? Effect.suspend(() => ((crossed = true), settle(beta)))
          : Effect.void;
      yield* settle(alpha);
      assert.isTrue(crossed);
      assert.equal((yield* beta.record)?.state, "disarmed");
      assert.equal((yield* alpha.record)?.state, "settled");
      // A person can still turn it on, on either machine.
      yield* beta.service.setEnabled({ id: ROUTINE, enabled: true, ...(yield* shownOn(beta)) });
      assert.isTrue((yield* listed(alpha)).enabled);
    }),
);

it.effect("a copy whose runner left the project follows the coordinator again", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    assert.equal((yield* beta.record)?.state, "disarmed");
    assert.notOk((yield* beta.row)?.enabled);
    // Alpha is unlinked: nobody is left to tell beta's copy it may run.
    beta.state.unlinked.add(alpha.environmentId);
    beta.state.role = COORDINATES;
    yield* settle(beta);
    assert.isNull(yield* beta.record);
    assert.deepInclude(yield* beta.row, { enabled: 1, last_run_error: null });
    yield* beta.makeDue(DUE);
    yield* beta.due;
    assert.equal(beta.fires(), 1);
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
    // And this machine is its runner again, as before it moved.
    assert.equal((yield* alpha.record)?.state, "settled");
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
    yield* beta.service.delete({ id: ROUTINE, ...(yield* shownOn(beta)) }).pipe(Effect.result);
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
          expectedDefinition: shown.definitionHash,
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
      .upsert(
        taskInput({
          id: ROUTINE,
          projectId: beta.projectId,
          title: "Sent from the copy",
          expectedDefinition: (yield* listed(beta)).definitionHash,
        }),
      )
      .pipe(Effect.result);
    assert.equal(fromCopy._tag, "Failure");
    assert.equal((yield* alpha.row)?.title, "Synthetic review");
    yield* healInsert;
    yield* healUpdate;
    assert.equal((yield* listed(alpha)).revision, 0);
  }),
);

// --- T21-13 --------------------------------------------------------------------------------

/**
 * The release before's own sender on `source`, over the route this release
 * answers on, with what `source`'s row read as each request left it.
 */
const sender379 = (source: Machine) => {
  const seen: Array<string> = [];
  const post: AwayPeerPost = (target, path, body, timeout) =>
    Effect.gen(function* () {
      const row = yield* source.row;
      seen.push(`${(body as { readonly op: string }).op}:${row?.enabled ? "on" : "off"}`);
      return yield* source.post(target, path, body, timeout);
    });
  const sender = makeTransferOut379({
    post,
    readState: () =>
      source.row.pipe(
        Effect.map((row) =>
          row === undefined
            ? null
            : {
                nextRunAt: row.next_run_at,
                lastRunAt: null,
                runCount: row.run_count,
                onceGeneration: 0,
                running: false,
                enabled: Boolean(row.enabled),
              },
        ),
      ),
    setEnabled: (id, enabled) =>
      source.service.setEnabled({ id, enabled }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    note: (id, note) =>
      source.sql`UPDATE scheduled_tasks SET last_run_error = ${note} WHERE task_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    writeState: (task, state) =>
      source.sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${state.nextRunAt}, last_run_at = ${state.lastRunAt}, run_count = ${state.runCount}
        WHERE task_id = ${task.id}
      `.pipe(Effect.asVoid, Effect.orDie),
    nowMs: Effect.succeed(Date.parse(NOON)),
  });
  return { sender, seen };
};
const olderSource = Effect.gen(function* () {
  yield* start;
  const all = yield* fleet(["alpha", "beta"], { release: { alpha: "1.0.377" } });
  const [alpha, beta] = all.machines as [Machine, Machine];
  // A worker's routine: the kind that release moved by itself, bound to the worker's thread.
  for (const machine of [alpha, beta])
    yield* machine.sql`INSERT INTO orchestration_v2_projection_threads ${machine.sql.insert({ thread_id: "worker-thread", project_id: machine.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
  const task = yield* alpha.seed({ threadId: "worker-thread" });
  yield* alpha.makeDue(DUE);
  return { ...all, alpha, beta, task, ...sender379(alpha) };
});
const input379 = (task: ScheduledTask, beta: Machine) => ({
  task,
  target: beta.environmentId,
  targetLabel: "beta",
  copy: routineCopyOf({ ...task, ownThread: true })!,
  boundThreadId: "worker-thread",
});

it.effect("T21-13: the release before's sender moves a routine here and takes it back", () =>
  Effect.gen(function* () {
    const { alpha, beta, task, sender, seen, everyoneLooks, fires } = yield* olderSource;
    assert.deepInclude(yield* sender.moveOut(input379(task, beta)), { kind: "moved" });
    // Its order: staged while the source is still on, turned on only once it is off.
    assert.deepEqual(seen, ["stage:on", "enable:off"]);
    assert.notOk((yield* alpha.row)?.enabled);
    assert.deepInclude(yield* beta.row, { enabled: 1, next_run_at: DUE });
    // It runs here by that release's rule: no runner record was written for it.
    assert.isNull(yield* beta.record);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(beta.state.sends, 1);
    assert.deepInclude(
      yield* sender.bringBack({
        task,
        target: beta.environmentId,
        targetLabel: "beta",
        wasEnabled: true,
      }),
      { kind: "returned" },
    );
    assert.deepEqual(seen, ["stage:on", "enable:off", "release:off"]);
    assert.isUndefined(yield* beta.row);
    assert.deepInclude(yield* alpha.row, { enabled: 1, run_count: 1 });
    // Nothing is left here that would refuse that release's next move of it.
    assert.isNull(yield* beta.record);
    assert.deepInclude(yield* sender.moveOut(input379(task, beta)), { kind: "moved" });
    assert.deepInclude(yield* beta.row, { enabled: 1 });
  }),
);

it.effect("T21-13: a stage this machine refuses leaves the older source running it", () =>
  Effect.gen(function* () {
    const { alpha, beta, task, sender, seen, everyoneLooks, fires } = yield* olderSource;
    // This machine runs a routine of that id itself: not another machine's to stage.
    yield* beta.runner.records.write({
      taskId: ROUTINE,
      state: "settled",
      runnerEnvironmentId: beta.environmentId,
      runnerLabel: null,
      revision: 0,
      acked: [],
      operationId: null,
      operation: null,
    });
    assert.deepInclude(yield* sender.moveOut(input379(task, beta)), {
      kind: "failed",
      offHere: false,
    });
    assert.deepEqual(seen, ["stage:on"]);
    assert.isUndefined(yield* beta.row);
    assert.deepInclude(yield* alpha.row, { enabled: 1 });
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
  }),
);
