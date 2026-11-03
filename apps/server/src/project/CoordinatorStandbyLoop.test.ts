/**
 * The standby loop as the server wires it (CoordinatorStandbyLoop.layer):
 * the real layer over the real ProjectLink, standby watch, takeover and lease
 * receiver of M3, armed as M4's standby. Peers are the receiver itself (M4's
 * leases arrive as the route hands them over) and a fake worker adoption;
 * time is the test clock and a monotonic clock moved with it.
 */
import { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioWorkGrantProjects } from "@specweave-studio/contracts/studioFleet";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  type AdoptWorkersInput,
  type AdoptWorkersResult,
  RemoteWorkerAdoption,
} from "../fleet/RemoteWorkerAdoption.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  COORDINATOR_LEASE_PROTOCOL_VERSION,
  type CoordinatorLeaseRequest,
} from "../handoff/handoffWire.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as CoordinatorLeaseRoute from "./CoordinatorLeaseRoute.ts";
import { CoordinatorRole, type CoordinatorRoleChange } from "./CoordinatorRole.ts";
import * as CoordinatorStandbyLoop from "./CoordinatorStandbyLoop.ts";
import type { CoordinatorStandbyRecord } from "./CoordinatorStandbyStore.ts";
import { STANDBY_TICK_MS } from "./CoordinatorStandbyWatch.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import { legacyPair, link, removeCheckouts } from "./ProjectLink.testkit.ts";
import { autoTakeoverOperationId } from "./ProjectLinkStandby.ts";

afterEach(removeCheckouts);

const MINUTE = 60_000;
const standbyId = "55555555-5555-4555-8555-555555555555";

/** M4 coordinates; its M3 copy accepted it as the standby after 15 minutes. */
const armed = async () => {
  const pair = legacyPair();
  const { prepared } = await link(pair);
  const logicalProjectId = prepared.logicalProject.id;
  await pair.m4.run((service) =>
    service.setStandby({
      operationId: standbyId,
      projectId: pair.kept.projectId,
      standby: { member: pair.joining, afterMinutes: 15 },
    }),
  );
  await pair.m3.run((service) =>
    service.acceptStandby({
      projectId: pair.joining.projectId,
      logicalProjectId,
      standby: { coordinator: pair.kept, epoch: 0, afterMinutes: 15 },
    }),
  );
  return { pair, logicalProjectId };
};

const m4Caller = (projectIds: ReadonlyArray<string>): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make("m4"),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make("m4"),
    projects: { kind: "listed", projectIds } as StudioWorkGrantProjects,
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

/** A service update hold the test turns on and off. */
const holdLayer = (state: { held: boolean }) =>
  Layer.succeed(ServiceUpdateHold.ServiceUpdateHold, {
    isHeld: Effect.sync(() => state.held),
    awaitReleased: Effect.void,
    current: Effect.succeedNone,
    installGated: Effect.succeed(false),
    recordRefusal: () => Effect.void,
    withAdmission: (_action: string, effect: Effect.Effect<unknown>) => effect,
  } as unknown as ServiceUpdateHold.ServiceUpdateHold["Service"]);

/**
 * Builds M3's server with the production standby loop; returns how to step
 * time, send M4's lease, and read M3's binding and the follow-ups asked for.
 */
const start = (options: {
  readonly unclaimed?: Array<ReadonlyArray<string>>;
  readonly hold?: { held: boolean };
}) =>
  Effect.gen(function* () {
    const { pair, logicalProjectId } = yield* Effect.promise(armed);
    const clock = { mono: 0 };
    const adoptions: Array<AdoptWorkersInput> = [];
    const adoption = Layer.succeed(
      RemoteWorkerAdoption,
      RemoteWorkerAdoption.of({
        adopt: (input) =>
          Effect.sync((): AdoptWorkersResult => {
            adoptions.push(input);
            return {
              adopted: [],
              readOnly: [],
              waitingForPredecessor: 0,
              unclaimed: options.unclaimed?.shift() ?? [],
            };
          }),
      }),
    );
    const server = Layer.mergeAll(CoordinatorLeaseRoute.layer, ProjectAdmission.layer).pipe(
      Layer.provideMerge(pair.m3.layer),
    );
    const loop = CoordinatorStandbyLoop.layerWith({ monotonic: { nowMs: () => clock.mono } }).pipe(
      Layer.provide(adoption),
    );
    const context = yield* Layer.build(
      options.hold === undefined
        ? loop.pipe(Layer.provideMerge(server))
        : loop.pipe(Layer.provideMerge(server), Layer.provide(holdLayer(options.hold))),
    );
    const settle = Effect.gen(function* () {
      for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
    });
    /** The coordinator role changes M3 publishes. */
    const roles: Array<CoordinatorRoleChange> = [];
    yield* Effect.flatMap(CoordinatorRole, (role) =>
      Stream.runForEach(role.changes, (change) => Effect.sync(() => roles.push(change))),
    ).pipe(Effect.provideContext(context), Effect.forkScoped);
    yield* settle;

    let seq = 0;
    const lease = Effect.gen(function* () {
      seq += 1;
      const receiver = yield* CoordinatorLeaseRoute.CoordinatorLeaseReceiver;
      const request: CoordinatorLeaseRequest = {
        protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
        kind: "lease",
        logicalProjectId,
        epoch: 0,
        seq,
        afterMinutes: 15,
        contentDigest: "digest",
        runningThreads: [],
        workers: [],
      };
      return yield* receiver.lease(m4Caller([pair.joining.projectId]), request);
    }).pipe(Effect.provideContext(context));
    /** One 30-second step on both clocks, with the loop's round run. */
    const step = Effect.gen(function* () {
      clock.mono += STANDBY_TICK_MS;
      yield* TestClock.adjust(Duration.millis(STANDBY_TICK_MS));
      yield* settle;
    });
    const binding = () =>
      pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings!.coordinatorBinding!;
    /** Steps until M3 coordinates, at most `ms`; the elapsed time, or null. */
    const stepsUntilActive = (ms: number) =>
      Effect.gen(function* () {
        for (let elapsed = STANDBY_TICK_MS; elapsed <= ms; elapsed += STANDBY_TICK_MS) {
          yield* step;
          if (binding().state === "active") return elapsed;
        }
        return null;
      });
    return { pair, logicalProjectId, adoptions, roles, lease, step, binding, stepsUntilActive };
  });

describe("the standby loop the server runs", () => {
  it.effect("fires after afterMinutes of silence, and never while leases arrive", () =>
    Effect.gen(function* () {
      const f = yield* start({});
      // An hour of leases every 30 seconds: M3 stays the standby.
      for (let elapsed = 0; elapsed < 60 * MINUTE; elapsed += STANDBY_TICK_MS) {
        yield* f.lease;
        yield* f.step;
      }
      expect(f.binding().state).toBe("transferred");
      expect(f.adoptions).toEqual([]);

      // M4 goes quiet after one more lease; 15 minutes later M3 takes over.
      yield* f.lease;
      const firedAfter = yield* f.stepsUntilActive(30 * MINUTE);
      expect(firedAfter).toBe(15 * MINUTE);
      expect(f.binding()).toMatchObject({
        state: "active",
        epoch: 1,
        takenOverBy: "auto",
        predecessor: { environmentId: "m4" },
        operationId: autoTakeoverOperationId(f.logicalProjectId, 1),
      });
      // Other server code hears of it.
      expect(f.roles.filter((change) => change.kind === "took-over")).toMatchObject([
        { epoch: 1, takenOverBy: "auto", predecessor: { environmentId: "m4" } },
      ]);
      // Then it claims the epoch and adopts M4's workers, once.
      expect(f.adoptions).toHaveLength(1);
      expect(f.adoptions[0]).toMatchObject({
        logicalProjectId: f.logicalProjectId,
        epoch: 1,
        projectId: f.pair.joining.projectId,
        coordinatorThreadId: f.pair.joining.coordinatorThreadId,
        predecessor: { environmentId: "m4" },
        claimOn: [],
      });
      for (let turn = 0; turn < 10; turn += 1) yield* f.step;
      expect(f.adoptions).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("tries an unanswered claim again on a later round, then stops", () =>
    Effect.gen(function* () {
      const f = yield* start({ unclaimed: [["m9"], ["m9"]] });
      yield* f.lease;
      expect(yield* f.stepsUntilActive(30 * MINUTE)).toBe(15 * MINUTE);
      expect(f.adoptions).toHaveLength(1);
      // Backoff: 30 seconds after the first miss, then 60 after the second.
      yield* f.step;
      expect(f.adoptions).toHaveLength(2);
      yield* f.step;
      expect(f.adoptions).toHaveLength(2);
      yield* f.step;
      expect(f.adoptions).toHaveLength(3);
      // Every machine answered: nothing more is owed.
      for (let turn = 0; turn < 20; turn += 1) yield* f.step;
      expect(f.adoptions).toHaveLength(3);
      expect(new Set(f.adoptions.map((input) => input.epoch))).toEqual(new Set([1]));
    }).pipe(Effect.scoped),
  );

  it.effect("waits while a service update holds this machine, then counts from its end", () =>
    Effect.gen(function* () {
      const hold = { held: true };
      const f = yield* start({ hold });
      yield* f.lease;
      // While held, M4's leases are answered busy and M4 stays unfenced.
      for (let elapsed = 0; elapsed < 30 * MINUTE; elapsed += STANDBY_TICK_MS) yield* f.step;
      expect(f.binding().state).toBe("transferred");
      // The hold ends without a restart: the silence before it never counts, but
      // a coordinator that died during it is still taken over, 15 minutes on.
      hold.held = false;
      expect(yield* f.stepsUntilActive(30 * MINUTE)).toBe(15 * MINUTE + STANDBY_TICK_MS);
      expect(f.binding()).toMatchObject({ state: "active", epoch: 1 });
      expect(f.adoptions).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("after a hold, a lease that arrives keeps it the standby", () =>
    Effect.gen(function* () {
      const hold = { held: true };
      const f = yield* start({ hold });
      yield* f.lease;
      for (let elapsed = 0; elapsed < 30 * MINUTE; elapsed += STANDBY_TICK_MS) yield* f.step;
      hold.held = false;
      for (let elapsed = 0; elapsed < 60 * MINUTE; elapsed += STANDBY_TICK_MS) {
        yield* f.lease;
        yield* f.step;
      }
      expect(f.binding().state).toBe("transferred");
      expect(f.adoptions).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("fire preflight for a standby a peer armed", () => {
  const record = (armedBy?: { kind: "owner" | "peer"; chainId?: string }) =>
    ({
      logicalProjectId: "logical:easychamp",
      projectId: "easychamp-m3",
      coordinator: {
        environmentId: EnvironmentId.make("m1"),
        projectId: "easychamp-m1",
        coordinatorThreadId: "project-coordinator:easychamp-m1",
      },
      epoch: 3,
      acceptedAt: "2026-11-03T10:00:00.000Z",
      shadowWorkers: [],
      ...(armedBy === undefined ? {} : { armedBy }),
    }) as unknown as CoordinatorStandbyRecord;

  const roundWith = (due: CoordinatorStandbyRecord, knownHigherEpoch: number | undefined) => {
    const asked: Array<string> = [];
    const inputs: Array<{ readonly knownHigherEpoch?: number | undefined }> = [];
    const standby = CoordinatorStandbyLoop.makeStandbyTakeover({
      watch: {
        tick: Effect.succeed({ restarted: false, due: [due] }),
        resumeAfterHold: Effect.void,
      },
      store: { list: Effect.succeed([due]) },
      autoTakeover: (input) => {
        inputs.push(input);
        return Effect.succeed({ outcome: "disarmed" } as const);
      },
      selfEnvironmentId: "m3",
      followUp: () => Effect.succeed({ unclaimed: [] }),
      held: Effect.succeed(false),
      preflight: (checked) => {
        asked.push(checked.logicalProjectId);
        return Effect.succeed(knownHigherEpoch === undefined ? {} : { knownHigherEpoch });
      },
    });
    return Effect.runPromise(standby.round).then(() => ({ asked, inputs }));
  };

  it("passes a newer coordinator another member reports to the takeover", async () => {
    const { asked, inputs } = await roundWith(record({ kind: "peer", chainId: "c" }), 4);
    expect(asked).toEqual(["logical:easychamp"]);
    expect(inputs).toEqual([{ logicalProjectId: "logical:easychamp", knownHigherEpoch: 4 }]);
  });

  it("fires as before when no member answers", async () => {
    const { inputs } = await roundWith(record({ kind: "peer", chainId: "c" }), undefined);
    expect(inputs).toEqual([{ logicalProjectId: "logical:easychamp" }]);
  });

  it("asks nobody for a standby the owner armed", async () => {
    for (const armedBy of [undefined, { kind: "owner" as const }]) {
      const { asked, inputs } = await roundWith(record(armedBy), 9);
      expect(asked).toEqual([]);
      expect(inputs).toEqual([{ logicalProjectId: "logical:easychamp" }]);
    }
  });
});
