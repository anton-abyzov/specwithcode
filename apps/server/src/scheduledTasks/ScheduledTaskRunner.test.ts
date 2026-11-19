/**
 * One durable runner per routine (1390 AC-45, EC2-06, EC2-09). Every test
 * counts the runs each machine actually started, on its own scheduler and its
 * own database.
 */
import { assert, it } from "@effect/vitest";
import type { ScheduledTask } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  deleteUnreachedRefusal,
  MOVING_ROUTINE_CHANGE_REFUSAL,
  runsElsewhereNote,
  STALE_ROUTINE_EDIT_REFUSAL,
} from "./ScheduledTaskRunner.ts";
import {
  COORDINATES,
  fleet,
  overTheWire,
  type Machine,
  ROUTINE,
  STANDBY,
} from "./ScheduledTaskRunner.testkit.ts";
import { ROUTINE_RUNNER_CAPABILITY } from "./ScheduledTaskRunnerWire.ts";
import { RESTING_ROUTINE_NOTE } from "./ScheduledTaskCoordinatorGate.ts";
import { routineCopyOf } from "./ScheduledTaskCopies.ts";
import { taskInput } from "./ScheduledTaskService.coordinatorGate.testkit.ts";
import {
  RoutineTransferResponse as Response377,
  ROUTINE_TRANSFER_PROTOCOL_VERSION as PROTOCOL_377,
} from "./ScheduledTaskTransfer.release377.testkit.ts";
import { needsUpdateDetail } from "./ScheduledTaskTransfer.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const start = TestClock.setTime(Date.parse(NOON));
const decode377 = Schema.decodeUnknownSync(Response377);
/** The routine as it travels between machines. */
const copyOf = (task: ScheduledTask) => routineCopyOf({ ...task, ownThread: true })!;
const settle = (machine: Machine) => machine.runner.reconcile({ force: true });
const callerFrom = (machine: Machine) =>
  ({
    sourceEnvironmentId: machine.environmentId,
    grant: {
      coordinatorEnvironmentId: machine.environmentId,
      projects: { kind: "all" },
      accounts: { kind: "all" },
      owner: "self",
      hopLimit: 2,
      revoked: false,
      routines: true,
      kind: "own",
    },
    runtimeCeiling: "full-access",
  }) as const;
const move = (from: Machine, to: Machine, task: ScheduledTask) =>
  from.transfer!.moveOut({
    task,
    target: to.environmentId,
    targetLabel: to.name,
    copy: copyOf(task),
    boundThreadId: null,
  });

it.effect("two machines that both coordinate fire a due slot exactly once", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    // Every machine runs its own coordinator: the coordinator no longer picks one copy.
    alpha.state.role = COORDINATES;
    beta.state.role = COORDINATES;
    yield* settle(alpha);
    yield* settle(beta);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.equal((yield* beta.record)?.state, "disarmed");

    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
    assert.equal((yield* beta.row)?.last_run_error, runsElsewhereNote("alpha"));

    // The runner does not follow the coordinator: alpha stops coordinating and still runs it.
    alpha.state.role = STANDBY;
    yield* TestClock.adjust("1 minute");
    yield* everyoneLooks;
    assert.equal(fires(), 2);
    assert.equal(alpha.fires(), 2);
    assert.equal(beta.fires(), 0);
  }),
);

it.effect("both machines claiming at once still leaves one runner", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    alpha.state.role = COORDINATES;
    beta.state.role = COORDINATES;
    // The higher id asks first: the lower one runs the routine today and keeps it.
    yield* settle(beta);
    assert.isNull(yield* alpha.record);
    assert.notEqual((yield* beta.record)?.state, "settled");
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.equal((yield* beta.record)?.state, "disarmed");
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
  }),
);

it.effect("an old standby that takes over during a partition is the only one that fires", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"], {
      release: { beta: "1.0.377" },
    });
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    // The release before keeps a turned-on copy and fires it the moment it coordinates.
    yield* beta.seed();
    yield* settle(alpha);
    // The standby cannot confirm it rests its copy, so the coordinator rule stays in force.
    assert.isNull(yield* alpha.record);
    assert.deepEqual(network.log, ["alpha>beta:status"]);

    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(alpha.fires(), 1);
    assert.equal(beta.fires(), 0);
    assert.equal((yield* beta.row)?.last_run_error, RESTING_ROUTINE_NOTE);

    // The machines lose each other; the standby takes over and the old coordinator is fenced.
    network.offline.add("beta");
    beta.state.role = { active: true, epoch: 2, state: "active" };
    alpha.state.fence = "Fenced: not heard from the standby.";
    yield* TestClock.adjust("1 minute");
    yield* settle(alpha);
    assert.isNull(yield* alpha.record);
    yield* everyoneLooks;
    assert.equal(fires(), 2);
    assert.equal(beta.fires(), 1);
    assert.equal(alpha.fires(), 1);
  }),
);

it.effect("a machine that did not answer keeps the coordinator rule for every machine", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    for (const machine of machines) yield* machine.seed();
    network.offline.add("gamma");
    yield* settle(alpha);
    // Nobody was told to rest: the machine that is cut off could still take over and fire.
    assert.isNull(yield* alpha.record);
    assert.isNull(yield* beta.record);
    gamma.state.role = { active: true, epoch: 2, state: "active" };
    alpha.state.fence = "Fenced: not heard from the standby.";
    for (const machine of machines) yield* machine.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(gamma.fires(), 1);
  }),
);

it.effect("a set with one machine of the release before runs as that release did", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires } = yield* fleet(["alpha", "beta", "gamma"], {
      release: { gamma: "1.0.377" },
    });
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    for (const machine of machines) yield* machine.seed();
    yield* settle(alpha);
    assert.isNull(yield* alpha.record);
    assert.isNull(yield* beta.record);
    for (const machine of machines) yield* machine.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(alpha.fires(), 1);
    // The coordinator moves to the old machine: it fires, and only it.
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    gamma.state.role = { active: true, epoch: 2, state: "active" };
    yield* TestClock.adjust("1 minute");
    yield* everyoneLooks;
    assert.equal(fires(), 2);
    assert.equal(gamma.fires(), 1);
    assert.equal(beta.fires(), 0);
  }),
);

it.effect(
  "a machine that settled and then meets an old one goes back to the coordinator rule",
  () =>
    Effect.gen(function* () {
      yield* start;
      const { machines, network } = yield* fleet(["alpha", "beta", "gamma"], {
        release: { gamma: "1.0.377" },
      });
      const [alpha, beta] = machines as [Machine, Machine, Machine];
      for (const machine of machines) yield* machine.seed();
      // Beta rested its copy before the old machine was asked (its answer was lost then).
      yield* beta.transfer!.receive(callerFrom(alpha), {
        op: "runner-disarm",
        sourceProjectId: alpha.projectId,
        routineIds: [ROUTINE],
      });
      yield* alpha.runner.records.write({
        taskId: ROUTINE,
        state: "settling",
        runnerEnvironmentId: alpha.environmentId,
        runnerLabel: null,
        revision: 0,
        acked: [beta.environmentId],
        operationId: null,
        operation: null,
      });
      yield* settle(alpha);
      assert.include(network.log, "alpha>beta:runner-rearm");
      assert.isNull(yield* alpha.record);
      assert.isNull(yield* beta.record);
    }),
);

it.effect("a lost enable acknowledgement never fires the slot on both machines", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    yield* alpha.makeDue(DUE);
    network.log.length = 0;

    let dropped = 0;
    network.dropAnswer = (_from, _to, op) => op === "runner-enable" && dropped++ === 0;
    const first = yield* move(alpha, beta, task);
    assert.deepInclude(first, { kind: "failed", offHere: true });
    // Staged off there, off here, then on there once: in that order.
    assert.deepEqual(network.log, [
      "alpha>beta:status",
      "alpha>beta:runner-stage",
      "alpha>beta:runner-enable",
    ]);
    assert.equal((yield* alpha.row)?.enabled, 0);
    const source = yield* alpha.record;
    assert.equal(source?.state, "moving");
    assert.equal((yield* beta.record)?.state, "settled");
    assert.equal((yield* beta.row)?.enabled, 1);
    // The due slot went with it.
    assert.equal((yield* beta.row)?.next_run_at, DUE);
    // The source refuses changes while it does not know how the move ended.
    const refused = yield* alpha.service
      .setEnabled({ id: ROUTINE, enabled: true })
      .pipe(Effect.flip);
    assert.equal(refused.message, MOVING_ROUTINE_CHANGE_REFUSAL);

    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(beta.fires(), 1);
    const afterRun = yield* beta.row;

    // The same enable again, as a retry sends it: answered as before, nothing written.
    const again = yield* beta.transfer!.receive(callerFrom(alpha), {
      op: "runner-enable",
      operationId: source!.operationId!,
      routineId: ROUTINE,
      runState: { nextRunAt: DUE, lastRunAt: null, runCount: 0, onceGeneration: 0 },
      revision: source!.revision,
      acked: [alpha.environmentId],
    });
    assert.deepInclude(again, { enabled: true, operation: "enabled" });
    assert.deepEqual(yield* beta.row, afterRun);
    yield* everyoneLooks;
    assert.equal(fires(), 1);

    // The move tried again asks where it stands first and ends without another enable.
    network.log.length = 0;
    const second = yield* move(alpha, beta, task);
    assert.equal(second.kind, "moved");
    assert.deepEqual(network.log, ["alpha>beta:status"]);
    assert.equal((yield* alpha.record)?.state, "disarmed");
    assert.equal((yield* alpha.row)?.enabled, 0);
    assert.deepEqual(yield* beta.row, afterRun);

    yield* TestClock.adjust("1 minute");
    yield* everyoneLooks;
    assert.equal(fires(), 2);
    assert.equal(alpha.fires(), 0);
  }),
);

it.effect("a move the target never heard of leaves the routine running at its source", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    yield* alpha.makeDue(DUE);
    // The target is cut off after it staged: the enable never arrives.
    const sent = network.log.length;
    const offlineAtEnable = Effect.sync(() => network.offline.add("beta"));
    network.dropAnswer = (_from, _to, op) => {
      if (op === "runner-stage") Effect.runSync(offlineAtEnable);
      return false;
    };
    const outcome = yield* move(alpha, beta, task);
    assert.deepInclude(outcome, { kind: "failed", offHere: true });
    assert.deepEqual(network.log.slice(sent), [
      "alpha>beta:status",
      "alpha>beta:runner-stage",
      "alpha>beta:runner-enable",
    ]);
    // Neither fires while the end of the move is unknown.
    yield* everyoneLooks;
    assert.equal(fires(), 0);
    // Reachable again: the retry repeats the one enable and the slot runs once, there.
    network.offline.delete("beta");
    network.dropAnswer = () => false;
    assert.equal((yield* move(alpha, beta, task)).kind, "moved");
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(beta.fires(), 1);
  }),
);

it.effect("concurrent edits: one is saved, the stale one is refused and changes nothing", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const listed = (machine: Machine) =>
      machine.service.list().pipe(Effect.map((list) => list.tasks.find((t) => t.id === ROUTINE)!));
    const onRunner = yield* listed(alpha);
    const onCopy = yield* listed(beta);
    assert.deepInclude(onRunner.runner, { here: true, revision: 0 });
    assert.deepInclude(onCopy.runner, { here: false, revision: 0, label: "alpha" });
    const edit = (machine: Machine, title: string, expectedRevision: number) =>
      machine.service.upsert(
        taskInput({ id: ROUTINE, projectId: machine.projectId, title, expectedRevision }),
      );

    // Two changes against the same revision at the same moment, one on each machine.
    const both = yield* Effect.all(
      [Effect.result(edit(alpha, "From alpha", 0)), Effect.result(edit(beta, "From beta", 0))],
      { concurrency: "unbounded" },
    );
    const saved = both.filter((result) => result._tag === "Success");
    const refused = both.filter((result) => result._tag === "Failure");
    assert.equal(saved.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(
      refused[0]!._tag === "Failure" ? refused[0]!.failure.message : "",
      STALE_ROUTINE_EDIT_REFUSAL,
    );
    const winner = (yield* alpha.row)!.title;
    assert.include(["From alpha", "From beta"], winner);
    assert.equal((yield* listed(alpha)).revision, 1);
    // Whichever lost, the copy now shows what the runner holds and its revision.
    assert.equal((yield* beta.row)?.title, winner);
    assert.equal((yield* listed(beta)).revision, 1);

    // The same on one machine: the second change against the old revision is refused.
    const stale = yield* edit(alpha, "Stale", 0).pipe(Effect.flip);
    assert.equal(stale.message, STALE_ROUTINE_EDIT_REFUSAL);
    assert.equal((yield* alpha.row)?.title, winner);

    // A change made on the copy goes to the runner, and the copy shows what the runner saved.
    yield* edit(beta, "Sent to the runner", 1);
    assert.equal((yield* alpha.row)?.title, "Sent to the runner");
    assert.equal((yield* beta.row)?.title, "Sent to the runner");
    assert.equal((yield* listed(alpha)).revision, 2);
    assert.equal((yield* listed(beta)).revision, 2);
    // A change with no revision named (an agent's) is made as it comes.
    yield* beta.service.setEnabled({ id: ROUTINE, enabled: false });
    assert.equal((yield* alpha.row)?.enabled, 0);
    assert.equal((yield* listed(beta)).revision, 3);
    // The copy stays a copy: it is not turned on to fire here.
    assert.equal((yield* beta.record)?.state, "disarmed");
  }),
);

it.effect("a stale change is refused before any runner is settled, too", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"], { release: { beta: "1.0.377" } });
    const [alpha] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* settle(alpha);
    assert.isNull(yield* alpha.record);
    const edit = (title: string, expectedRevision: number) =>
      alpha.service.upsert(
        taskInput({ id: ROUTINE, projectId: alpha.projectId, title, expectedRevision }),
      );
    yield* edit("First", 0);
    const stale = yield* edit("Second", 0).pipe(Effect.flip);
    assert.equal(stale.message, STALE_ROUTINE_EDIT_REFUSAL);
    assert.equal((yield* alpha.row)?.title, "First");
    yield* edit("Third", 1);
    assert.equal((yield* alpha.row)?.title, "Third");
  }),
);

it.effect("a change that cannot reach the runner is refused and nothing is written here", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    network.offline.add("alpha");
    const before = yield* beta.row;
    const refused = yield* beta.service
      .upsert(taskInput({ id: ROUTINE, projectId: beta.projectId, title: "Unsent" }))
      .pipe(Effect.flip);
    assert.include(refused.message, "This routine runs on alpha");
    const off = yield* beta.service.setEnabled({ id: ROUTINE, enabled: false }).pipe(Effect.flip);
    assert.include(off.message, "Nothing was changed");
    assert.deepEqual(yield* beta.row, before);
  }),
);

it.effect("the release before is never sent a runner move, and keeps nothing of one", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"], {
      release: { beta: "1.0.377" },
    });
    const [alpha, beta] = machines as [Machine, Machine];
    // A routine bound to a worker thread, as Away moves it.
    yield* alpha.sql`INSERT INTO orchestration_v2_projection_threads ${alpha.sql.insert({ thread_id: "worker-thread", project_id: alpha.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
    const task = yield* alpha.seed({ threadId: "worker-thread" });
    yield* alpha.makeDue(DUE);
    const outcome = yield* move(alpha, beta, task);
    assert.deepEqual(outcome, {
      kind: "failed",
      detail: needsUpdateDetail("beta"),
      offHere: false,
    });
    // Asked once whether it keeps runner records; it answered 400 and nothing else was sent.
    assert.deepEqual(network.log, ["alpha>beta:status"]);
    assert.isUndefined(yield* beta.row);
    assert.equal((yield* alpha.row)?.enabled, 1);
    assert.isNull(yield* alpha.record);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(alpha.state.sends, 1);
  }),
);

it.effect("a source of the release before still moves a routine here and takes it back", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires } = yield* fleet(["alpha", "beta"], {
      release: { alpha: "1.0.377" },
    });
    const [alpha, beta] = machines as [Machine, Machine];
    yield* beta.sql`INSERT INTO orchestration_v2_projection_threads ${beta.sql.insert({ thread_id: "worker-thread", project_id: beta.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
    const copy = copyOf(yield* alpha.seed({ threadId: null }));
    yield* alpha.service.setEnabled({ id: ROUTINE, enabled: false });
    // The three bodies 1.0.377 sends, in its order: no operation id, no capability.
    const send = (body: Record<string, unknown>) =>
      beta
        .transfer!.receive(callerFrom(alpha), {
          protocolVersion: PROTOCOL_377,
          ...body,
        } as never)
        .pipe(Effect.map((answer) => decode377(overTheWire(answer))));
    const staged = yield* send({
      op: "stage",
      sourceProjectId: alpha.projectId,
      routine: { ...copy, enabled: false },
      ownThread: false,
      boundThreadId: "worker-thread",
    });
    assert.deepInclude(staged, { projectId: beta.projectId, enabled: false });
    assert.equal((yield* beta.row)?.enabled, 0);
    const enabled = yield* send({
      op: "enable",
      routineId: ROUTINE,
      runState: { nextRunAt: DUE, lastRunAt: null, runCount: 4, onceGeneration: 0 },
    });
    assert.equal(enabled.enabled, true);
    assert.deepInclude(yield* beta.row, { enabled: 1, next_run_at: DUE, run_count: 4 });
    // It is not this release's runner record that lets it run: none was written.
    assert.isNull(yield* beta.record);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(beta.state.sends, 1);
    const released = yield* send({ op: "release", routineId: ROUTINE });
    assert.equal(released.enabled, false);
    assert.equal(released.runState?.runCount, 5);
    assert.isUndefined(yield* beta.row);
  }),
);

it.effect("the release before cannot turn on or restage a routine that has a runner here", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const copy = copyOf(task);
    // Beta, acting as 1.0.377 would, tries its `stage` and `enable` on the runner.
    const stage = yield* alpha
      .transfer!.receive(callerFrom(beta), {
        protocolVersion: PROTOCOL_377,
        op: "stage",
        sourceProjectId: beta.projectId,
        routine: copy,
        ownThread: true,
        boundThreadId: null,
      })
      .pipe(Effect.flip);
    assert.equal(stage.status, 409);
    const enable = yield* alpha
      .transfer!.receive(callerFrom(beta), {
        protocolVersion: PROTOCOL_377,
        op: "enable",
        routineId: ROUTINE,
        runState: { nextRunAt: DUE, lastRunAt: null, runCount: 0, onceGeneration: 0 },
      })
      .pipe(Effect.flip);
    assert.include([403, 409], enable.status);
    assert.equal((yield* alpha.record)?.state, "settled");
    // And every answer of this release names the capability an older one lacks.
    const status = yield* alpha.transfer!.receive(callerFrom(beta), { op: "status" });
    assert.deepInclude(status, { capabilities: [ROUTINE_RUNNER_CAPABILITY] });
  }),
);

it.effect("a thread handoff neither copies nor turns on its routine anywhere", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.sql`INSERT INTO orchestration_v2_projection_threads ${alpha.sql.insert({ thread_id: "worker-thread", project_id: alpha.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
    yield* alpha.seed({ threadId: "worker-thread" });
    yield* alpha.makeDue(DUE);
    // The thread was handed off: this copy of it no longer runs.
    alpha.state.movedThreads.set("worker-thread", "beta");
    yield* settle(alpha);
    yield* settle(beta);
    yield* everyoneLooks;
    assert.equal(fires(), 0);
    assert.equal(alpha.state.sends, 0);
    assert.equal((yield* alpha.row)?.last_run_error, "Its thread was handed off to beta.");
    assert.isUndefined(yield* beta.row);
    assert.deepEqual(network.log, []);
    assert.isNull(yield* alpha.record);
  }),
);

it.effect("a replica or a planned handover never rewrites the routine its runner holds", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const copies = yield* alpha.service.routineCopies!();
    yield* copies.replace({
      projectId: alpha.projectId,
      logicalProjectId: "logical-a",
      routines: [{ ...copyOf(task), title: "From a replica" }],
    });
    assert.equal((yield* alpha.row)?.title, "Synthetic review");
    // A replica that leaves it out does not remove it either.
    yield* copies.replace({
      projectId: alpha.projectId,
      logicalProjectId: "logical-a",
      routines: [],
    });
    assert.isDefined(yield* alpha.row);
    // The copy that rests takes its definition from its runner only: a replica
    // may be older than what the runner sent, and would turn its row on again.
    const resting = yield* beta.service.routineCopies!();
    yield* resting.replace({
      projectId: beta.projectId,
      logicalProjectId: "logical-a",
      routines: [{ ...copyOf(task), title: "From a replica" }],
    });
    assert.equal((yield* beta.row)?.title, "Synthetic review");
    assert.notOk((yield* beta.row)?.enabled);
    assert.equal((yield* beta.record)?.state, "disarmed");
  }),
);

it.effect("a machine that stopped coordinating before all confirmed never becomes the runner", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    for (const machine of machines) yield* machine.seed();
    // Gamma said it keeps runner records, then dropped off before it was asked to rest.
    network.dropAnswer = (_from, to, op) => {
      if (to === "gamma" && op === "status") network.offline.add("gamma");
      return false;
    };
    yield* settle(alpha);
    assert.deepInclude(yield* alpha.record, { state: "settling", acked: [beta.environmentId] });
    assert.isNull(yield* gamma.record);
    // Gamma is back and the coordinator moves to it: it fires the slot under the coordinator rule.
    network.dropAnswer = () => false;
    network.offline.delete("gamma");
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    gamma.state.role = { active: true, epoch: 2, state: "active" };
    for (const machine of machines) yield* machine.makeDue(DUE);
    yield* gamma.due;
    assert.equal(gamma.fires(), 1);
    // Alpha's copy still holds that slot. It asks again: it must not settle and fire it.
    yield* settle(alpha);
    assert.isNull(yield* alpha.record);
    assert.isNull(yield* beta.record);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
  }),
);

it.effect("deleting on the runner removes the resting copies, or deletes nothing", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    // A copy that cannot be reached would bring the routine back with its next replica.
    network.offline.add("beta");
    const refused = yield* alpha.service.delete({ id: ROUTINE }).pipe(Effect.flip);
    assert.equal(refused.message, deleteUnreachedRefusal(["beta"]));
    assert.isDefined(yield* alpha.row);
    network.offline.delete("beta");
    yield* alpha.service.delete({ id: ROUTINE });
    assert.isUndefined(yield* alpha.row);
    assert.isUndefined(yield* beta.row);
    assert.isNull(yield* beta.record);
    // And a replica that still names it does not bring it back as a routine that could fire twice.
    assert.isNull(yield* alpha.record);
    assert.equal(task.id, ROUTINE);
  }),
);

it.effect("a delete sent from a copy removes every other copy as well", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    for (const machine of machines) yield* machine.seed();
    yield* settle(alpha);
    yield* beta.service.delete({ id: ROUTINE });
    for (const machine of [alpha, beta, gamma]) assert.isUndefined(yield* machine.row);
  }),
);

it.effect("the runner saves its own routine after the coordinator moved elsewhere", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    alpha.state.role = { active: false, epoch: 2, state: "transferred" };
    beta.state.role = { active: true, epoch: 2, state: "active" };
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, title: "Saved on its runner" }),
    );
    assert.equal((yield* alpha.row)?.title, "Saved on its runner");
  }),
);

it.effect("a routine still settling follows its replica and its handover as before", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, , gamma] = machines as [Machine, Machine, Machine];
    const task = yield* alpha.seed();
    for (const machine of machines.slice(1)) yield* machine.seed();
    network.dropAnswer = (_from, to, op) => to === "gamma" && op === "runner-disarm";
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settling");
    // Alpha still runs under the coordinator rule, so what the coordinator sends still lands.
    const copies = yield* alpha.service.routineCopies!();
    yield* copies.replace({
      projectId: alpha.projectId,
      logicalProjectId: "logical-a",
      routines: [{ ...copyOf(task), title: "From the coordinator" }],
    });
    assert.equal((yield* alpha.row)?.title, "From the coordinator");
    assert.equal(gamma.fires(), 0);
  }),
);

it.effect("resting copies hear the revision of a change made on the runner", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, title: "Changed on the runner" }),
    );
    yield* settle(alpha);
    assert.equal((yield* beta.record)?.revision, 1);
    // So a change made on the copy against what it shows is taken, not refused as stale.
    yield* beta.service.upsert(
      taskInput({
        id: ROUTINE,
        projectId: beta.projectId,
        title: "Changed on the copy",
        expectedRevision: 1,
      }),
    );
    assert.equal((yield* alpha.row)?.title, "Changed on the copy");
  }),
);

it.effect("a delete whose answer was lost is finished by asking again", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    network.dropAnswer = (from, _to, op) => from === "beta" && op === "runner-edit";
    yield* beta.service.delete({ id: ROUTINE }).pipe(Effect.flip);
    // Deleted on the runner, and the copy never heard.
    assert.isUndefined(yield* alpha.row);
    network.dropAnswer = () => false;
    yield* beta.service.delete({ id: ROUTINE });
    assert.isUndefined(yield* beta.row);
    assert.isNull(yield* beta.record);
  }),
);

it.effect("a delete on the runner and a change on a copy at once both end", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    // Each machine sends to the other while it works; neither waits on the other's lock.
    yield* Effect.all(
      [
        Effect.result(alpha.service.delete({ id: ROUTINE })),
        Effect.result(
          beta.service.upsert(
            taskInput({ id: ROUTINE, projectId: beta.projectId, title: "From the copy" }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    assert.isUndefined(yield* alpha.row);
    assert.isUndefined(yield* beta.row);
    assert.isNull(yield* beta.record);
  }),
);

it.effect("a revision push queued before a move never names the old runner again", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* gamma.seed();
    yield* settle(alpha);
    assert.equal((yield* move(alpha, beta, task)).kind, "moved");
    yield* settle(beta);
    assert.equal((yield* gamma.record)?.runnerEnvironmentId, beta.environmentId);
    const answer = yield* gamma.runner.receive(callerFrom(alpha), {
      op: "runner-disarm",
      sourceProjectId: alpha.projectId,
      routineIds: [ROUTINE],
      revisions: [0],
      refresh: true,
    });
    assert.deepEqual(answer.refused, [ROUTINE]);
    assert.equal((yield* gamma.record)?.runnerEnvironmentId, beta.environmentId);
  }),
);

it.effect("the list a screen subscribes to carries each routine's revision and runner", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const first = (machine: Machine) =>
      machine.service
        .subscribeList()
        .pipe(Stream.take(1), Stream.runCollect)
        .pipe(Effect.map((lists) => [...lists][0]!.tasks.find((t) => t.id === ROUTINE)!));
    assert.deepInclude((yield* first(alpha)).runner, { here: true, revision: 0 });
    assert.deepInclude((yield* first(beta)).runner, { here: false, label: "alpha" });
    assert.equal((yield* first(beta)).revision, 0);
  }),
);

it.effect("a move cut off before it turned the routine off leaves the row as a person set it", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const settled = (yield* alpha.record)!;
    // A move records turning the routine off together with turning it off. One cut
    // off before that never touched the row, so an off row is a person's doing.
    yield* alpha.runner.records.write({
      ...settled,
      state: "moving",
      operationId: "operation-cut-off",
      operation: {
        target: beta.environmentId,
        targetLabel: "beta",
        targetProjectId: null,
        capped: false,
        phase: "staged",
        wasEnabled: true,
        runState: null,
        prior: settled,
      },
    });
    yield* alpha.sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = ${ROUTINE}`;
    assert.deepInclude(yield* move(alpha, beta, task), { kind: "failed", offHere: false });
    assert.equal((yield* alpha.row)?.enabled, 0);
    assert.equal((yield* alpha.record)?.state, "settled");
  }),
);

it.effect("a routine taken back is named as the runner by every other copy again", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    const task = yield* alpha.seed();
    yield* beta.seed();
    yield* gamma.seed();
    yield* settle(alpha);
    assert.equal((yield* move(alpha, beta, task)).kind, "moved");
    yield* settle(beta);
    assert.equal((yield* gamma.record)?.runnerEnvironmentId, beta.environmentId);
    const back = yield* alpha.transfer!.bringBack({
      task,
      target: beta.environmentId,
      targetLabel: "beta",
      wasEnabled: true,
    });
    assert.equal(back.kind, "returned");
    yield* settle(alpha);
    assert.equal((yield* gamma.record)?.runnerEnvironmentId, alpha.environmentId);
    assert.equal((yield* alpha.record)?.state, "settled");
  }),
);

it.effect("a delete refused by one unreachable copy never leaves two machines firing", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines, network, everyoneLooks, fires } = yield* fleet(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = machines as [Machine, Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* gamma.seed();
    yield* settle(alpha);
    network.offline.add("gamma");
    const refused = yield* alpha.service.delete({ id: ROUTINE }).pipe(Effect.flip);
    assert.equal(refused.message, deleteUnreachedRefusal(["gamma"]));
    // Beta gave its copy up, so alpha no longer counts it as resting.
    assert.isUndefined(yield* beta.row);
    assert.equal((yield* alpha.record)?.state, "settling");
    assert.notInclude((yield* alpha.record)?.acked ?? [], beta.environmentId);
    // A replica brings beta's copy back; it is told to rest again before alpha runs alone.
    yield* beta.seed();
    network.offline.delete("gamma");
    yield* settle(alpha);
    assert.equal((yield* alpha.record)?.state, "settled");
    assert.equal((yield* beta.record)?.state, "disarmed");
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    yield* everyoneLooks;
    assert.equal(fires(), 1);
    assert.equal(gamma.fires(), 0);
  }),
);

it.effect("a screen hears the new revision of a change it just saved", () =>
  Effect.gen(function* () {
    yield* start;
    const { machines } = yield* fleet(["alpha", "beta"]);
    const [alpha, beta] = machines as [Machine, Machine];
    yield* alpha.seed();
    yield* beta.seed();
    yield* settle(alpha);
    const revisions: Array<number | undefined> = [];
    const watching = yield* alpha.service.subscribeList().pipe(
      Stream.map((list) => list.tasks.find((t) => t.id === ROUTINE)?.revision),
      Stream.tap((revision) => Effect.sync(() => void revisions.push(revision))),
      Stream.takeUntil((revision) => revision === 1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    // The first list arrives once the subscription is open.
    while (revisions.length === 0) yield* Effect.yieldNow;
    yield* alpha.service.upsert(
      taskInput({ id: ROUTINE, projectId: alpha.projectId, title: "Saved", expectedRevision: 0 }),
    );
    yield* Fiber.join(watching);
    assert.equal(revisions.at(-1), 1);
  }),
);
