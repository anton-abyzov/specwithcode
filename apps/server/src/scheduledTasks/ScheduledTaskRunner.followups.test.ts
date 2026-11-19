/**
 * What a read of the shipped routine runner found (1390 AC-45): a change that
 * names no definition passed as if it named the one shown; a copy capped by its
 * grant never agreed with its runner on what was shown; and a runner still
 * collecting answers that hands coordination to a copy on the release before.
 */
import { assert, it } from "@effect/vitest";
import type { ScheduledTask } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
const NEW_PROMPT = "The runner's new prompt";
const UNSEEN =
  "This routine runs on another machine, and this change did not say which version of it was shown, so nothing was changed. Reload the routines, or update the app, and try again.";
const STALE =
  "This routine changed since you opened it, so your change was not saved. Open it again and repeat the change.";
const at = (iso: string) => TestClock.setTime(Date.parse(iso));
const settle = (machine: Machine) => machine.runner.reconcile({ force: true });
const listed = (machine: Machine) =>
  machine.service
    .list()
    .pipe(Effect.map((list) => list.tasks.find((task) => task.id === ROUTINE) as ScheduledTask));
const found = (machine: Machine) =>
  machine.service.list().pipe(Effect.map((list) => list.tasks.some((task) => task.id === ROUTINE)));
const messageOf = (result: { readonly _tag: string; readonly failure?: unknown }) =>
  result._tag === "Failure" ? (result.failure as { readonly message: string }).message : null;
/** What a row or a form sends with its change: the revision and the definition it showed. */
const seenOn = (shown: ScheduledTask) => ({
  ...(shown.revision === undefined ? {} : { expectedRevision: shown.revision }),
  ...(shown.definitionHash === undefined ? {} : { expectedDefinition: shown.definitionHash }),
});
/** Alpha runs the routine and beta rests its copy; then alpha changes the prompt and beta hears. */
const restingThenChanged = Effect.gen(function* () {
  yield* at(NOON);
  const made = yield* fleet(["alpha", "beta"]);
  const [alpha, beta] = made.machines as [Machine, Machine];
  yield* alpha.seed();
  yield* beta.seed();
  yield* settle(alpha);
  assert.equal((yield* alpha.record)?.state, "settled");
  assert.equal((yield* beta.record)?.state, "disarmed");
  // What somebody on beta saw, before the change.
  const first = yield* listed(beta);
  yield* alpha.service.upsert(
    taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
  );
  yield* settle(alpha);
  assert.equal((yield* listed(beta)).prompt, NEW_PROMPT);
  return { ...made, alpha, beta, first };
});

// --- a change that names no definition -----------------------------------------------------

it.effect("a toggle that names no definition never flips the routine at its runner", () =>
  Effect.gen(function* () {
    const { alpha, beta, first } = yield* restingThenChanged;
    const unnamed = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: false })
      .pipe(Effect.result);
    assert.isTrue((yield* listed(alpha)).enabled);
    assert.equal(messageOf(unnamed), UNSEEN);
    // Named as it was before the change: refused as changed.
    const stale = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: false, ...seenOn(first) })
      .pipe(Effect.result);
    assert.isTrue((yield* listed(alpha)).enabled);
    assert.equal(messageOf(stale), STALE);
    // Named as beta shows it now: made.
    const made = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: false, ...seenOn(yield* listed(beta)) })
      .pipe(Effect.result);
    assert.equal(made._tag, "Success");
    assert.isFalse((yield* listed(alpha)).enabled);
  }),
);

it.effect("a delete that names no definition never deletes the routine at its runner", () =>
  Effect.gen(function* () {
    const { alpha, beta, first } = yield* restingThenChanged;
    const unnamed = yield* beta.service.delete({ id: ROUTINE }).pipe(Effect.result);
    assert.isTrue(yield* found(alpha));
    assert.equal(messageOf(unnamed), UNSEEN);
    const stale = yield* beta.service.delete({ id: ROUTINE, ...seenOn(first) }).pipe(Effect.result);
    assert.isTrue(yield* found(alpha));
    assert.equal(messageOf(stale), STALE);
    const made = yield* beta.service
      .delete({ id: ROUTINE, ...seenOn(yield* listed(beta)) })
      .pipe(Effect.result);
    assert.equal(made._tag, "Success");
    assert.isFalse(yield* found(alpha));
    assert.isFalse(yield* found(beta));
  }),
);

it.effect("the runner makes no change sent to it without the definition it was made on", () =>
  Effect.gen(function* () {
    const { alpha, beta } = yield* restingThenChanged;
    const record = yield* beta.record;
    for (const edit of [{ kind: "enabled", enabled: false }, { kind: "delete" }]) {
      const answered = yield* beta
        .post(
          alpha.environmentId,
          "",
          { op: "runner-edit", routineId: ROUTINE, expectedRevision: record?.revision, edit },
          1_000,
        )
        .pipe(Effect.result);
      assert.isTrue(
        answered._tag === "Failure" ||
          (answered.success.json as { readonly stale?: boolean }).stale === true,
      );
      assert.isTrue(yield* found(alpha));
      assert.isTrue((yield* listed(alpha)).enabled);
    }
  }),
);

// --- a save from a client that names no definition -----------------------------------------

it.effect("a save that names no definition is refused for what it lacks, not as changed", () =>
  Effect.gen(function* () {
    const { alpha, beta } = yield* restingThenChanged;
    const form = yield* listed(beta);
    const save = (seen: Record<string, unknown>) =>
      beta.service
        .upsert(
          taskInput({
            id: ROUTINE,
            projectId: beta.projectId,
            title: "Only the title",
            prompt: form.prompt,
            ...seen,
          }),
        )
        .pipe(Effect.result);
    // Nothing changed in between, and nothing says so.
    const unnamed = yield* save({});
    assert.equal(messageOf(unnamed), UNSEEN);
    assert.notEqual((yield* listed(alpha)).title, "Only the title");
    // The same form, sent with what it opened on: saved.
    assert.equal((yield* save(seenOn(form)))._tag, "Success");
    const runner = yield* listed(alpha);
    assert.equal(runner.title, "Only the title");
    assert.equal(runner.prompt, NEW_PROMPT);
  }),
);

// --- a copy capped by its grant ------------------------------------------------------------

it.effect("a copy held under a lower runtime ceiling changes its routine the first time", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { machines, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    // What alpha's routines may do on beta is capped below what the routine asks.
    (network as { ceiling?: (from: string, to: string) => string }).ceiling = (from, to) =>
      from === "alpha" && to === "beta" ? "auto-accept-edits" : "full-access";
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.equal((yield* listed(alpha)).runtimeMode, "full-access");
    assert.equal((yield* listed(beta)).runtimeMode, "auto-accept-edits");
    const off = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: false, ...seenOn(yield* listed(beta)) })
      .pipe(Effect.result);
    assert.equal(off._tag, "Success");
    assert.isFalse((yield* listed(alpha)).enabled);
    // The runner sends its copies the change; the next one is made the first time too.
    yield* settle(alpha);
    assert.equal((yield* listed(beta)).runtimeMode, "auto-accept-edits");
    const on = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: true, ...seenOn(yield* listed(beta)) })
      .pipe(Effect.result);
    assert.equal(on._tag, "Success");
    const runner = yield* listed(alpha);
    assert.isTrue(runner.enabled);
    assert.equal(runner.runtimeMode, "full-access");
    // And one made on what beta showed before that change is still refused.
    yield* settle(alpha);
    const before = yield* listed(beta);
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
    );
    yield* settle(alpha);
    const stale = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: false, ...seenOn(before) })
      .pipe(Effect.result);
    assert.equal(messageOf(stale), STALE);
    assert.isTrue((yield* listed(alpha)).enabled);
  }),
);

// --- a runner still collecting answers hands coordination over -----------------------------

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

it.effect(
  "a runner still collecting answers hands over to a copy on the release before: one fires",
  () =>
    Effect.gen(function* () {
      yield* at(NOON);
      const { machines, network } = yield* fleet(["alpha", "beta", "gamma"]);
      const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
      for (const machine of machines) yield* machine.seed();
      // Beta confirms it rests; gamma's answer is lost. Alpha has not settled.
      network.dropAnswer = (_from, to, op) => to === "gamma" && op === "runner-disarm";
      yield* settle(alpha);
      const collecting = yield* alpha.record;
      assert.equal(collecting?.state, "settling");
      assert.include(collecting?.acked ?? [], beta.environmentId);
      assert.equal((yield* beta.row)?.enabled, 0);
      yield* alpha.makeDue(DUE);
      // Beta is put back on v1.0.379, and alpha hands coordination to it.
      const old = yield* downgraded(beta);
      const copies = yield* alpha.service.routineCopies!();
      const snapshot = yield* copies.snapshot({
        projectId: alpha.projectId,
        logicalProjectId: "logical-a",
        recipient: beta.environmentId,
        handover: true,
      } as Parameters<typeof copies.snapshot>[0]);
      yield* old.handover(
        snapshot?.routines ?? [],
        yield* readRunStates(alpha.projectId, [ROUTINE]).pipe(
          Effect.provideService(SqlClient.SqlClient, alpha.sql),
          Effect.orDie,
        ),
      );
      alpha.state.role = { active: false, epoch: 2, state: "transferred" };
      beta.state.role = { active: true, epoch: 2, state: "active" };
      const eligible = Effect.gen(function* () {
        const before = alpha.fires() + gamma.fires();
        const onBeta = yield* fires379(beta, NOON);
        yield* alpha.due;
        yield* gamma.due;
        return onBeta.length + alpha.fires() + gamma.fires() - before;
      });
      // While gamma has not confirmed: exactly one machine starts the due slot.
      assert.equal(yield* eligible, 1);
      assert.equal((yield* beta.row)?.enabled, 1);
      assert.equal(alpha.fires(), 0);
      // Gamma answers again and alpha looks: still exactly one, and it is the coordinator.
      network.dropAnswer = () => false;
      yield* settle(alpha);
      yield* settle(alpha);
      assert.equal(yield* eligible, 1);
      assert.equal((yield* beta.row)?.enabled, 1);
      assert.equal(alpha.fires(), 0);
      assert.equal(gamma.fires(), 0);
    }),
);

// --- what a list shows is one read ---------------------------------------------------------

it.effect("a list never shows one definition's fields with another's hash", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
    );
    // The runner's new definition reaches beta after beta's list read its rows
    // and before it reads what each row is to its runner. It is another
    // request: started here, outside the list's read, and held until then.
    const gate = yield* Deferred.make<void>();
    const refresh = yield* Effect.forkDetach(
      Deferred.await(gate).pipe(Effect.andThen(settle(alpha))),
    );
    let reached = false;
    beta.state.beforeRecordsRead = Effect.gen(function* () {
      reached = true;
      yield* Deferred.succeed(gate, undefined);
      for (let turn = 0; turn < 2_000 && refresh.pollUnsafe() === undefined; turn++)
        yield* Effect.yieldNow;
    });
    const form = yield* listed(beta);
    assert.isTrue(reached);
    yield* Fiber.await(refresh);
    const after = yield* listed(beta);
    assert.equal(after.prompt, NEW_PROMPT);
    // Old fields with the old hash, or new with new: never one of each.
    assert.equal(form.prompt === after.prompt, form.definitionHash === after.definitionHash);
    // So a title changed on that form never puts the old prompt back.
    yield* beta.service
      .upsert(
        taskInput({
          id: ROUTINE,
          projectId: beta.projectId,
          title: "Only the title",
          prompt: form.prompt,
          ...seenOn(form),
        }),
      )
      .pipe(Effect.result);
    assert.equal((yield* listed(alpha)).prompt, NEW_PROMPT);
  }),
);

// --- a rename from a capped copy -----------------------------------------------------------

/** A title-only save as each client builds it from the routine its list showed. */
const renameFrom = (client: "mcp" | "mobile", machine: Machine, shown: ScheduledTask) =>
  machine.service
    .upsert(
      client === "mcp"
        ? {
            // update_scheduled_task: every field it was not given comes from its read.
            id: shown.id,
            title: "Renamed",
            prompt: shown.prompt,
            enabled: shown.enabled,
            schedule: shown.schedule as never,
            projectId: shown.projectId,
            threadId: shown.threadId,
            workspaceStrategy: shown.workspaceStrategy,
            modelSelection: shown.modelSelection,
            runtimeMode: shown.runtimeMode,
            interactionMode: shown.interactionMode,
            createdBy: shown.createdBy,
            creationSource: shown.creationSource,
            ...seenOn(shown),
          }
        : {
            // The mobile form: the draft it opened on, saved whole.
            id: shown.id,
            requireExisting: true,
            title: "Renamed",
            prompt: shown.prompt,
            projectId: shown.projectId,
            modelSelection: shown.modelSelection,
            schedule: shown.schedule as never,
            enabled: shown.enabled,
            threadId: shown.threadId,
            workspaceStrategy: shown.workspaceStrategy,
            runtimeMode: shown.runtimeMode,
            interactionMode: shown.interactionMode,
            creationSource: shown.creationSource,
            ...seenOn(shown),
          },
    )
    .pipe(Effect.result);

for (const client of ["mcp", "mobile"] as const)
  it.effect(`a rename from a capped copy keeps how its runner runs the routine (${client})`, () =>
    Effect.gen(function* () {
      yield* at(NOON);
      const { machines, network } = yield* fleet(["alpha", "beta"]);
      const [alpha, beta] = machines as [Machine, Machine];
      (network as { ceiling?: (from: string, to: string) => string }).ceiling = (from, to) =>
        from === "alpha" && to === "beta" ? "auto-accept-edits" : "full-access";
      yield* alpha.seed();
      yield* beta.seed();
      yield* settle(alpha);
      const shown = yield* listed(beta);
      assert.equal(shown.runtimeMode, "auto-accept-edits");
      assert.equal((yield* renameFrom(client, beta, shown))._tag, "Success");
      const runner = yield* listed(alpha);
      assert.equal(runner.title, "Renamed");
      // The copy showed its own ceiling; the caller changed the title and nothing else.
      assert.equal(runner.runtimeMode, "full-access");
      // A mode the caller did change is taken.
      yield* settle(alpha);
      const again = yield* listed(beta);
      const lowered = yield* renameFrom(client, beta, {
        ...again,
        runtimeMode: "approval-required",
      });
      assert.equal(lowered._tag, "Success");
      assert.equal((yield* listed(alpha)).runtimeMode, "approval-required");
    }),
  );

// --- a copy that became the runner ---------------------------------------------------------

it.effect("a delete made on an older definition is refused once the copy runs the routine", () =>
  Effect.gen(function* () {
    yield* at(NOON);
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    // Listed on beta while alpha runs it.
    const seen = yield* listed(beta);
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, prompt: NEW_PROMPT }),
    );
    const task = yield* listed(alpha);
    const moved = yield* alpha.transfer!.moveOut({
      task,
      target: beta.environmentId,
      targetLabel: beta.name,
      copy: routineCopyOf({ ...task, ownThread: true })!,
      boundThreadId: null,
    });
    assert.equal(moved.kind, "moved");
    assert.equal((yield* listed(beta)).prompt, NEW_PROMPT);
    // The delete names what beta showed before the change, and no revision.
    const stale = yield* beta.service
      .delete({ id: ROUTINE, expectedDefinition: seen.definitionHash })
      .pipe(Effect.result);
    assert.isTrue(yield* found(beta));
    assert.equal(messageOf(stale), STALE);
    const off = yield* beta.service
      .setEnabled({ id: ROUTINE, enabled: false, expectedDefinition: seen.definitionHash })
      .pipe(Effect.result);
    assert.equal(messageOf(off), STALE);
    assert.isTrue((yield* listed(beta)).enabled);
    // One that names nothing is this machine's own change, as before.
    assert.equal((yield* beta.service.delete({ id: ROUTINE }).pipe(Effect.result))._tag, "Success");
  }),
);

// --- a handover to a machine that keeps runner records -------------------------------------

/** Alpha collects answers: beta rests its copy, gamma's answer is lost. The slot is due. */
const collecting = Effect.gen(function* () {
  yield* at(NOON);
  const made = yield* fleet(["alpha", "beta", "gamma"]);
  const [alpha, beta, gamma] = made.machines as [Machine, Machine, Machine];
  for (const machine of made.machines) yield* machine.seed();
  made.network.dropAnswer = (_from, to, op) => to === "gamma" && op === "runner-disarm";
  yield* settle(alpha);
  assert.equal((yield* alpha.record)?.state, "settling");
  assert.equal((yield* beta.record)?.state, "disarmed");
  made.network.dropAnswer = () => false;
  yield* alpha.makeDue(DUE);
  return { ...made, alpha, beta, gamma };
});
const handoverSnapshot = (alpha: Machine, beta: Machine) =>
  Effect.gen(function* () {
    const copies = yield* alpha.service.routineCopies!();
    return yield* copies.snapshot({
      projectId: alpha.projectId,
      logicalProjectId: "logical-a",
      recipient: beta.environmentId,
      handover: true,
    } as Parameters<typeof copies.snapshot>[0]);
  });

it.effect("a handover leaves the routine running when the old coordinator goes at once", () =>
  Effect.gen(function* () {
    const { alpha, beta, gamma, network } = yield* collecting;
    const snapshot = yield* handoverSnapshot(alpha, beta);
    // Beta takes the handover as this release does: the routines, then their run states.
    const copies = yield* beta.service.routineCopies!();
    yield* copies.replace({
      projectId: beta.projectId,
      logicalProjectId: "logical-a",
      routines: snapshot?.routines ?? [],
    });
    yield* writeRunStates(
      beta.projectId,
      yield* readRunStates(alpha.projectId, [ROUTINE]).pipe(
        Effect.provideService(SqlClient.SqlClient, alpha.sql),
        Effect.orDie,
      ),
    ).pipe(Effect.provideService(SqlClient.SqlClient, beta.sql), Effect.orDie);
    // Acknowledged. Alpha is gone before it looks at anything again.
    network.offline.add("alpha");
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    beta.state.role = { active: true, epoch: 2, state: "active" };
    yield* beta.due;
    yield* gamma.due;
    assert.equal(beta.fires(), 1);
    assert.equal(gamma.fires(), 0);
    assert.isNull(yield* beta.record);
    assert.equal((yield* beta.row)?.enabled, 1);
  }),
);

it.effect("a handover is not gathered while the recipient may still rest its copy", () =>
  Effect.gen(function* () {
    const { alpha, beta, network } = yield* collecting;
    // Beta is told to follow the coordinator again; whether it did is not known.
    network.dropAnswer = (_from, to, op) => to === "beta" && op === "runner-rearm";
    const unknown = yield* handoverSnapshot(alpha, beta).pipe(Effect.result);
    assert.equal(unknown._tag, "Failure");
    // Not told at all: the same, and beta still rests for alpha.
    network.dropAnswer = () => false;
    network.offline.add("beta");
    const unreached = yield* handoverSnapshot(alpha, beta).pipe(Effect.result);
    assert.equal(unreached._tag, "Failure");
    network.offline.delete("beta");
    // Reached again, the routine goes on, and beta follows the coordinator.
    const sent = yield* handoverSnapshot(alpha, beta);
    assert.deepEqual(
      (sent?.routines ?? []).map((routine) => routine.enabled),
      [true],
    );
    assert.isNull(yield* beta.record);
  }),
);
