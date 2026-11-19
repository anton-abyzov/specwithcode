/**
 * The cases the second and third reviews of the routine runner asked for
 * (1390 AC-45, T21R2-01 to T21R2-03, T21R3-01 to T21R3-03): a copy put back on
 * the release before and sent a handover, also after a machine joined; a due
 * slot carried across a rest; a definition paired with a revision it was not
 * read with; and a change made on a definition its runner no longer holds.
 */
import { assert, it } from "@effect/vitest";
import type { ProjectId, ScheduledTask } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { readRunStates, writeRunStates } from "../project/CoordinatorPlannedHandover.ts";
import { routineCopyOf } from "./ScheduledTaskCopies.ts";
import { receiver379, wouldFire379 } from "./ScheduledTaskRunner.release379.testkit.ts";
import { fleet, type Machine, ROUTINE } from "./ScheduledTaskRunner.testkit.ts";
import { taskInput } from "./ScheduledTaskService.coordinatorGate.testkit.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const SLOT = "2026-11-03T12:05:00.000Z";
const HOURLY = { type: "interval", everyMs: 3_600_000 } as const;
const at = (iso: string) => TestClock.setTime(Date.parse(iso));
const settle = (machine: Machine) => machine.runner.reconcile({ force: true });
const listed = (machine: Machine) =>
  machine.service
    .list()
    .pipe(Effect.map((list) => list.tasks.find((task) => task.id === ROUTINE) as ScheduledTask));
const pair = Effect.gen(function* () {
  const made = yield* fleet(["alpha", "beta"]);
  const [alpha, beta] = made.machines as [Machine, Machine];
  return { ...made, alpha, beta };
});
/** The coordinator goes from alpha to beta, as a planned handover leaves the two bindings. */
const handOver = (alpha: Machine, beta: Machine) =>
  Effect.sync(() => {
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    beta.state.role = { active: true, epoch: 2, state: "active" };
  });
/** The run states a handover carries, read on the machine that hands over. */
const runStatesOf = (machine: Machine) =>
  readRunStates(machine.projectId, [ROUTINE]).pipe(
    Effect.provideService(SqlClient.SqlClient, machine.sql),
    Effect.orDie,
  );
const generationOf = (machine: Machine) =>
  machine.sql<{ readonly generation: number | null }>`
    SELECT json_extract(run_policy_json, '$.onceGeneration') AS generation
    FROM scheduled_tasks WHERE task_id = ${ROUTINE}
  `.pipe(
    Effect.map((rows) => rows[0]?.generation ?? 0),
    Effect.orDie,
  );

// --- T21R2-01 ------------------------------------------------------------------------------

/** The machine's routines as its rows hold them, for the release that read nothing else. */
const rows379 = (machine: Machine) =>
  Effect.gen(function* () {
    const { tasks } = yield* machine.service.list();
    const on = new Map(
      (yield* machine.sql<{ readonly task_id: string; readonly enabled: number }>`
        SELECT task_id, enabled FROM scheduled_tasks
      `.pipe(Effect.orDie)).map((row) => [row.task_id, row.enabled === 1] as const),
    );
    return tasks.map((task) => ({ ...task, enabled: on.get(task.id) ?? task.enabled }));
  });
/** The machine put back on v1.0.379: its replica writer and handover receive, on its database. */
const downgraded = (machine: Machine) =>
  receiver379(machine.sql, machine.projectId, {
    listTasks: rows379(machine),
    findTask: (id) =>
      rows379(machine).pipe(Effect.map((tasks) => tasks.find((task) => task.id === id) ?? null)),
    upsert: (input, options) => machine.runner.internal.upsert(input, options),
    remove: (id) => machine.runner.internal.remove({ id }),
  });
/** What v1.0.379 on this database would start now, as the project's only coordinator. */
const fires379 = (machine: Machine, now: string) =>
  wouldFire379(
    machine.sql,
    {
      role: undefined,
      wakeGate: { check: () => Effect.succeed(null) },
      projects: {
        get: () =>
          Effect.succeed(
            Option.some({
              projectId: machine.projectId,
              workspaceSettings: { coordinatorBinding: { epoch: 2, state: "active" } },
            } as unknown as ProjectStore.ProjectRow),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"],
    },
    DateTime.makeUnsafe(Date.parse(now)),
  );
/** What `machine` sends `to` as a coordinator: a lease's routines, or a handover's. */
const snapshotOf = (machine: Machine, to: Machine) =>
  Effect.gen(function* () {
    const copies = yield* machine.service.routineCopies!();
    const snapshot = yield* copies.snapshot({
      projectId: machine.projectId,
      logicalProjectId: "logical-a",
      recipient: to.environmentId,
    });
    return snapshot?.routines ?? [];
  });

const downgradedReceives = (step: "replica" | "handover") =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta } = yield* pair;
    yield* alpha.seed();
    yield* beta.seed();
    // What alpha sent while nothing was settled; a snapshot is kept between leases.
    assert.isTrue((yield* snapshotOf(alpha, beta))[0]?.enabled);
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.equal((yield* beta.record)?.state, "disarmed");
    assert.equal((yield* beta.row)?.enabled, 0);
    yield* alpha.makeDue(DUE);
    // Beta is put back on v1.0.379. Alpha, its acknowledgement in hand, sends it what
    // a coordinator sends: a lease's routines, or a handover with their run states.
    const old = yield* downgraded(beta);
    const routines = yield* snapshotOf(alpha, beta);
    if (step === "replica") yield* old.replica(routines);
    else {
      yield* old.handover(routines, yield* runStatesOf(alpha));
      yield* handOver(alpha, beta);
    }
    // For the replica: beta coordinates beside alpha, as its release let it.
    yield* beta.makeDue(DUE);
    const onBeta = yield* fires379(beta, NOON);
    yield* alpha.due;
    return { alpha, beta, onBeta };
  });

it.effect(
  "T21R2-01: a handover to a copy put back on the release before fires once, on the runner",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, onBeta } = yield* downgradedReceives("handover");
      assert.deepEqual(onBeta, []);
      assert.equal(alpha.fires(), 1);
      assert.equal((yield* beta.row)?.enabled, 0);
    }),
);

it.effect("T21R2-01: so does a replica it is sent between two leases", () =>
  Effect.gen(function* () {
    const { alpha, beta, onBeta } = yield* downgradedReceives("replica");
    assert.deepEqual(onBeta, []);
    assert.equal(alpha.fires(), 1);
    assert.equal((yield* beta.row)?.enabled, 0);
  }),
);

it.effect("T21R2-01: a copy whose row cannot be read never confirms it rests", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta } = yield* pair;
    yield* alpha.seed();
    yield* beta.seed();
    // Beta's row is there and on, and cannot be decoded.
    const schedule = yield* beta.sql<{ readonly schedule_json: string }>`
      SELECT schedule_json FROM scheduled_tasks WHERE task_id = ${ROUTINE}
    `.pipe(Effect.orDie);
    yield* beta.sql`UPDATE scheduled_tasks SET schedule_json = '{' WHERE task_id = ${ROUTINE}`.pipe(
      Effect.orDie,
    );
    yield* settle(alpha);
    const unsettled = yield* alpha.record;
    assert.notEqual(unsettled?.state, "settled");
    assert.notInclude(unsettled?.acked ?? [], beta.environmentId);
    assert.equal((yield* beta.row)?.enabled, 1);
    // Not said no to either: alpha still knows it asked, and asks again.
    assert.include(unsettled?.asked ?? [], beta.environmentId);
    yield* beta.sql`
      UPDATE scheduled_tasks SET schedule_json = ${schedule[0]!.schedule_json}
      WHERE task_id = ${ROUTINE}
    `.pipe(Effect.orDie);
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.equal((yield* beta.row)?.enabled, 0);
  }),
);

// --- T21R2-02 ------------------------------------------------------------------------------

/**
 * Beta rests its copy and its answer is lost; the coordinator goes to beta
 * with the slot the routine is due at; alpha, which never settled, tells beta
 * at 12:04 to follow the coordinator again.
 */
const restedThenFreed = (schedule: Record<string, unknown>) =>
  Effect.gen(function* () {
    yield* at(NOON);
    const made = yield* pair;
    const { alpha, beta, network } = made;
    yield* alpha.seed({ schedule });
    yield* beta.seed({ schedule });
    // The slot is on both rows before anything rests; no row is written by hand after this.
    yield* alpha.makeDue(SLOT);
    yield* beta.makeDue(SLOT);
    const generation = yield* generationOf(beta);
    network.dropAnswer = (_from, to, op) => to === "beta" && op === "runner-disarm";
    yield* settle(alpha);
    assert.equal((yield* beta.record)?.state, "disarmed");
    const rested = yield* beta.row;
    yield* writeRunStates(beta.projectId, yield* runStatesOf(alpha)).pipe(
      Effect.provideService(SqlClient.SqlClient, beta.sql),
      Effect.orDie,
    );
    yield* handOver(alpha, beta);
    network.dropAnswer = () => false;
    yield* at("2026-11-03T12:04:00.000Z");
    yield* settle(alpha);
    const freed = yield* beta.row;
    return { ...made, generation, rested, freed, freedRecord: yield* beta.record };
  });

it.effect("T21R2-02: a copy told to follow again fires at the slot it was due at", () =>
  Effect.gen(function* () {
    const { alpha, beta, everyoneLooks, fires, rested, freed, freedRecord } =
      yield* restedThenFreed(HOURLY);
    yield* at("2026-11-03T12:04:59.000Z");
    yield* everyoneLooks;
    assert.equal(fires(), 0);
    yield* at("2026-11-03T12:05:01.000Z");
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(beta.fires(), 1);
    assert.equal(alpha.fires(), 0);
    // Off while it rested, still due at 12:05; on again, still due at 12:05.
    assert.equal(rested?.enabled, 0);
    assert.equal(rested?.next_run_at, SLOT);
    assert.isNull(freedRecord);
    assert.equal(freed?.enabled, 1);
    assert.equal(freed?.next_run_at, SLOT);
  }),
);

it.effect("T21R2-02: a one-time routine keeps its generation across a rest", () =>
  Effect.gen(function* () {
    const { beta, generation, rested, freed } = yield* restedThenFreed({ type: "once", at: SLOT });
    assert.equal(rested?.next_run_at, SLOT);
    assert.equal(freed?.enabled, 1);
    assert.equal(freed?.next_run_at, SLOT);
    assert.equal(yield* generationOf(beta), generation);
  }),
);

// --- T21R2-03 ------------------------------------------------------------------------------

const NEW_PROMPT = "The runner's new prompt";
/** The form on a copy: what its list shows, with only the title changed. */
const titleOnly = (machine: Machine) =>
  Effect.gen(function* () {
    const shown = yield* listed(machine);
    return yield* machine.service
      .upsert(
        taskInput({
          id: ROUTINE,
          projectId: machine.projectId,
          title: "Only the title",
          prompt: shown.prompt,
          ...(shown.revision === undefined ? {} : { expectedRevision: shown.revision }),
          ...(shown.definitionHash === undefined
            ? {}
            : { expectedDefinition: shown.definitionHash }),
        }),
      )
      .pipe(Effect.result);
  });

it.effect("T21R2-03: a late first replica never lets a title change revert the prompt", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta } = yield* pair;
    const first = yield* alpha.seed();
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
    );
    // Beta has no row yet: it confirms it rests, and hears the revision.
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.isUndefined(yield* beta.row);
    // A coordinator's replica, sent before the change, arrives after: the old prompt.
    const copies = yield* beta.service.routineCopies!();
    yield* copies.replace({
      projectId: beta.projectId as ProjectId,
      logicalProjectId: "logical-a",
      routines: [routineCopyOf(first)!],
    });
    assert.equal((yield* listed(beta)).prompt, first.prompt);
    const refused = yield* titleOnly(beta);
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
    // Refused, and the copy now holds what its runner holds: the same change again is made.
    assert.equal(refused._tag, "Failure");
    assert.equal((yield* listed(beta)).prompt, NEW_PROMPT);
    assert.equal((yield* titleOnly(beta))._tag, "Success");
    const runner = yield* listed(alpha);
    assert.equal(runner.prompt, NEW_PROMPT);
    assert.equal(runner.title, "Only the title");
  }),
);

it.effect("T21R2-03: a change saved between the sender's reads is never sent half", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta } = yield* pair;
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    // Another request saves a new prompt after this pass read the routines and
    // before it reads their counts. It runs on its own, as a request does.
    const saving: { fiber: Fiber.Fiber<unknown, unknown> | null } = { fiber: null };
    alpha.state.beforeRevisionsRead = Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(
        alpha.service.upsert(
          taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
        ),
      );
      saving.fiber = fiber;
      for (let turn = 0; turn < 2_000 && fiber.pollUnsafe() === undefined; turn++)
        yield* Effect.yieldNow;
    });
    yield* settle(alpha);
    assert.isNotNull(saving.fiber);
    yield* Fiber.await(saving.fiber!);
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
    // Whatever beta was sent, a title-only change made on it keeps the new prompt.
    yield* titleOnly(beta);
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
    // And once alpha looks again, beta holds the new prompt at the revision it shows.
    yield* settle(alpha);
    const copy = yield* listed(beta);
    assert.equal(copy.prompt, NEW_PROMPT);
    assert.equal(copy.revision, (yield* listed(alpha)).revision);
    assert.equal((yield* titleOnly(beta))._tag, "Success");
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
  }),
);

// --- T21R3-01 ------------------------------------------------------------------------------

it.effect(
  "T21R3-01: a machine joining before the handover never re-arms the copy that confirmed",
  () =>
    Effect.gen(function* () {
      yield* at(NOON);
      const { machines } = yield* fleet(["alpha", "beta", "gamma"]);
      const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
      // Gamma is not linked yet: alpha settles with beta alone.
      for (const machine of [alpha, beta]) machine.state.unlinked.add(gamma.environmentId);
      for (const machine of machines) yield* machine.seed();
      yield* settle(alpha);
      assert.equal((yield* alpha.record)?.state, "settled");
      assert.equal((yield* beta.row)?.enabled, 0);
      // Gamma joins between settlement and the snapshot; beta is put back on v1.0.379.
      for (const machine of [alpha, beta]) machine.state.unlinked.delete(gamma.environmentId);
      yield* alpha.makeDue(DUE);
      const old = yield* downgraded(beta);
      yield* old.handover(yield* snapshotOf(alpha, beta), yield* runStatesOf(alpha));
      yield* handOver(alpha, beta);
      // Alpha asks only gamma, which confirms: beta's earlier answer still counts.
      yield* settle(alpha);
      assert.sameMembers(
        [...((yield* alpha.record)?.acked ?? [])],
        [beta.environmentId, gamma.environmentId],
      );
      const onBeta = yield* fires379(beta, NOON);
      yield* alpha.due;
      yield* gamma.due;
      // Exactly one machine is eligible, and it is the runner.
      assert.deepEqual(onBeta, []);
      assert.equal(alpha.fires(), 1);
      assert.equal(gamma.fires(), 0);
      assert.equal((yield* beta.row)?.enabled, 0);
    }),
);

it.effect("T21R3-01: an unreadable runner set never sends a routine on", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta } = yield* pair;
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    // Alpha cannot read which copies rest for it.
    yield* alpha.sql
      .unsafe("ALTER TABLE scheduled_task_runners RENAME TO runners_away")
      .pipe(Effect.orDie);
    const sent = yield* snapshotOf(alpha, beta).pipe(Effect.result);
    yield* alpha.sql
      .unsafe("ALTER TABLE runners_away RENAME TO scheduled_task_runners")
      .pipe(Effect.orDie);
    // Refused, or sent with nothing on: never the routine as on.
    assert.isFalse(sent._tag === "Success" && sent.success.some((routine) => routine.enabled));
    assert.equal(sent._tag, "Failure");
    // Readable again, it is sent off, as before.
    assert.deepEqual(
      (yield* snapshotOf(alpha, beta)).map((routine) => routine.enabled),
      [false],
    );
  }),
);

// --- T21R3-02 ------------------------------------------------------------------------------

/** A form as it was opened: saved later, unchanged but for its title. */
const saveForm = (machine: Machine, form: ScheduledTask, named: "hash" | "revision only") =>
  machine.service
    .upsert(
      taskInput({
        id: ROUTINE,
        projectId: machine.projectId,
        title: "Only the title",
        prompt: form.prompt,
        ...(form.revision === undefined ? {} : { expectedRevision: form.revision }),
        ...(named === "hash" ? { expectedDefinition: form.definitionHash } : {}),
      }),
    )
    .pipe(Effect.result);

it.effect("T21R3-02: a draft opened before a refresh is refused after it", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta } = yield* pair;
    const first = yield* alpha.seed();
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
    );
    yield* settle(alpha);
    // A coordinator's replica, sent before the change, arrives after: the old prompt.
    const copies = yield* beta.service.routineCopies!();
    yield* copies.replace({
      projectId: beta.projectId as ProjectId,
      logicalProjectId: "logical-a",
      routines: [routineCopyOf(first)!],
    });
    // A person opens the form on beta: the old prompt, at the revision beta heard.
    const form = yield* listed(beta);
    assert.equal(form.prompt, first.prompt);
    // A refresh installs the runner's definition at that same revision.
    yield* settle(alpha);
    const refreshed = yield* listed(beta);
    assert.equal(refreshed.prompt, NEW_PROMPT);
    assert.equal(refreshed.revision, form.revision);
    // The original draft, saved now, names the definition it opened on.
    const stale = yield* saveForm(beta, form, "hash");
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
    assert.equal(stale._tag, "Failure");
    // A save that names no definition cannot say what it was made on.
    const unnamed = yield* saveForm(beta, form, "revision only");
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
    assert.equal(unnamed._tag, "Failure");
    // A form opened after the refresh saves the first time.
    assert.equal((yield* titleOnly(beta))._tag, "Success");
    const runner = yield* listed(alpha);
    assert.equal(runner.prompt, NEW_PROMPT);
    assert.equal(runner.title, "Only the title");
  }),
);

// --- T21R3-03 ------------------------------------------------------------------------------

it.effect("T21R3-03: a move finished after a lost answer never claims a later definition", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { alpha, beta, network } = yield* pair;
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const move = alpha.transfer!.moveOut({
      task,
      target: beta.environmentId,
      targetLabel: beta.name,
      copy: routineCopyOf({ ...task, ownThread: true })!,
      boundThreadId: null,
    });
    // Beta turns the routine on; its answer is lost.
    network.dropAnswer = (_from, _to, op) => op === "runner-enable";
    assert.equal((yield* move).kind, "failed");
    // A person changes it on beta, which runs it now.
    yield* beta.service.upsert(
      taskInput({ id: ROUTINE, projectId: beta.projectId, prompt: NEW_PROMPT }),
    );
    network.dropAnswer = () => false;
    assert.equal((yield* move).kind, "moved");
    const form = yield* listed(alpha);
    assert.equal(form.prompt, task.prompt);
    const stale = yield* saveForm(alpha, form, "hash");
    assert.equal((yield* listed(beta)).prompt, NEW_PROMPT);
    assert.equal(stale._tag, "Failure");
    // Refused with what beta holds, so the same change made again is saved.
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
    assert.equal((yield* titleOnly(alpha))._tag, "Success");
    const runner = yield* listed(beta);
    assert.equal(runner.prompt, NEW_PROMPT);
    assert.equal(runner.title, "Only the title");
  }),
);
