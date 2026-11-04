import {
  EnvironmentId,
  type LogicalProjectMember,
  type Project,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import type { CoordinatorLeaseResponse } from "../handoff/handoffWire.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import { makeCoordinatorLease } from "./CoordinatorLease.ts";
import {
  type CoordinatorLeaseRecord,
  CoordinatorLeaseStoreError,
  emptyLeaseRecord,
  makeMemory,
} from "./CoordinatorLeaseStore.ts";
import {
  COORDINATOR_FENCE_MARGIN_MS,
  COORDINATOR_FENCE_REFUSAL,
  COORDINATOR_FENCE_UNREADABLE_REFUSAL,
  COORDINATOR_SUPERSEDED_REFUSAL,
  coordinatorFenced,
  fenceAt,
  CoordinatorWakeGate,
  layer as CoordinatorWakeGateLayer,
  makeCheck,
  makeFenceSweep,
} from "./CoordinatorWakeGate.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

const member = (environment: string, project: string): LogicalProjectMember => ({
  environmentId: EnvironmentId.make(environment),
  projectId: ProjectId.make(project),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${project}`),
});
const m4 = member("m4", "easychamp-m4");
const m1 = member("m1", "easychamp-m1");

const record = (overrides: Partial<CoordinatorLeaseRecord> = {}): CoordinatorLeaseRecord => ({
  ...emptyLeaseRecord("easychamp-m4", "logical:easychamp", iso(T0)),
  target: { standby: m1, epoch: 3, afterMinutes: 15, enabledAt: iso(T0 - 60 * MINUTE) },
  lastSuccessfulLeaseAt: iso(T0),
  ...overrides,
});

describe("coordinatorFenced", () => {
  it("fences 130 seconds before the standby could fire, never earlier", () => {
    expect(COORDINATOR_FENCE_MARGIN_MS).toBe(130_000);
    const due = T0 + 15 * MINUTE - 130_000;
    expect(fenceAt(record())).toBe(due);
    expect(coordinatorFenced(record(), due - 1)).toBe(false);
    expect(coordinatorFenced(record(), due)).toBe(true);
    // Each of the four delays keeps the same margin.
    for (const afterMinutes of [5, 15, 30, 60] as const) {
      const target = { ...record().target!, afterMinutes };
      expect(fenceAt(record({ target }))).toBe(T0 + afterMinutes * MINUTE - 130_000);
    }
  });

  it("counts a standby never heard from since it was turned on", () => {
    const never = record({ lastSuccessfulLeaseAt: null });
    expect(fenceAt(never)).toBe(T0 - 60 * MINUTE + 15 * MINUTE - 130_000);
    expect(coordinatorFenced(never, T0)).toBe(true);
  });

  it("is not silence when the standby is updating, and never applies without a standby", () => {
    const busy = record({ lastPausedAnswerAt: iso(T0 + 10 * MINUTE) });
    expect(coordinatorFenced(busy, T0 + 20 * MINUTE)).toBe(false);
    expect(coordinatorFenced(busy, T0 + 25 * MINUTE - 130_000)).toBe(true);
    expect(coordinatorFenced(record({ target: null }), T0 + 600 * MINUTE)).toBe(false);
    // The standby said it does not stand by here: it cannot take over, so nothing fences.
    const missing = record({ standbyMissingAt: iso(T0 + MINUTE) });
    expect(fenceAt(missing)).toBeNull();
    expect(coordinatorFenced(missing, T0 + 600 * MINUTE)).toBe(false);
  });

  it("keeps a raised fence until it is cleared, whatever answers come in between", () => {
    const raised = record({
      fencedSince: iso(T0 + 13 * MINUTE),
      lastPausedAnswerAt: iso(T0 + 14 * MINUTE),
    });
    expect(coordinatorFenced(raised, T0 + 14 * MINUTE)).toBe(true);
    expect(coordinatorFenced({ ...raised, target: null }, T0 + 14 * MINUTE)).toBe(false);
  });
});

describe("CoordinatorWakeGate check", () => {
  it("refuses only the fenced copy's coordinator thread", async () => {
    const { records, service } = makeMemory();
    const check = makeCheck(service);
    const run = (threadId: string) => Effect.runPromise(check(ThreadId.make(threadId)));
    // Nothing recorded: every turn starts.
    expect(await run("project-coordinator:easychamp-m4")).toBeNull();

    records.set(
      "easychamp-m4",
      record({ coordinatorThreadId: "thread-named", lastSuccessfulLeaseAt: iso(nowMs()) }),
    );
    expect(await run("project-coordinator:easychamp-m4")).toBeNull();

    records.set(
      "easychamp-m4",
      record({
        coordinatorThreadId: "thread-named",
        lastSuccessfulLeaseAt: iso(nowMs() - 20 * MINUTE),
      }),
    );
    expect(await run("project-coordinator:easychamp-m4")).toBe(COORDINATOR_FENCE_REFUSAL);
    expect(await run("thread-named")).toBe(COORDINATOR_FENCE_REFUSAL);
    // Workers and other threads keep running.
    expect(await run("thread-worker")).toBeNull();
    expect(await run("project-coordinator:another")).toBeNull();
  });

  it.effect("refuses a coordinator another copy took over from, with no standby set", () =>
    Effect.gen(function* () {
      const { service } = makeMemory();
      const state = yield* LinkedPeerSyncState.make;
      const check = makeCheck(service, state.supersededFor);
      const run = (threadId: string) => check(ThreadId.make(threadId));
      expect(yield* run("project-coordinator:easychamp-m4")).toBeNull();

      // M1's digest showed it took over from this copy at epoch 1; this copy has not given way.
      yield* state.markSuperseded({
        projectId: ProjectId.make("easychamp-m4"),
        coordinatorThreadId: "thread-named",
        epoch: 1,
        successorEnvironmentId: m1.environmentId,
      });
      expect(yield* run("project-coordinator:easychamp-m4")).toBe(COORDINATOR_SUPERSEDED_REFUSAL);
      expect(yield* run("thread-named")).toBe(COORDINATOR_SUPERSEDED_REFUSAL);
      // Only the coordinator: workers and other projects keep running.
      expect(yield* run("thread-worker")).toBeNull();
      expect(yield* run("project-coordinator:another")).toBeNull();

      // Another machine never lifts what M1 raised; once given way, turns start again.
      yield* state.clearSuperseded(ProjectId.make("easychamp-m4"), EnvironmentId.make("m3"));
      expect(yield* run("thread-named")).toBe(COORDINATOR_SUPERSEDED_REFUSAL);
      yield* state.clearSuperseded(ProjectId.make("easychamp-m4"));
      expect(yield* run("thread-named")).toBeNull();
    }),
  );

  // The gate and the sync loop must share one state: the production graph provides
  // LinkedPeerSyncState.layer beside a layer that provides it to the gate itself.
  it.effect("reads the sync state the runtime provides, built from the real layers", () =>
    Effect.gen(function* () {
      const state = yield* LinkedPeerSyncState.LinkedPeerSyncState;
      const gate = yield* CoordinatorWakeGate;
      const thread = ThreadId.make("project-coordinator:easychamp-m4");
      expect(yield* gate.check(thread)).toBeNull();
      yield* state.markSuperseded({
        projectId: ProjectId.make("easychamp-m4"),
        coordinatorThreadId: undefined,
        epoch: 1,
        successorEnvironmentId: m1.environmentId,
      });
      expect(yield* gate.check(thread)).toBe(COORDINATOR_SUPERSEDED_REFUSAL);
      yield* state.clearSuperseded(ProjectId.make("easychamp-m4"));
      expect(yield* gate.check(thread)).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          // As runtimeLayer: the gate nested inside another provided layer, the state beside it.
          Layer.effectDiscard(Effect.void).pipe(Layer.provideMerge(CoordinatorWakeGateLayer)),
          LinkedPeerSyncState.layer,
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "studio-wake-gate-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
  );

  it("fails closed from the last records read when they cannot be read again", async () => {
    const unreadable = Effect.fail(
      new CoordinatorLeaseStoreError({ operation: "read", cause: "disk" }),
    );
    const check = makeCheck({
      list: unreadable,
      get: () => Effect.undefined,
      modify: () => Effect.undefined,
    });
    const run = (threadId: string) => Effect.runPromise(check(ThreadId.make(threadId)));
    // Never read: nothing is known of a standby, so every turn starts.
    expect(await run("project-coordinator:easychamp-m4")).toBeNull();
    expect(await run("thread-worker")).toBeNull();

    // Read once, then unreadable: the last records read decide.
    const { records, service } = makeMemory();
    let broken = false;
    const flaky = makeCheck({
      ...service,
      list: Effect.suspend(() => (broken ? unreadable : service.list)),
    });
    const runFlaky = (threadId: string) => Effect.runPromise(flaky(ThreadId.make(threadId)));
    records.set(
      "easychamp-m4",
      record({ projectId: "easychamp-m4", lastSuccessfulLeaseAt: iso(nowMs() - 20 * MINUTE) }),
    );
    records.set(
      "easychamp-m3",
      record({ projectId: "easychamp-m3", lastSuccessfulLeaseAt: iso(nowMs()) }),
    );
    expect(await runFlaky("project-coordinator:easychamp-m3")).toBeNull();
    broken = true;
    expect(await runFlaky("project-coordinator:easychamp-m4")).toBe(
      COORDINATOR_FENCE_UNREADABLE_REFUSAL,
    );
    expect(await runFlaky("project-coordinator:easychamp-m3")).toBeNull();
    expect(await runFlaky("project-coordinator:another")).toBeNull();
  });
});

describe("fence on the monotonic clock", () => {
  it("raises the fence when the wall clock stood still or stepped back", async () => {
    const { records, service } = makeMemory();
    const mono = { now: 0 };
    const stopped: string[] = [];
    const project = { id: ProjectId.make("easychamp-m4") } as unknown as Project;
    const sweep = makeFenceSweep({
      store: service,
      monotonic: { nowMs: () => mono.now },
      loadProject: () => Effect.succeed(project),
      stopCoordinator: (stopping) =>
        Effect.sync(() => {
          stopped.push(stopping.id);
        }),
    });
    const heard = iso(nowMs());
    records.set("easychamp-m4", record({ lastSuccessfulLeaseAt: heard }));
    const run = () => Effect.runPromise(sweep([...records.values()]));
    await run();
    // 12 minutes pass on the monotonic clock while the wall clock barely moves.
    mono.now = 12 * MINUTE;
    await run();
    expect(records.get("easychamp-m4")?.fencedSince).toBeNull();
    mono.now = 15 * MINUTE - COORDINATOR_FENCE_MARGIN_MS;
    await run();
    expect(records.get("easychamp-m4")?.fencedSince).not.toBeNull();
    expect(stopped).toEqual(["easychamp-m4"]);
  });

  it("never fences a copy whose standby keeps answering while its clock is behind", async () => {
    const { records, service } = makeMemory();
    const mono = { now: 0 };
    const sweep = makeFenceSweep({
      store: service,
      monotonic: { nowMs: () => mono.now },
      loadProject: () => Effect.succeed(undefined),
      stopCoordinator: () => Effect.void,
    });
    // Turned on 20 minutes ahead of this copy's wall clock, which was stepped back.
    const enabledAt = iso(nowMs() + 20 * MINUTE);
    const target = { ...record().target!, enabledAt };
    for (let minute = 0; minute <= 30; minute += 1) {
      mono.now = minute * MINUTE;
      records.set(
        "easychamp-m4",
        record({ target, lastSuccessfulLeaseAt: iso(nowMs() - 30_000 + minute) }),
      );
      await Effect.runPromise(sweep([...records.values()]));
      expect(records.get("easychamp-m4")?.fencedSince).toBeNull();
    }
  });

  it("keeps measuring across a round whose records could not be read", async () => {
    const { records, service } = makeMemory();
    const mono = { now: 0 };
    const sweep = makeFenceSweep({
      store: service,
      monotonic: { nowMs: () => mono.now },
      loadProject: () => Effect.succeed(undefined),
      stopCoordinator: () => Effect.void,
    });
    records.set("easychamp-m4", record({ lastSuccessfulLeaseAt: iso(nowMs()) }));
    await Effect.runPromise(sweep([...records.values()]));
    mono.now = 5 * MINUTE;
    await Effect.runPromise(sweep([]));
    mono.now = 15 * MINUTE - COORDINATOR_FENCE_MARGIN_MS;
    await Effect.runPromise(sweep([...records.values()]));
    expect(records.get("easychamp-m4")?.fencedSince).not.toBeNull();
  });

  it("measures again from a new answer", async () => {
    const { records, service } = makeMemory();
    const mono = { now: 0 };
    const sweep = makeFenceSweep({
      store: service,
      monotonic: { nowMs: () => mono.now },
      loadProject: () => Effect.succeed(undefined),
      stopCoordinator: () => Effect.void,
    });
    records.set("easychamp-m4", record({ lastSuccessfulLeaseAt: iso(nowMs() - MINUTE) }));
    const run = () => Effect.runPromise(sweep([...records.values()]));
    await run();
    mono.now = 10 * MINUTE;
    records.set("easychamp-m4", record({ lastSuccessfulLeaseAt: iso(nowMs()) }));
    await run();
    mono.now = 20 * MINUTE;
    await run();
    expect(records.get("easychamp-m4")?.fencedSince).toBeNull();
    mono.now = 10 * MINUTE + 15 * MINUTE - COORDINATOR_FENCE_MARGIN_MS;
    await run();
    expect(records.get("easychamp-m4")?.fencedSince).not.toBeNull();
  });
});

describe("fence with the lease loop", () => {
  /** M4's copy with M1 armed as standby since 20 minutes ago, and a scripted M1. */
  const harness = () => {
    const enabledAt = iso(nowMs() - 20 * MINUTE);
    const project = {
      id: ProjectId.make("easychamp-m4"),
      deletedAt: null,
      workspaceSettings: {
        archived: false,
        logicalProject: { id: "logical:easychamp", members: [m4, m1] },
        coordinatorBinding: {
          epoch: 3,
          state: "active",
          standby: { member: m1, afterMinutes: 15, enabledAt },
        },
      },
    } as unknown as Project;
    const memory = makeMemory();
    const state = {
      answer: null as CoordinatorLeaseResponse | null,
      error: new HandoffPeerError({
        code: "unreachable",
        message: "M1 is asleep",
        uncertain: true,
      }),
      stopped: [] as string[],
    };
    const loop = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const admission = yield* ProjectAdmission.ProjectAdmission;
          const loadProject = () => Effect.succeed(project);
          const stopCoordinator = (stopping: Project) =>
            Effect.sync(() => {
              state.stopped.push(stopping.id);
            });
          return makeCoordinatorLease({
            store: memory.service,
            admission,
            link: {
              digest: () => Effect.succeed({ digest: "digest", replica: null }),
              preview: () => Effect.die("not asked"),
              supersede: () => Effect.die("not taken over"),
            },
            peers: {
              coordinatorLease: () =>
                state.answer === null ? Effect.fail(state.error) : Effect.succeed(state.answer),
              coordinatorReplica: () => Effect.die("not asked"),
            },
            selfEnvironmentId: "m4",
            listProjects: Effect.succeed([project]),
            loadProject,
            runningThreads: () => Effect.succeed([]),
            workers: () => Effect.succeed([]),
            stopCoordinator,
            stopCoordinatorWorkers: () => Effect.succeed(0),
            plannedPauseUntil: Effect.succeed(null),
            afterTick: makeFenceSweep({ store: memory.service, loadProject, stopCoordinator }),
          });
        }).pipe(Effect.provide(ProjectAdmission.layer)),
      );
    const gate = (threadId = "project-coordinator:easychamp-m4") =>
      Effect.runPromise(makeCheck(memory.service)(ThreadId.make(threadId)));
    const answered = (overrides: Partial<CoordinatorLeaseResponse> = {}) => {
      state.answer = {
        takenOver: null,
        wantsContent: false,
        standbySleeping: false,
        receivedAt: iso(nowMs()),
        ...overrides,
      };
    };
    return { memory, state, loop, gate, answered, record: () => memory.records.get(project.id) };
  };

  it("fences, interrupts once, survives a restart and lifts after one answered lease", async () => {
    const { state, loop, gate, answered, record } = harness();
    const lease = await loop();
    await Effect.runPromise(lease.tick);
    // Never heard from since it was turned on 20 minutes ago: fenced at once.
    expect(record()?.fencedSince).not.toBeNull();
    expect(state.stopped).toEqual(["easychamp-m4"]);
    expect(await gate()).toBe(COORDINATOR_FENCE_REFUSAL);
    await Effect.runPromise(lease.tick);
    expect(state.stopped).toHaveLength(1);

    // A restart keeps the fence: it is read from the records.
    const restarted = await loop();
    state.error = new HandoffPeerError({
      code: "busy",
      message: "M1 is updating",
      uncertain: false,
    });
    await Effect.runPromise(restarted.tick);
    expect(await gate()).toBe(COORDINATOR_FENCE_REFUSAL);

    answered();
    await Effect.runPromise(restarted.tick);
    expect(record()?.fencedSince).toBeNull();
    expect(await gate()).toBeNull();
  });

  it("lifts when the standby says it does not stand by here", async () => {
    const { state, loop, gate, record } = harness();
    const lease = await loop();
    await Effect.runPromise(lease.tick);
    expect(await gate()).toBe(COORDINATOR_FENCE_REFUSAL);
    state.error = new HandoffPeerError({
      code: "not_found",
      message: "Not armed",
      uncertain: false,
    });
    await Effect.runPromise(lease.tick);
    expect(record()).toMatchObject({ fencedSince: null });
    expect(record()?.standbyMissingAt).not.toBeNull();
    expect(await gate()).toBeNull();
  });

  it("Run here anyway turns the standby off with a release still owed", async () => {
    const { loop, gate, record } = harness();
    const lease = await loop();
    await Effect.runPromise(lease.tick);
    expect(await gate()).toBe(COORDINATOR_FENCE_REFUSAL);
    // Without the owner's choice the standby cannot be turned off while it is silent.
    const refused = await Effect.runPromiseExit(
      lease.releaseBefore({
        projectId: ProjectId.make("easychamp-m4"),
        changeAnyway: false,
        reason: "run-here-anyway",
      }),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(await gate()).toBe(COORDINATOR_FENCE_REFUSAL);
    const anyway = await Effect.runPromiseExit(
      lease.releaseBefore({
        projectId: ProjectId.make("easychamp-m4"),
        changeAnyway: true,
        reason: "run-here-anyway",
      }),
    );
    expect(Exit.isSuccess(anyway)).toBe(true);
    expect(record()).toMatchObject({
      target: null,
      fencedSince: null,
      pendingReleases: [{ standby: { environmentId: "m1" }, epoch: 3 }],
    });
    expect(await gate()).toBeNull();
  });
});
