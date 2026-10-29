/**
 * Automatic coordinator takeover end to end (1086 T-15, AC-03..AC-11).
 *
 * Three machines: M4 coordinates EasyChamp, M1 is its armed standby, and M3
 * runs a worker for it. Each machine has its own ProjectLink over in-memory
 * projects (ProjectLink.testkit.ts), its own wall clock and monotonic clock,
 * and one runtime, so the project lock the lease handler and the takeover
 * take is the one lock of that machine. M4 runs the real lease loop and
 * fence; M1 runs the real lease receiver, standby watch and takeover; M3
 * keeps coordinator epochs by the worker machine's own rules. Peer calls
 * cross a stub network that encodes and decodes every body as the wire does.
 *
 * Time moves in 30-second steps. In each step M4 sends its lease (when
 * awake) and M1 checks its clock (when awake). After every step the fleet
 * checks that M4 and M1 never both run a coordinator.
 */
import {
  EnvironmentId,
  type HandoffIncomingReplica,
  type LogicalProjectMember,
  type ProjectCoordinatorBinding,
  type ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { StudioWorkGrantProjects } from "@specweave-studio/contracts/studioFleet";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import {
  adoptedRowId,
  adoptionCandidates,
  RemoteWorkerAdoption,
  layer as RemoteWorkerAdoptionLayer,
} from "../fleet/RemoteWorkerAdoption.ts";
import { target as workerMachine } from "../fleet/fleetMachine.testkit.ts";
import { allow, eventually, rows, setup } from "../fleet/remoteWorkers.testkit.ts";
import { applyEpochClaim, epochAdmits, type WorkerEpochRecord } from "../fleet/WorkerEpochStore.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import {
  autoContinueCandidates,
  autoContinueMinutes,
  designatedMachine,
  peerPastFence,
  noteAnnounced,
} from "../handoff/HandoffAutoContinue.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  type HandoffIncomingDetail,
  heartbeatContinued,
  incomingKey,
} from "../handoff/handoffState.ts";
import {
  CoordinatorLeaseRequest,
  CoordinatorLeaseResponse,
  CoordinatorReplicaRequest,
  CoordinatorReplicaResponse,
} from "../handoff/handoffWire.ts";
import {
  type CoordinatorLeaseShape,
  makeCoordinatorLease,
  type PauseInput,
} from "./CoordinatorLease.ts";
import * as CoordinatorLeaseRoute from "./CoordinatorLeaseRoute.ts";
import { makeMemory } from "./CoordinatorLeaseStore.ts";
import type {
  CoordinatorStandbyShadowWorker,
  CoordinatorStandbyStore,
} from "./CoordinatorStandbyStore.ts";
import { makeStandbyWatch, STANDBY_TICK_MS } from "./CoordinatorStandbyWatch.ts";
import { COORDINATOR_FENCE_REFUSAL, makeCheck, makeFenceSweep } from "./CoordinatorWakeGate.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectLink from "./ProjectLink.ts";
import { checkout, machine, removeCheckouts } from "./ProjectLink.testkit.ts";
import { autoTakeoverOperationId } from "./ProjectLinkStandby.ts";

const MINUTE = 60_000;
const TICK = STANDBY_TICK_MS;
const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const linkM1 = "11111111-1111-4111-8111-111111111111";
const linkM3 = "22222222-2222-4222-8222-222222222222";
const standbyOn = "33333333-3333-4333-8333-333333333333";
const standbyOff = "44444444-4444-4444-8444-444444444444";
const handToM3 = "55555555-5555-4555-8555-555555555555";

type Name = "m4" | "m1" | "m3";
const NAMES: ReadonlyArray<Name> = ["m4", "m1", "m3"];

/** The live clock with its time replaced, so DateTime.now and Clock both read `wall`. */
const liveClock = Effect.runSync(Clock.clockWith(Effect.succeed));
const clockReading = (wall: () => number): Clock.Clock =>
  Object.assign(Object.create(liveClock) as Clock.Clock, {
    currentTimeMillisUnsafe: wall,
    currentTimeMillis: Effect.sync(wall),
    currentTimeNanosUnsafe: () => BigInt(wall()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(wall()) * 1_000_000n),
  });

/** What the HTTP route does to a body: encode, send as JSON, decode. */
const overWire =
  <T>(encode: (value: T) => unknown, decode: (value: unknown) => T) =>
  (value: T) =>
    decode(JSON.parse(JSON.stringify(encode(value))));
const leaseWire = overWire(
  Schema.encodeSync(CoordinatorLeaseRequest),
  Schema.decodeUnknownSync(CoordinatorLeaseRequest),
);
const leaseAnswerWire = overWire(
  Schema.encodeSync(CoordinatorLeaseResponse),
  Schema.decodeUnknownSync(CoordinatorLeaseResponse),
);
const replicaWire = overWire(
  Schema.encodeSync(CoordinatorReplicaRequest),
  Schema.decodeUnknownSync(CoordinatorReplicaRequest),
);
const replicaAnswerWire = overWire(
  Schema.encodeSync(CoordinatorReplicaResponse),
  Schema.decodeUnknownSync(CoordinatorReplicaResponse),
);

const callerFrom = (environment: string, projects: StudioWorkGrantProjects): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects,
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, unknown>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  removeCheckouts();
});

const succeeded = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

/**
 * The fleet, linked and armed: M1 is the standby after `afterMinutes`, and M3
 * holds a copy of the project with one worker M4's coordinator started there.
 */
async function fleet(options: { readonly afterMinutes?: 5 | 15 | 30 | 60 } = {}) {
  const afterMinutes = options.afterMinutes ?? 15;
  const m4 = machine("m4");
  const m1 = machine("m1");
  const m3 = machine("m3");
  const roots = {
    m4: m4.add("easychamp-m4", checkout("git@github.com:anton/sw-easychamp.git")).workspaceRoot,
    m1: m1.add("easychamp-m1", checkout("https://github.com/anton/sw-easychamp.git")).workspaceRoot,
    m3: m3.add("easychamp-m3", checkout("https://github.com/anton/sw-easychamp")).workspaceRoot,
  };
  const members = {
    m4: { ...m4.member("easychamp-m4"), workspaceRoot: roots.m4 },
    m1: { ...m1.member("easychamp-m1"), workspaceRoot: roots.m1 },
    m3: { ...m3.member("easychamp-m3"), workspaceRoot: roots.m3 },
  } satisfies Record<Name, LogicalProjectMember>;
  const machines = { m4, m1, m3 };

  /** Each machine's own clocks: the wall clock, and a monotonic one that stops while it sleeps. */
  const clocks = {
    m4: { wall: T0, mono: 0 },
    m1: { wall: T0, mono: 0 },
    m3: { wall: T0, mono: 0 },
  } satisfies Record<Name, { wall: number; mono: number }>;
  const awake: Record<Name, boolean> = { m4: true, m1: true, m3: true };
  /** Links that carry nothing, as "m1|m4" (sorted). */
  const cut = new Set<string>();
  const pair = (a: Name, b: Name) => [a, b].sort().join("|");
  const reaches = (a: Name, b: Name) => awake[a] && awake[b] && !cut.has(pair(a, b));
  /** Coordinators whose work grant M1 revoked; the route refuses them before the receiver. */
  const revokedOnM1 = new Set<string>();

  const runtimeM4 = ManagedRuntime.make(Layer.merge(m4.layer, ProjectAdmission.layer));
  const runtimeM1 = ManagedRuntime.make(
    Layer.merge(CoordinatorLeaseRoute.layer, ProjectAdmission.layer).pipe(
      Layer.provideMerge(m1.layer),
    ),
  );
  const runtimeM3 = ManagedRuntime.make(m3.layer);
  runtimes.push(
    runtimeM4 as ManagedRuntime.ManagedRuntime<never, unknown>,
    runtimeM1 as ManagedRuntime.ManagedRuntime<never, unknown>,
    runtimeM3 as ManagedRuntime.ManagedRuntime<never, unknown>,
  );
  const timed =
    <R, ER>(runtime: ManagedRuntime.ManagedRuntime<R, ER>, name: Name) =>
    <A, E>(effect: Effect.Effect<A, E, R>) =>
      runtime.runPromiseExit(
        effect.pipe(
          Effect.provideService(
            Clock.Clock,
            clockReading(() => clocks[name].wall),
          ),
        ),
      );
  const exitOn = {
    m4: timed(runtimeM4, "m4"),
    m1: timed(runtimeM1, "m1"),
    m3: timed(runtimeM3, "m3"),
  };
  const on4 = <A, E>(
    effect: Effect.Effect<A, E, ProjectLink.ProjectLink | ProjectAdmission.ProjectAdmission>,
  ) => exitOn.m4(effect).then(succeeded);
  const on1 = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | ProjectLink.ProjectLink
      | ProjectAdmission.ProjectAdmission
      | CoordinatorLeaseRoute.CoordinatorLeaseReceiver
      | CoordinatorStandbyStore
    >,
  ) => exitOn.m1(effect).then(succeeded);
  const on3 = <A, E>(effect: Effect.Effect<A, E, ProjectLink.ProjectLink>) =>
    exitOn.m3(effect).then(succeeded);
  const link4 = <A, E>(use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, E>) =>
    on4(Effect.flatMap(ProjectLink.ProjectLink, use));
  const link1 = <A, E>(use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, E>) =>
    on1(Effect.flatMap(ProjectLink.ProjectLink, use));
  const link3 = <A, E>(use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, E>) =>
    on3(Effect.flatMap(ProjectLink.ProjectLink, use));
  const receiver1 = <A>(
    use: (
      receiver: CoordinatorLeaseRoute.CoordinatorLeaseReceiver["Service"],
    ) => Effect.Effect<A, HandoffRefusal>,
  ) => exitOn.m1(Effect.flatMap(CoordinatorLeaseRoute.CoordinatorLeaseReceiver, use));

  // Link M1 and M3 to M4's copy, the way the app does: prepare, accept, commit.
  const join = async (name: "m1" | "m3", operationId: string, link: typeof link1) => {
    const prepared = await link4((service) =>
      service.prepare({ operationId, projectId: members.m4.projectId, joining: members[name] }),
    );
    const accepted = await link((service) =>
      service.accept({
        operationId,
        projectId: members[name].projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      }),
    );
    await link4((service) =>
      service.commit({
        operationId,
        projectId: members.m4.projectId,
        joining: accepted.member,
        notes: [],
      }),
    );
    return prepared.logicalProject.id;
  };
  const logicalProjectId = await join("m1", linkM1, link1);
  await join("m3", linkM3, link3);

  // The owner arms the standby on both machines.
  await link4((service) =>
    service.setStandby({
      operationId: standbyOn,
      projectId: members.m4.projectId,
      standby: { member: members.m1, afterMinutes },
    }),
  );
  await link1((service) =>
    service.acceptStandby({
      projectId: members.m1.projectId,
      logicalProjectId,
      standby: { coordinator: members.m4, epoch: 0, afterMinutes },
    }),
  );

  // M3: the coordinator epochs claimed here, and who started each worker thread.
  const epochs = new Map<string, WorkerEpochRecord>();
  const workerOrigins = new Map<string, string>([["m3-worker-thread", "m4"]]);
  const claims: Array<{ by: Name; epoch: number; accepted: boolean }> = [];

  // M4: its coordinator's running turns, its worker on M3, and what it interrupted.
  const running = new Map<string, { threadId: string; title: string }>();
  const workers: Array<CoordinatorStandbyShadowWorker> = [
    {
      id: "m4-row-1",
      callerThreadId: members.m4.coordinatorThreadId,
      machineId: "m3",
      environmentId: "m3",
      remoteProjectId: members.m3.projectId,
      remoteThreadId: "m3-worker-thread",
      title: "Fix the flaky test",
      state: "following",
      followedRunId: "m3-run-1",
      deliveredRunIds: ["m3-run-0"],
    },
  ];
  const interrupts: Array<{ at: number; reason: string }> = [];
  const stoppedWorkers: Array<number> = [];
  const state = { plannedPauseUntil: null as number | null };
  const sent: Array<CoordinatorLeaseRequest> = [];

  const peerFailure = (code: HandoffPeerError["code"], message: string) =>
    Effect.fail(new HandoffPeerError({ code, message, uncertain: code === "unreachable" }));
  const fromRefusal = (refusal: HandoffRefusal) =>
    new HandoffPeerError({
      code: refusal.code,
      message: refusal.message,
      check: refusal.check,
      uncertain: false,
    });
  /** M4's grant on M1 lists only M1's copy, as arming leaves it (AC-02). */
  const m4OnM1 = callerFrom("m4", { kind: "listed", projectIds: [members.m1.projectId] });
  const toM1 = <A>(
    deliver: (
      receiver: CoordinatorLeaseRoute.CoordinatorLeaseReceiver["Service"],
    ) => Effect.Effect<A, HandoffRefusal>,
  ) =>
    Effect.gen(function* () {
      if (!reaches("m4", "m1")) return yield* peerFailure("unreachable", "M1 did not answer.");
      if (revokedOnM1.has("m4")) {
        yield* Effect.promise(() => receiver1((receiver) => receiver.grantRefused("m4")));
        return yield* peerFailure("needs_grant", "This machine revoked that machine's work here.");
      }
      const exit = yield* Effect.promise(() => receiver1(deliver));
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      if (failure === undefined) return yield* Effect.die(Cause.squash(exit.cause));
      return yield* fromRefusal(failure.error);
    });

  const stopCoordinator = () =>
    Effect.sync(() => {
      interrupts.push({ at: clocks.m4.wall, reason: "stopped" });
      running.clear();
    });
  const makeLease = () =>
    on4(
      Effect.gen(function* () {
        const link = yield* ProjectLink.ProjectLink;
        const admission = yield* ProjectAdmission.ProjectAdmission;
        const loadProject = (id: ProjectId) => Effect.sync(() => m4.projects.get(id));
        return makeCoordinatorLease({
          store: leaseRecords.service,
          admission,
          link,
          selfEnvironmentId: "m4",
          peers: {
            coordinatorLease: (environmentId, request) =>
              Effect.suspend(() => {
                expect(environmentId).toBe("m1");
                const body = leaseWire(request);
                sent.push(body);
                return toM1((receiver) => receiver.lease(m4OnM1, body)).pipe(
                  Effect.map(leaseAnswerWire),
                );
              }),
            coordinatorReplica: (_environmentId, request) =>
              toM1((receiver) => receiver.replica(m4OnM1, replicaWire(request))).pipe(
                Effect.map(replicaAnswerWire),
              ),
          },
          listProjects: Effect.sync(() => [...m4.projects.values()]),
          loadProject,
          runningThreads: () => Effect.sync(() => [...running.values()]),
          workers: () => Effect.succeed(workers),
          stopCoordinator,
          stopCoordinatorWorkers: () =>
            Effect.sync(() => {
              stoppedWorkers.push(clocks.m4.wall);
              return workers.length;
            }),
          plannedPauseUntil: Effect.sync(() => state.plannedPauseUntil),
          afterTick: makeFenceSweep({ store: leaseRecords.service, loadProject, stopCoordinator }),
        });
      }),
    );
  /** M4's lease records: its file on disk, which outlives a restart. */
  const leaseRecords = makeMemory();
  let lease: CoordinatorLeaseShape = await makeLease();
  /** M1's standby watch: making it is the process start. */
  const makeWatch = () => on1(makeStandbyWatch({ nowMs: () => clocks.m1.mono }));
  let watch = await makeWatch();

  const binding = (name: Name): ProjectCoordinatorBinding =>
    machines[name].projects.get(members[name].projectId)!.workspaceSettings!.coordinatorBinding ?? {
      epoch: 0,
      state: "active",
    };
  /** The epoch a machine names when it steers M3: its own while it coordinates, else none. */
  const namedEpoch = (name: Name) =>
    binding(name).state === "active" ? binding(name).epoch : undefined;
  const steersM3 = (name: "m4" | "m1") =>
    reaches(name, "m3") && epochAdmits(epochs.get(logicalProjectId), namedEpoch(name));
  /** M4's wake gate for its coordinator thread: null when a turn may start. */
  const gateM4 = () => on4(makeCheck(leaseRecords.service)(members.m4.coordinatorThreadId));

  const takeovers: Array<{ at: number; epoch: number; operationId: string }> = [];
  const violations: Array<string> = [];

  /** M1 takes over when its clock says so, then claims the epoch on M3 (AC-07, AC-08). */
  const standbyRound = async () => {
    const { due } = await on1(watch.tick);
    for (const record of due) {
      const outcome = await link1((service) =>
        service.autoTakeover({ logicalProjectId: record.logicalProjectId }),
      );
      if (outcome.outcome !== "taken-over" || outcome.result.replayed) continue;
      const taken = outcome.result.coordinatorBinding;
      takeovers.push({ at: clocks.m1.wall, epoch: taken.epoch, operationId: taken.operationId! });
      if (!reaches("m1", "m3")) continue;
      const claim = applyEpochClaim(epochs.get(record.logicalProjectId), {
        logicalProjectId: record.logicalProjectId,
        epoch: taken.epoch,
        by: "m1",
      });
      if (claim.next !== undefined)
        epochs.set(record.logicalProjectId, { ...claim.next, claimedAt: iso(clocks.m3.wall) });
      claims.push({ by: "m1", epoch: taken.epoch, accepted: claim.accepted });
    }
  };

  /** Two coordinators at once: M4 active with its gate open while M1 is active too. */
  const checkOneCoordinator = async () => {
    if (binding("m1").state !== "active" || binding("m4").state !== "active") return;
    if ((await gateM4()) === null)
      violations.push(`M4 and M1 both coordinate at ${iso(clocks.m4.wall)}`);
  };

  const step = async () => {
    for (const name of NAMES) {
      clocks[name].wall += TICK;
      if (awake[name]) clocks[name].mono += TICK;
    }
    if (awake.m4) await on4(lease.tick);
    if (awake.m1) await standbyRound();
    await checkOneCoordinator();
  };
  /** Runs `ms` of 30-second steps. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK) await step();
  };
  /** Runs steps until `until` holds, at most `ms`; returns M4's time when it held, or null. */
  const runUntil = async (until: () => boolean, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK) {
      await step();
      if (until()) return clocks.m4.wall;
    }
    return null;
  };

  return {
    machines,
    members,
    logicalProjectId,
    afterMinutes,
    clocks,
    awake,
    cut,
    pair,
    revokedOnM1,
    epochs,
    workerOrigins,
    claims,
    running,
    workers,
    interrupts,
    stoppedWorkers,
    state,
    sent,
    takeovers,
    violations,
    leaseRecords,
    on4,
    on1,
    link4,
    link1,
    link3,
    receiver1,
    m4OnM1,
    binding,
    steersM3,
    gateM4,
    step,
    run,
    runUntil,
    standbyRound,
    get lease() {
      return lease;
    },
    leaseRecord: () => leaseRecords.records.get(members.m4.projectId),
    standbyRecord: () => m1.standby.get(logicalProjectId),
    /** M4's process starts again: a new lease loop over the same records file. */
    restartM4: async () => {
      lease = await makeLease();
    },
    /** M1's process starts again: every watch begins anew. */
    restartM1: async () => {
      watch = await makeWatch();
    },
    pause: (input: PauseInput) => on4(lease.pause(input)),
  };
}

type Fleet = Awaited<ReturnType<typeof fleet>>;

/** A coordinator turn M4 starts at its current time. */
const startTurn = (f: Fleet, id: string) => {
  const threadId = f.members.m4.coordinatorThreadId;
  const runs = f.machines.m4.runs.get(threadId) ?? [];
  f.machines.m4.runs.set(threadId, [
    ...runs,
    { id, requestedAt: iso(f.clocks.m4.wall), text: `turn ${id}` },
  ]);
  f.running.set(threadId, { threadId, title: "Coordinator" });
};

const expectNoTwoCoordinators = (f: Fleet) => expect(f.violations).toEqual([]);

describe("automatic coordinator takeover, end to end", () => {
  it("takes over after the full silence, claims the epoch and adopts M4's worker", async () => {
    const f = await fleet();
    await f.run(2 * MINUTE);
    // M1 holds M4's content and its worker on M3.
    expect(f.machines.m1.replicas.get(f.members.m1.projectId)).toMatchObject({
      from: { environmentId: "m4" },
    });
    expect(f.standbyRecord()?.shadowWorkers.map((worker) => worker.id)).toEqual(["m4-row-1"]);
    // M4's coordinator steers its worker on M3, as today.
    expect(f.steersM3("m4")).toBe(true);

    // The lid closes right after a lease.
    const quietAt = f.clocks.m4.wall;
    f.awake.m4 = false;
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 30 * MINUTE);
    expect(tookOverAt).toBe(quietAt + 15 * MINUTE);

    const taken = f.binding("m1");
    expect(taken).toMatchObject({
      state: "active",
      epoch: 1,
      takenOverBy: "auto",
      predecessor: { environmentId: "m4", projectId: f.members.m4.projectId },
      operationId: autoTakeoverOperationId(f.logicalProjectId, 1),
    });
    expect(taken.standby).toBeUndefined();
    expect(f.takeovers).toHaveLength(1);
    // M3 holds epoch 1 now: M1 steers, M4 (which still believes epoch 0) only reads.
    expect(f.epochs.get(f.logicalProjectId)).toMatchObject({ epoch: 1, claimedBy: "m1" });
    expect(f.steersM3("m1")).toBe(true);
    f.awake.m4 = true;
    expect(f.steersM3("m4")).toBe(false);
    f.awake.m4 = false;

    // The worker M4's coordinator started is the one M1 takes on.
    const { candidates, waitingForPredecessor } = adoptionCandidates(
      f.standbyRecord()!.shadowWorkers,
      f.members.m4,
    );
    expect(candidates.map((worker) => worker.id)).toEqual(["m4-row-1"]);
    expect(waitingForPredecessor).toBe(0);

    // Through the real adoption: M3 confirms the claim and the origin, the
    // worker's run finishes, and its wake lands on M1's coordinator.
    // remoteWorkers.testkit names this server's worker machine `workerMachine`.
    const { world, layer } = setup({
      studio_coordinator_claim_epoch: (args) => {
        const claim = applyEpochClaim(f.epochs.get(String(args.logicalProjectId)), {
          logicalProjectId: String(args.logicalProjectId),
          epoch: Number(args.epoch),
          by: "m1",
        });
        return {
          result: {
            logicalProjectId: args.logicalProjectId,
            accepted: claim.accepted,
            epoch: claim.epoch,
            origins: (args.threadIds as Array<string>).map((threadId) => ({
              threadId,
              coordinatorEnvironmentId: f.workerOrigins.get(threadId) ?? null,
            })),
          },
        };
      },
      studio_thread_wait: (args) => ({
        result: {
          threadId: args.threadId,
          runId: String(args.runId),
          status: "completed",
          timedOut: false,
        },
      }),
    });
    const adopted = await Effect.runPromise(
      Effect.gen(function* () {
        yield* allow();
        const adoption = yield* RemoteWorkerAdoption;
        const result = yield* adoption.adopt({
          logicalProjectId: f.logicalProjectId,
          epoch: taken.epoch,
          projectId: "local-project",
          coordinatorThreadId: "coordinator",
          predecessor: f.members.m4,
          shadowWorkers: f.standbyRecord()!.shadowWorkers.map((worker) => ({
            ...worker,
            environmentId: workerMachine.environmentId,
          })),
        });
        const settled = yield* eventually(rows, (current) =>
          current.some((row) => row.id === adoptedRowId("m4-row-1") && row.state === "idle"),
        );
        return { result, settled };
      }).pipe(Effect.provide(RemoteWorkerAdoptionLayer.pipe(Layer.provideMerge(layer)))),
    );
    expect(adopted.result).toEqual({
      adopted: [adoptedRowId("m4-row-1")],
      readOnly: [],
      waitingForPredecessor: 0,
    });
    expect(adopted.settled.find((row) => row.id === adoptedRowId("m4-row-1"))).toMatchObject({
      callerThreadId: "coordinator",
      adoptedFrom: { environmentId: "m4", rowId: "m4-row-1", epoch: 1 },
      readOnly: false,
    });
    // The run M4 had not delivered wakes M1's coordinator once.
    expect(world.wakes.map((wake) => wake.commandId)).toEqual([
      `remote-worker-wake:${adoptedRowId("m4-row-1")}:m3-run-1`,
    ]);
    expectNoTwoCoordinators(f);
  });

  it("M4 returns, gives way, stops its workers and lists the turns it ran for review", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    startTurn(f, "before");
    f.running.clear();
    await f.run(MINUTE);
    const confirmedAt = f.clocks.m4.wall;

    // M4 stays awake but loses M1. A turn it starts while not yet fenced runs.
    f.cut.add(f.pair("m4", "m1"));
    await f.run(5 * MINUTE);
    expect(await f.gateM4()).toBeNull();
    startTurn(f, "while-away");

    // The fence goes up 130 seconds before M1 may act, and stops that turn.
    const fencedAt = await f.runUntil(() => f.interrupts.length > 0, 15 * MINUTE);
    expect(fencedAt).toBe(confirmedAt + 13 * MINUTE);
    expect(await f.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    expect(f.takeovers).toEqual([]);
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 5 * MINUTE);
    expect(tookOverAt).toBe(confirmedAt + 15 * MINUTE);

    // The link heals: M4's next lease hears of the takeover and gives way.
    await f.run(5 * MINUTE);
    f.cut.clear();
    const leasesBefore = f.sent.length;
    await f.step();
    expect(f.binding("m4")).toMatchObject({
      state: "transferred",
      epoch: 1,
      successor: { environmentId: "m1", projectId: f.members.m1.projectId },
    });
    const gaveWay = f.leaseRecord()!.gaveWay!;
    expect(gaveWay).toMatchObject({ successor: { environmentId: "m1" }, epoch: 1 });
    // Reviewed from no later than the last lease M1 confirmed: the turn while away is listed.
    expect(Date.parse(gaveWay.reviewFrom)).toBeLessThanOrEqual(confirmedAt);
    expect(gaveWay.ranWhileAway).toBe(1);
    expect(f.stoppedWorkers).toHaveLength(1);
    expect(f.interrupts.length).toBeGreaterThanOrEqual(2);
    // M4 no longer coordinates: no fence, no more leases, and M3 takes no steering from it.
    expect(await f.gateM4()).toBeNull();
    await f.run(2 * MINUTE);
    expect(f.sent.length).toBe(leasesBefore + 1);
    expect(f.steersM3("m4")).toBe(false);
    expect(f.steersM3("m1")).toBe(true);
    expectNoTwoCoordinators(f);
  });

  it("a single lease mid-window starts the silence again (flap)", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    const quietAt = f.clocks.m4.wall;
    f.cut.add(f.pair("m4", "m1"));
    await f.run(10 * MINUTE);
    // One lease gets through, then the link drops again.
    f.cut.clear();
    await f.step();
    const heardAt = f.clocks.m4.wall;
    expect(heardAt).toBe(quietAt + 10.5 * MINUTE);
    f.cut.add(f.pair("m4", "m1"));
    // The fence on M4 counts from that lease too.
    expect(f.leaseRecord()?.fencedSince).toBeNull();
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 30 * MINUTE);
    expect(tookOverAt).toBe(heardAt + 15 * MINUTE);
    expect(f.interrupts[0]?.at).toBe(heardAt + 13 * MINUTE);
    expectNoTwoCoordinators(f);
  });

  it("an asymmetric partition: M4 still reaches M3 but not M1", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    const quietAt = f.clocks.m4.wall;
    f.cut.add(f.pair("m4", "m1"));
    // Until M1 claims the epoch, M4 keeps steering its worker on M3.
    await f.run(12 * MINUTE);
    expect(f.steersM3("m4")).toBe(true);
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 10 * MINUTE);
    expect(tookOverAt).toBe(quietAt + 15 * MINUTE);
    // M4 can still reach M3, but M3 refuses its steering from the claim on.
    expect(f.claims).toEqual([{ by: "m1", epoch: 1, accepted: true }]);
    expect(f.steersM3("m4")).toBe(false);
    expect(f.steersM3("m1")).toBe(true);
    // M4 stays fenced as long as it cannot reach M1; it never ran beside M1.
    await f.run(30 * MINUTE);
    expect(f.binding("m4").state).toBe("active");
    expect(await f.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    expectNoTwoCoordinators(f);
  });

  it("a coordinator turn running at the takeover was already stopped", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    startTurn(f, "long-turn");
    await f.step();
    // M1 learns of the running turn from M4's lease, for its takeover notice.
    expect(f.standbyRecord()?.runningThreads).toEqual([
      { threadId: f.members.m4.coordinatorThreadId, title: "Coordinator" },
    ]);
    f.cut.add(f.pair("m4", "m1"));
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 30 * MINUTE);
    // The turn was interrupted on M4 before M1 could take over, and stays stopped.
    expect(f.interrupts).toHaveLength(1);
    expect(f.interrupts[0]!.at).toBeLessThan(tookOverAt!);
    expect(f.running.size).toBe(0);
    // A new turn on M4 is refused while it cannot check with M1.
    expect(await f.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    expectNoTwoCoordinators(f);
  });

  it("a lease that lands during the takeover either resets the clock or hears of it", async () => {
    // The lease wins the lock: the takeover re-reads the clock and stands down.
    const leaseFirst = await fleet();
    await leaseFirst.run(MINUTE);
    leaseFirst.cut.add(leaseFirst.pair("m4", "m1"));
    await leaseFirst.run(14.5 * MINUTE);
    expect(leaseFirst.takeovers).toEqual([]);
    for (const name of NAMES) {
      leaseFirst.clocks[name].wall += TICK;
      leaseFirst.clocks[name].mono += TICK;
    }
    leaseFirst.cut.clear();
    await leaseFirst.on4(leaseFirst.lease.tick);
    const notDue = await leaseFirst.link1((service) =>
      service.autoTakeover({ logicalProjectId: leaseFirst.logicalProjectId }),
    );
    expect(notDue).toMatchObject({ outcome: "not-due", reason: "waiting" });
    expect(leaseFirst.binding("m1").state).toBe("transferred");

    // The takeover wins the lock: the lease that follows is answered with it.
    const takeoverFirst = await fleet();
    await takeoverFirst.run(MINUTE);
    takeoverFirst.cut.add(takeoverFirst.pair("m4", "m1"));
    await takeoverFirst.run(14.5 * MINUTE);
    for (const name of NAMES) {
      takeoverFirst.clocks[name].wall += TICK;
      takeoverFirst.clocks[name].mono += TICK;
    }
    takeoverFirst.cut.clear();
    const taken = await takeoverFirst.link1((service) =>
      service.autoTakeover({ logicalProjectId: takeoverFirst.logicalProjectId }),
    );
    expect(taken.outcome).toBe("taken-over");
    await takeoverFirst.on4(takeoverFirst.lease.tick);
    expect(takeoverFirst.binding("m4")).toMatchObject({ state: "transferred", epoch: 1 });

    // Both at once on M1's one lock: exactly one of the two outcomes.
    const racing = await fleet();
    await racing.run(MINUTE);
    racing.cut.add(racing.pair("m4", "m1"));
    await racing.run(14.5 * MINUTE);
    for (const name of NAMES) {
      racing.clocks[name].wall += TICK;
      racing.clocks[name].mono += TICK;
    }
    racing.cut.clear();
    const [, outcome] = await Promise.all([
      racing.on4(racing.lease.tick),
      racing.link1((service) =>
        service.autoTakeover({ logicalProjectId: racing.logicalProjectId }),
      ),
    ]);
    // The tick above may have run before the takeover committed; the next one settles it.
    await racing.on4(racing.lease.tick);
    if (outcome.outcome === "taken-over") {
      expect(racing.binding("m1")).toMatchObject({ state: "active", epoch: 1 });
      expect(racing.binding("m4")).toMatchObject({ state: "transferred", epoch: 1 });
    } else {
      expect(outcome).toMatchObject({ outcome: "not-due" });
      expect(racing.binding("m1").state).toBe("transferred");
      expect(racing.binding("m4")).toMatchObject({ state: "active", epoch: 0 });
    }
    for (const f of [leaseFirst, takeoverFirst, racing]) expectNoTwoCoordinators(f);
  });

  it("nothing moves once the standby was turned off, or the coordinator handed to M3", async () => {
    // Turned off: the release reaches M1 before the change is written (AC-04).
    const off = await fleet();
    await off.run(MINUTE);
    await off.on4(
      off.lease.releaseBefore({
        projectId: off.members.m4.projectId,
        changeAnyway: false,
        reason: "standby-off",
      }),
    );
    await off.link4((service) =>
      service.setStandby({
        operationId: standbyOff,
        projectId: off.members.m4.projectId,
        standby: null,
      }),
    );
    expect(off.standbyRecord()).toBeUndefined();
    off.awake.m4 = false;
    await off.run(60 * MINUTE);
    expect(off.takeovers).toEqual([]);
    expect(off.binding("m1").state).toBe("transferred");
    off.awake.m4 = true;
    // No standby, no fence.
    expect(await off.gateM4()).toBeNull();

    // Handed to M3 by hand: M3 takes over, M4 releases M1, then gives way to M3.
    const handed = await fleet();
    await handed.run(MINUTE);
    const m3Took = await handed.link3((service) =>
      service.takeover({
        operationId: handToM3,
        projectId: handed.members.m3.projectId,
        knownEpoch: 0,
        predecessor: handed.members.m4,
      }),
    );
    await handed.on4(
      handed.lease.releaseBefore({
        projectId: handed.members.m4.projectId,
        unless: handed.members.m3,
        changeAnyway: false,
        reason: "supersede",
      }),
    );
    await handed.link4((service) =>
      service.supersede({
        projectId: handed.members.m4.projectId,
        logicalProjectId: handed.logicalProjectId,
        successor: handed.members.m3,
        coordinatorBinding: m3Took.coordinatorBinding,
      }),
    );
    expect(handed.standbyRecord()).toBeUndefined();
    expect(handed.binding("m4")).toMatchObject({ state: "transferred", epoch: 1 });
    handed.awake.m4 = false;
    await handed.run(60 * MINUTE);
    // M1 never takes over from a coordinator that already handed off.
    expect(handed.takeovers).toEqual([]);
    expect(
      await handed.link1((service) =>
        service.autoTakeover({ logicalProjectId: handed.logicalProjectId }),
      ),
    ).toEqual({ outcome: "disarmed" });
    expect(handed.binding("m1").state).toBe("transferred");
    expectNoTwoCoordinators(off);
    expectNoTwoCoordinators(handed);
  });

  it("a standby that slept through the silence, or whose clock jumped, never fires", async () => {
    // Both machines sleep: nothing moves (D-04).
    const slept = await fleet();
    await slept.run(MINUTE);
    slept.awake.m4 = false;
    await slept.run(MINUTE);
    slept.awake.m1 = false;
    await slept.run(40 * MINUTE);
    slept.awake.m1 = true;
    await slept.run(30 * MINUTE);
    expect(slept.takeovers).toEqual([]);
    expect(slept.standbyRecord()).toMatchObject({ leaseSinceWatching: false });
    // M4 wakes fenced, and one answered lease lifts it.
    slept.awake.m4 = true;
    expect(await slept.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    await slept.step();
    expect(await slept.gateM4()).toBeNull();
    expect(slept.binding("m4")).toMatchObject({ state: "active", epoch: 0 });

    // M1's wall clock steps 20 minutes ahead while M4 is out of reach.
    const ahead = await fleet();
    await ahead.run(MINUTE);
    ahead.cut.add(ahead.pair("m4", "m1"));
    await ahead.run(5 * MINUTE);
    ahead.clocks.m1.wall += 20 * MINUTE;
    await ahead.run(60 * MINUTE);
    expect(ahead.takeovers).toEqual([]);

    // And backwards: a lease from before the step cannot count.
    const behind = await fleet();
    await behind.run(MINUTE);
    behind.cut.add(behind.pair("m4", "m1"));
    await behind.run(5 * MINUTE);
    behind.clocks.m1.wall -= 60 * MINUTE;
    await behind.run(90 * MINUTE);
    expect(behind.takeovers).toEqual([]);
    for (const f of [slept, ahead, behind]) expectNoTwoCoordinators(f);
  });

  it("with two machines holding handoff copies, only the standby continues the thread", async () => {
    const f = await fleet();
    const project = f.machines.m4.projects.get(f.members.m4.projectId)!;
    const thread = ThreadId.make("thread:fix-build");
    const config = { sleepTarget: null, autoTakeoverMinutes: 1 };
    const minutes = autoContinueMinutes(config);
    // The delay is clamped to five minutes, and only M1, the standby, is named.
    expect(minutes).toBe(5);
    const designated = designatedMachine({
      config,
      project,
      threadId: thread,
      self: f.members.m4.environmentId,
    });
    expect(designated).toBe("m1");
    // The coordinator thread never moves this way.
    expect(
      designatedMachine({
        config,
        project,
        threadId: f.members.m4.coordinatorThreadId,
        self: f.members.m4.environmentId,
      }),
    ).toBeNull();

    // M4's heartbeat to each machine holding a copy, as HandoffMoves builds it.
    const heartbeatTo = (peer: string) => ({
      sourceEnvironmentId: "m4",
      leases: [
        {
          sourceThreadId: thread,
          epoch: 1,
          ...(peer === designated ? { autoContinueMinutes: minutes! } : {}),
        },
      ],
    });
    const copyOn = (projectId: string) => {
      const replica = {
        sourceEnvironmentId: "m4",
        sourceLabel: "M4",
        sourceThreadId: thread,
        projectId,
        title: "Fix the build",
        checkpoint: { sequence: 3, runEnding: "active" },
        lease: { holderEnvironmentId: "m4", epoch: 1, renewedAt: iso(T0), state: "active" },
        sourceLastSeenAt: iso(T0),
        sourceUnreachable: false,
        receivedAt: iso(T0),
        continuedThreadId: null,
      } as unknown as HandoffIncomingReplica;
      return {
        ...EMPTY_HANDOFF_DOCUMENT,
        incoming: [replica],
        incomingDetails: {
          [incomingKey("m4", thread)]: {
            sourceProjectId: f.members.m4.projectId,
            autoContinueMinutes: null,
          } as unknown as HandoffIncomingDetail,
        },
      };
    };
    const heardAt = T0 + MINUTE;
    const [, onM1] = heartbeatContinued(
      copyOn(f.members.m1.projectId),
      heartbeatTo("m1"),
      iso(heardAt),
    );
    const [, onM3] = heartbeatContinued(
      copyOn(f.members.m3.projectId),
      heartbeatTo("m3"),
      iso(heardAt),
    );
    const due = (document: typeof onM1, nowMs: number) =>
      autoContinueCandidates(document, { nowMs, watchingSinceMs: T0, projectOf: () => null });
    expect(due(onM1, heardAt + 5 * MINUTE - 1)).toEqual([]);
    expect(due(onM1, heardAt + 5 * MINUTE)).toEqual([
      { sourceEnvironmentId: "m4", sourceThreadId: thread },
    ]);
    // M3 holds a copy too, but was never named: it waits however long M4 is quiet.
    expect(due(onM3, heardAt + 24 * 60 * MINUTE)).toEqual([]);
    // M4 fences its own copy 130 seconds before M1 may continue it.
    const announced = noteAnnounced({}, "m1", minutes!, iso(heardAt));
    expect(peerPastFence(announced.m1, heardAt + 5 * MINUTE - 130_000 - 1)).toBe(false);
    expect(peerPastFence(announced.m1, heardAt + 5 * MINUTE - 130_000)).toBe(true);
  });

  it("M4 restarting during a partition keeps counting from its last confirmed lease", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    const confirmedAt = f.clocks.m4.wall;
    f.cut.add(f.pair("m4", "m1"));
    await f.run(5 * MINUTE);
    // A restart is no fresh start: the fence still comes 130 seconds before M1 may act.
    await f.restartM4();
    const fencedAt = await f.runUntil(() => f.leaseRecord()?.fencedSince != null, 15 * MINUTE);
    expect(fencedAt).toBe(confirmedAt + 13 * MINUTE);
    // Restarting again while fenced keeps the fence, and starts no turn.
    await f.restartM4();
    expect(await f.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 5 * MINUTE);
    expect(tookOverAt).toBe(confirmedAt + 15 * MINUTE);
    await f.restartM4();
    expect(await f.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    f.cut.clear();
    await f.step();
    expect(f.binding("m4")).toMatchObject({ state: "transferred", epoch: 1 });
    expectNoTwoCoordinators(f);
  });

  it("an M4 service update announces a pause, and M1 waits it out", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    // The update holds M4 for 20 minutes; the lease says so.
    f.state.plannedPauseUntil = f.clocks.m4.wall + 20 * MINUTE;
    await f.step();
    const pausedAt = f.clocks.m4.wall;
    expect(f.sent.at(-1)).toMatchObject({ kind: "pause" });
    expect(Date.parse(f.standbyRecord()!.pausedUntil!)).toBe(pausedAt - TICK + 20 * MINUTE);
    // M4 goes down for the update and does not come back.
    f.awake.m4 = false;
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 60 * MINUTE);
    // Not 15 minutes after the last lease, but 15 after the announced pause ended.
    expect(tookOverAt).toBe(pausedAt - TICK + 35 * MINUTE);

    // An update that comes back in time moves nothing; a pause is capped at 30 minutes.
    const back = await fleet();
    await back.run(MINUTE);
    back.state.plannedPauseUntil = back.clocks.m4.wall + 4 * 60 * MINUTE;
    await back.step();
    const cappedAt = back.clocks.m4.wall;
    expect(Date.parse(back.standbyRecord()!.pausedUntil!)).toBe(cappedAt + 30 * MINUTE);
    back.awake.m4 = false;
    await back.run(25 * MINUTE);
    back.awake.m4 = true;
    back.state.plannedPauseUntil = null;
    // Back up, M4 is fenced until one lease comes back, then runs again.
    expect(await back.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    await back.step();
    expect(await back.gateM4()).toBeNull();
    await back.run(60 * MINUTE);
    expect(back.takeovers).toEqual([]);
    // Sleep is announced the same way.
    expect(await back.pause({ sleeping: true })).toBe(1);
    expect(back.standbyRecord()?.coordinatorSleptAt).not.toBeNull();
    expectNoTwoCoordinators(f);
    expectNoTwoCoordinators(back);
  });

  it("M1 revoking M4's grant disarms it; M4 fences until the owner runs it anyway", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    f.revokedOnM1.add("m4");
    await f.step();
    // M1 stops standing by at once: it never takes over for a coordinator it refused.
    expect(f.standbyRecord()).toBeUndefined();
    expect(f.leaseRecord()?.lastError).toContain("revoked");
    // A refused grant is no answer, so M4 counts it as silence and fences.
    await f.run(30 * MINUTE);
    expect(f.takeovers).toEqual([]);
    expect(await f.gateM4()).toBe(COORDINATOR_FENCE_REFUSAL);
    // Run here anyway turns automatic takeover off with a release still owed.
    await f.on4(
      f.lease.releaseBefore({
        projectId: f.members.m4.projectId,
        changeAnyway: true,
        reason: "run-here-anyway",
      }),
    );
    await f.link4((service) =>
      service.setStandby({
        operationId: standbyOff,
        projectId: f.members.m4.projectId,
        standby: null,
      }),
    );
    expect(await f.gateM4()).toBeNull();
    expect(f.leaseRecord()?.pendingReleases).toHaveLength(1);
    expect(f.binding("m4")).toMatchObject({ state: "active", epoch: 0 });
    expectNoTwoCoordinators(f);
  });

  it("an inflated lease epoch, or a lease from another machine, does not hold M1 back", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    const quietAt = f.clocks.m4.wall;
    const valid = f.sent.at(-1)!;
    f.cut.add(f.pair("m4", "m1"));
    await f.run(5 * MINUTE);
    const forged = async (caller: ReceiverCaller, patch: Partial<CoordinatorLeaseRequest>) => {
      const exit = await f.receiver1((receiver) =>
        receiver.lease(caller, leaseWire({ ...valid, ...patch })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    };
    // M4's own grant at an epoch it does not hold.
    await forged(f.m4OnM1, { epoch: 7, seq: valid.seq + 1_000 });
    expect(f.standbyRecord()?.lastRefusal?.reason).toBe("wrong-epoch");
    // M3, which holds a grant on M1 for this project too, is not the registered coordinator.
    await forged(callerFrom("m3", { kind: "listed", projectIds: [f.members.m1.projectId] }), {
      seq: valid.seq + 2_000,
    });
    expect(f.standbyRecord()?.lastRefusal?.reason).toBe("not-registered-coordinator");
    expect(Date.parse(f.standbyRecord()!.lastLeaseAt!)).toBe(quietAt);
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 30 * MINUTE);
    expect(tookOverAt).toBe(quietAt + 15 * MINUTE);
    // The epoch M1 took over at is its own, not the inflated one.
    expect(f.binding("m1").epoch).toBe(1);
    expectNoTwoCoordinators(f);
  });

  it("a replayed lease is ignored and does not reset the clock", async () => {
    const f = await fleet();
    await f.run(MINUTE);
    const quietAt = f.clocks.m4.wall;
    const captured = f.sent.at(-1)!;
    const earlier = f.sent.at(-2)!;
    f.cut.add(f.pair("m4", "m1"));
    await f.run(10 * MINUTE);
    for (const replay of [captured, earlier]) {
      const exit = await f.receiver1((receiver) => receiver.lease(f.m4OnM1, leaseWire(replay)));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(f.standbyRecord()?.lastRefusal?.reason).toBe("stale-seq");
    }
    expect(f.standbyRecord()).toMatchObject({ lastSeq: captured.seq });
    expect(Date.parse(f.standbyRecord()!.lastLeaseAt!)).toBe(quietAt);
    const tookOverAt = await f.runUntil(() => f.takeovers.length > 0, 30 * MINUTE);
    expect(tookOverAt).toBe(quietAt + 15 * MINUTE);
    expectNoTwoCoordinators(f);
  });
});
