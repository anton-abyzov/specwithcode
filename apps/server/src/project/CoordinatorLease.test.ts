import {
  type CoordinatorRoutineCopy,
  EnvironmentId,
  type Project,
  type ProjectId,
  ProjectLinkError,
} from "@specweave-studio/contracts";
import type { StudioWorkGrantProjects } from "@specweave-studio/contracts/studioFleet";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import type { CoordinatorLeaseRequest, CoordinatorLeaseResponse } from "../handoff/handoffWire.ts";
import {
  type CoordinatorLeaseDeps,
  type CoordinatorLeaseShape,
  makeCoordinatorLease,
  releaseSettledBy,
  reviewBoundary,
} from "./CoordinatorLease.ts";
import * as CoordinatorLeaseRoute from "./CoordinatorLeaseRoute.ts";
import {
  emptyLeaseRecord,
  makeMemory,
  withoutPendingRelease,
  withPendingRelease,
} from "./CoordinatorLeaseStore.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectLink from "./ProjectLink.ts";
import {
  coordinatorRoutinesDigest,
  type RoutineCopiesSnapshot,
} from "../scheduledTasks/ScheduledTaskCopies.ts";
import { legacyPair, link, removeCheckouts } from "./ProjectLink.testkit.ts";

afterEach(removeCheckouts);

const standbyId = "55555555-5555-4555-8555-555555555555";
const offId = "66666666-6666-4666-8666-666666666666";
const againId = "67676767-6767-4767-8767-676767676767";
const MINUTE = 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

const callerFrom = (environment: string, projects: StudioWorkGrantProjects): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects,
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

const peerError = (code: HandoffPeerError["code"], local = false) =>
  new HandoffPeerError({ code, message: `refused: ${code}`, uncertain: false, local });

/**
 * M4 coordinates EasyChamp with its M3 copy armed as the standby. The M4 lease
 * loop talks to M3's real lease receiver; `answer` replaces M3 for one test.
 */
const armed = async () => {
  const pair = legacyPair();
  const { prepared } = await link(pair);
  const logicalProjectId = prepared.logicalProject.id;
  const projectId = pair.kept.projectId;
  await pair.m4.run((service) =>
    service.setStandby({
      operationId: standbyId,
      projectId,
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
  const m4Grant = callerFrom("m4", { kind: "listed", projectIds: [pair.joining.projectId] });
  const onM3 = <A>(
    use: (
      receiver: CoordinatorLeaseRoute.CoordinatorLeaseReceiver["Service"],
    ) => Effect.Effect<A, HandoffRefusal>,
  ) =>
    Effect.gen(function* () {
      return yield* use(yield* CoordinatorLeaseRoute.CoordinatorLeaseReceiver);
    }).pipe(
      Effect.provide(CoordinatorLeaseRoute.layer.pipe(Layer.provideMerge(pair.m3.layer))),
      Effect.mapError(({ code, message }) => {
        return new HandoffPeerError({ code, message, uncertain: false });
      }),
    );
  const sent: CoordinatorLeaseRequest[] = [];
  const state = {
    /** Fails every call to M3 with this, as an unreachable or refusing standby would. */
    offline: null as HandoffPeerError | null,
    /** Answers leases instead of M3. */
    answer: null as ((request: CoordinatorLeaseRequest) => CoordinatorLeaseResponse) | null,
    plannedPauseUntil: null as number | null,
    replicas: 0,
    interrupted: [] as string[],
    stoppedRows: 0,
    /** What the loop's sync sees instead of M4's projects: a view from before a change. */
    listed: null as ReadonlyArray<Project> | null,
    /** The coordinator's routines as RoutineCopies would read them; null sends none. */
    routines: null as RoutineCopiesSnapshot | null,
  };
  const memory = makeMemory();
  const deps = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ProjectLink.ProjectLink;
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const result: CoordinatorLeaseDeps = {
        store: memory.service,
        admission,
        link: service,
        selfEnvironmentId: "m4",
        peers: {
          coordinatorLease: (_environmentId, request) =>
            Effect.suspend(() => {
              sent.push(request);
              if (state.offline !== null) return Effect.fail(state.offline);
              if (state.answer !== null) return Effect.succeed(state.answer(request));
              return onM3((receiver) => receiver.lease(m4Grant, request));
            }),
          coordinatorReplica: (_environmentId, request) =>
            Effect.suspend(() => {
              state.replicas += 1;
              return onM3((receiver) => receiver.replica(m4Grant, request));
            }),
        },
        listProjects: Effect.sync(() => state.listed ?? [...pair.m4.projects.values()]),
        loadProject: (id: ProjectId) => Effect.sync(() => pair.m4.projects.get(id)),
        runningThreads: () =>
          Effect.succeed([{ threadId: pair.kept.coordinatorThreadId, title: "Coordinator" }]),
        workers: () => Effect.succeed([]),
        stopCoordinator: (project) =>
          Effect.sync(() => {
            state.interrupted.push(project.id);
          }),
        stopCoordinatorWorkers: () =>
          Effect.sync(() => {
            state.stoppedRows += 1;
            return 2;
          }),
        plannedPauseUntil: Effect.sync(() => state.plannedPauseUntil),
        routines: () => Effect.sync(() => state.routines),
      };
      return result;
    }).pipe(Effect.provide(Layer.merge(pair.m4.layer, ProjectAdmission.layer))),
  );
  const lease: CoordinatorLeaseShape = makeCoordinatorLease(deps);
  const tick = () => Effect.runPromise(lease.tick);
  const record = () => memory.records.get(projectId);
  const standbyRecord = () => pair.m3.standby.get(logicalProjectId);
  const binding = () => pair.m4.projects.get(projectId)!.workspaceSettings!.coordinatorBinding!;
  const releaseBefore = (input: Parameters<CoordinatorLeaseShape["releaseBefore"]>[0]) =>
    Effect.runPromiseExit(lease.releaseBefore(input));
  return {
    pair,
    logicalProjectId,
    projectId,
    lease,
    memory,
    sent,
    state,
    tick,
    record,
    standbyRecord,
    binding,
    releaseBefore,
  };
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected a failure.");
  return Cause.squash(exit.cause);
};

describe("CoordinatorLease", () => {
  it("leases with a rising, persisted sequence and sends its content when the standby asks", async () => {
    const { tick, sent, record, standbyRecord, state, pair, memory, projectId } = await armed();
    const before = nowMs();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "lease",
      epoch: 0,
      afterMinutes: 15,
      runningThreads: [{ threadId: pair.kept.coordinatorThreadId, title: "Coordinator" }],
    });
    // The sequence is above the wall clock, so a lost file never repeats one.
    expect(sent[0]!.seq).toBeGreaterThanOrEqual(before);
    expect(record()).toMatchObject({ seq: sent[0]!.seq, lastError: null, fencedSince: null });
    expect(Date.parse(record()!.lastSuccessfulLeaseAt!)).toBeGreaterThanOrEqual(before);
    expect(standbyRecord()).toMatchObject({ lastSeq: sent[0]!.seq, leaseSinceWatching: true });
    // M3 held no copy of the content, so it asked and got one.
    expect(state.replicas).toBe(1);
    expect(pair.m3.replicas.get(pair.joining.projectId)).toMatchObject({ from: pair.kept });

    await tick();
    expect(sent[1]!.seq).toBeGreaterThan(sent[0]!.seq);
    expect(state.replicas).toBe(1);

    // The records file was lost: the next sequence is still above every one sent.
    // A restart after losing it takes at least a few milliseconds.
    memory.records.set(projectId, { ...record()!, seq: 0 });
    await Effect.runPromise(Effect.sleep("5 millis"));
    await tick();
    expect(sent[2]!.seq).toBeGreaterThan(sent[1]!.seq);
    expect(standbyRecord()?.lastSeq).toBe(sent[2]!.seq);
  });

  it("sends its routines with the content, and again only when they change", async () => {
    const { tick, sent, state, pair } = await armed();
    const routine = {
      id: "daily-review",
      title: "Daily review",
      prompt: "Review open pull requests",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
    } as unknown as CoordinatorRoutineCopy;
    const snapshot = (routines: CoordinatorRoutineCopy[]) => ({
      routines,
      digest: coordinatorRoutinesDigest(routines),
    });
    state.routines = snapshot([routine]);
    await tick();
    expect(sent[0]?.routinesDigest).toBe(state.routines.digest);
    expect(state.replicas).toBe(1);
    expect(pair.m3.keptRoutines.get(pair.joining.projectId)?.ids).toEqual(["daily-review"]);
    await tick();
    expect(state.replicas).toBe(1);
    // The routine was deleted on the coordinator: the standby's copy follows.
    state.routines = snapshot([]);
    await tick();
    expect(state.replicas).toBe(2);
    expect(pair.m3.keptRoutines.get(pair.joining.projectId)?.ids).toEqual([]);
  });

  it("releases a standby it no longer leases to on the next round", async () => {
    const { tick, sent, record, standbyRecord, pair, projectId } = await armed();
    await tick();
    expect(standbyRecord()).toBeDefined();
    await pair.m4.run((service) =>
      service.setStandby({ operationId: offId, projectId, standby: null }),
    );
    await tick();
    expect(sent.at(-1)).toMatchObject({ kind: "release", epoch: 0 });
    expect(standbyRecord()).toBeUndefined();
    // Nothing left to lease to or release: the record goes.
    expect(record()).toBeUndefined();
  });

  it("releases before a change, and owes the release when the owner changes anyway", async () => {
    const { tick, sent, record, standbyRecord, state, releaseBefore, pair, projectId } =
      await armed();
    await tick();
    // Keeping the same standby needs no release; another member's unlink neither.
    expect(
      Exit.isSuccess(
        await releaseBefore({ projectId, unless: pair.joining, changeAnyway: false, reason: "t" }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        await releaseBefore({ projectId, onlyFor: pair.kept, changeAnyway: false, reason: "t" }),
      ),
    ).toBe(true);
    expect(sent.every((request) => request.kind === "lease")).toBe(true);

    state.offline = peerError("unreachable");
    const refused = failureOf(
      await releaseBefore({ projectId, changeAnyway: false, reason: "standby-off" }),
    );
    expect(refused).toBeInstanceOf(ProjectLinkError);
    expect((refused as ProjectLinkError).code).toBe("standby_unreachable");
    expect(record()?.target).not.toBeNull();

    const anyway = await releaseBefore({ projectId, changeAnyway: true, reason: "standby-off" });
    expect(Exit.isSuccess(anyway)).toBe(true);
    expect(record()).toMatchObject({ target: null, pendingReleases: [{ epoch: 0 }] });
    await pair.m4.run((service) =>
      service.setStandby({ operationId: offId, projectId, standby: null }),
    );
    // Still unreachable: the release stays owed.
    await tick();
    expect(record()?.pendingReleases).toHaveLength(1);
    expect(standbyRecord()).toBeDefined();
    state.offline = null;
    await tick();
    expect(standbyRecord()).toBeUndefined();
    expect(record()).toBeUndefined();
  });

  it("an answered release clears the target at once", async () => {
    const { tick, record, standbyRecord, releaseBefore, projectId } = await armed();
    await tick();
    const exit = await releaseBefore({ projectId, changeAnyway: false, reason: "unlink" });
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(standbyRecord()).toBeUndefined();
    expect(record()).toMatchObject({ target: null, pendingReleases: [] });
  });

  it("announces planned pauses and sleep, capped at 30 minutes", async () => {
    const { tick, lease, sent, standbyRecord, state } = await armed();
    await tick();
    const until = iso(nowMs() + 10 * MINUTE);
    expect(await Effect.runPromise(lease.pause({ pausedUntil: until }))).toBe(1);
    expect(sent.at(-1)).toMatchObject({ kind: "pause", pausedUntil: until });
    expect(standbyRecord()?.pausedUntil).toBe(until);

    expect(await Effect.runPromise(lease.pause({ sleeping: true }))).toBe(1);
    expect(sent.at(-1)).toMatchObject({ kind: "pause", sleeping: true });
    expect(standbyRecord()?.coordinatorSleptAt).not.toBeNull();

    // A service update under way turns the ordinary lease into a capped pause.
    state.plannedPauseUntil = nowMs() + 4 * 60 * MINUTE;
    await tick();
    const last = sent.at(-1)!;
    expect(last.kind).toBe("pause");
    expect(Date.parse(last.pausedUntil!) - nowMs()).toBeLessThanOrEqual(30 * MINUTE);
    expect(Date.parse(last.pausedUntil!) - nowMs()).toBeGreaterThan(29 * MINUTE);
  });

  it("tells silence apart from a busy, sleeping or disarmed standby", async () => {
    const { tick, record, state } = await armed();
    await tick();
    const confirmed = record()!.lastSuccessfulLeaseAt;

    state.offline = peerError("unreachable");
    await tick();
    expect(record()).toMatchObject({
      lastSuccessfulLeaseAt: confirmed,
      lastPausedAnswerAt: null,
      standbyMissingAt: null,
    });
    expect(record()?.lastError).toContain("unreachable");

    state.offline = peerError("busy");
    await tick();
    expect(record()?.lastPausedAnswerAt).not.toBeNull();
    expect(record()?.lastSuccessfulLeaseAt).toBe(confirmed);
    const busyAt = record()!.lastPausedAnswerAt!;

    // This machine's own failure (no grant here) says nothing about the standby.
    state.offline = peerError("not_found", true);
    await tick();
    expect(record()?.standbyMissingAt).toBeNull();

    state.offline = peerError("not_found");
    await tick();
    expect(record()?.standbyMissingAt).not.toBeNull();

    state.offline = null;
    state.answer = () => ({
      takenOver: null,
      wantsContent: false,
      standbySleeping: true,
      receivedAt: iso(nowMs()),
    });
    // Leases are 30 seconds apart; a few milliseconds keep the two send times apart here.
    await Effect.runPromise(Effect.sleep("5 millis"));
    await tick();
    // A sleeping standby's answer is a round trip, and it pauses the silence too.
    expect(record()).toMatchObject({ standbyMissingAt: null, lastError: null });
    expect(Date.parse(record()!.lastSuccessfulLeaseAt!)).toBeGreaterThan(Date.parse(confirmed!));
    expect(Date.parse(record()!.lastPausedAnswerAt!)).toBeGreaterThan(Date.parse(busyAt));
  });

  it("gives way once its standby took over: interrupts, supersedes, stops rows, reviews", async () => {
    const { tick, sent, record, standbyRecord, state, pair, logicalProjectId, binding } =
      await armed();
    await tick();
    const confirmed = Date.parse(record()!.lastSuccessfulLeaseAt!);
    // M3 heard nothing for 20 minutes and takes over by itself.
    const quietSince = nowMs() - 20 * MINUTE;
    pair.m3.standby.set(logicalProjectId, {
      ...standbyRecord()!,
      lastLeaseAt: iso(quietSince),
      watchingSince: iso(quietSince - MINUTE),
      leaseSinceWatching: true,
    });
    const taken = await pair.m3.run((service) => service.autoTakeover({ logicalProjectId }));
    if (taken.outcome !== "taken-over") throw new Error(taken.outcome);
    // A turn M4 ran after the last lease M3 confirmed is listed for review.
    pair.m4.runs.set(pair.kept.coordinatorThreadId, [
      { id: "before", requestedAt: iso(confirmed - 5 * MINUTE), text: "old" },
      { id: "after", requestedAt: iso(nowMs()), text: "ran while away" },
    ]);

    await tick();
    expect(state.interrupted).toEqual([pair.kept.projectId]);
    expect(state.stoppedRows).toBe(1);
    expect(binding()).toMatchObject({
      state: "transferred",
      epoch: taken.result.coordinatorBinding.epoch,
      successor: { environmentId: "m3", projectId: pair.joining.projectId },
    });
    expect(record()).toMatchObject({
      target: null,
      gaveWay: {
        successor: { environmentId: "m3" },
        epoch: taken.result.coordinatorBinding.epoch,
        ranWhileAway: 1,
      },
    });
    // The boundary is never after the last lease M3 confirmed.
    expect(Date.parse(record()!.gaveWay!.reviewFrom)).toBeLessThanOrEqual(confirmed);
    expect(binding().takenOverAt).toBe(record()!.gaveWay!.reviewFrom);

    // Once given way, nothing more is leased.
    const leasesBefore = sent.length;
    await tick();
    expect(sent).toHaveLength(leasesBefore);
  });

  it("ignores a takeover answer it cannot verify", async () => {
    const { tick, record, state, pair, binding } = await armed();
    await tick();
    const own = binding();
    const forged = (overrides: {
      predecessor?: typeof pair.kept;
      successor?: typeof pair.kept;
      epoch?: number;
    }) => {
      state.answer = () => ({
        takenOver: {
          coordinatorBinding: {
            epoch: overrides.epoch ?? 1,
            state: "active",
            operationId: "auto:forged:1",
            predecessor: overrides.predecessor ?? pair.kept,
            takenOverAt: iso(nowMs()),
            takenOverBy: "auto",
          },
          successor: overrides.successor ?? pair.joining,
        },
        wantsContent: false,
        standbySleeping: false,
        receivedAt: iso(nowMs()),
      });
    };
    // Another member claims the takeover through the standby's answer.
    forged({ successor: { ...pair.joining, environmentId: EnvironmentId.make("m1") } });
    await tick();
    expect(record()?.lastError).toContain("the sender is not the standby");
    // A predecessor that is not this copy, and an epoch not above this one, are refused too.
    forged({ predecessor: pair.joining });
    await tick();
    expect(record()?.lastError).toContain("the predecessor is not this copy");
    forged({ epoch: 0 });
    await tick();
    expect(record()?.lastError).toContain("the epoch is not above");
    expect(binding()).toEqual(own);
    expect(state.interrupted).toEqual([]);
  });

  it("drops a release owed to the standby the owner sets again, which stays armed", async () => {
    const { tick, sent, record, standbyRecord, state, releaseBefore, pair, projectId } =
      await armed();
    await tick();
    state.offline = peerError("unreachable");
    await releaseBefore({ projectId, changeAnyway: true, reason: "standby-off" });
    await pair.m4.run((service) =>
      service.setStandby({ operationId: offId, projectId, standby: null }),
    );
    await tick();
    expect(record()?.pendingReleases).toMatchObject([{ epoch: 0 }]);

    state.offline = null;
    await pair.m4.run((service) =>
      service.setStandby({
        operationId: againId,
        projectId,
        standby: { member: pair.joining, afterMinutes: 15 },
      }),
    );
    const before = sent.length;
    await tick();
    // The same standby at the same epoch is leased to again; releasing it would disarm it.
    expect(sent.slice(before).map((request) => request.kind)).toEqual(["lease"]);
    expect(record()).toMatchObject({ pendingReleases: [], target: { epoch: 0 } });
    expect(standbyRecord()).toBeDefined();
  });

  it("checks a release against the binding again just before sending it", async () => {
    const { tick, sent, record, standbyRecord, state, releaseBefore, pair, projectId } =
      await armed();
    await tick();
    state.offline = peerError("unreachable");
    await releaseBefore({ projectId, changeAnyway: true, reason: "standby-off" });
    await pair.m4.run((service) =>
      service.setStandby({ operationId: offId, projectId, standby: null }),
    );
    await tick();
    // The owner sets the standby again after this round's sync read the projects.
    state.listed = [...pair.m4.projects.values()];
    state.offline = null;
    await pair.m4.run((service) =>
      service.setStandby({
        operationId: againId,
        projectId,
        standby: { member: pair.joining, afterMinutes: 15 },
      }),
    );
    const before = sent.length;
    await tick();
    expect(sent.slice(before)).toEqual([]);
    expect(record()?.pendingReleases ?? []).toEqual([]);
    expect(standbyRecord()).toBeDefined();
    state.listed = null;
    await tick();
    expect(sent.slice(before).map((request) => request.kind)).toEqual(["lease"]);
  });

  it("settles a release the standby ignored, but not one refused for its version", async () => {
    const { tick, sent, record, state, pair, projectId } = await armed();
    await tick();
    state.offline = new HandoffPeerError({
      code: "invalid",
      message: "Update this machine.",
      check: "version",
      uncertain: false,
    });
    await pair.m4.run((service) =>
      service.setStandby({ operationId: offId, projectId, standby: null }),
    );
    await tick();
    expect(sent.at(-1)).toMatchObject({ kind: "release" });
    expect(record()?.pendingReleases).toHaveLength(1);
    // It holds no registration from this copy at that epoch: nothing is left to release.
    state.offline = peerError("invalid");
    await tick();
    expect(record()).toBeUndefined();

    expect(releaseSettledBy(peerError("not_found"))).toBe(true);
    expect(releaseSettledBy(peerError("not_found", true))).toBe(false);
    expect(releaseSettledBy(peerError("invalid", true))).toBe(false);
    expect(releaseSettledBy(peerError("unreachable"))).toBe(false);
    expect(releaseSettledBy(peerError("busy"))).toBe(false);
  });

  it("records when a lease may have reached the standby, until the target changes", async () => {
    const { tick, record, state, pair, projectId } = await armed();
    state.offline = peerError("unreachable");
    await tick();
    // A definite failure proves nothing reached it.
    expect(record()?.maybeDeliveredAt ?? null).toBeNull();
    state.offline = new HandoffPeerError({
      code: "unreachable",
      message: "M3 did not answer.",
      uncertain: true,
    });
    await tick();
    const unanswered = record()?.maybeDeliveredAt;
    expect(unanswered).toEqual(expect.any(String));
    state.offline = null;
    await Effect.runPromise(Effect.sleep("5 millis"));
    await tick();
    expect(Date.parse(record()!.maybeDeliveredAt!)).toBeGreaterThan(Date.parse(unanswered!));

    state.offline = peerError("unreachable");
    await pair.m4.run((service) =>
      service.setStandby({ operationId: offId, projectId, standby: null }),
    );
    await tick();
    expect(record()).toMatchObject({ target: null, maybeDeliveredAt: null });
  });

  it("marks a lease as maybe reached before it leaves, so one cut off keeps the mark", async () => {
    const { tick, record, state } = await armed();
    let whileInFlight: string | null | undefined;
    state.answer = () => {
      whileInFlight = record()?.maybeDeliveredAt;
      // The process stops mid-call: no answer and no result is recorded.
      throw new Error("server restarted");
    };
    await tick();
    expect(whileInFlight).toEqual(expect.any(String));
    expect(record()?.lastSuccessfulLeaseAt ?? null).toBeNull();
    expect(record()?.maybeDeliveredAt).toBe(whileInFlight);

    // A definite failure removes only its own mark; the cut-off call's stays.
    state.answer = null;
    state.offline = peerError("unreachable");
    await tick();
    expect(record()?.maybeDeliveredAt).toBe(whileInFlight);
  });
});

describe("pending release helpers", () => {
  const member = (environmentId: string) => ({
    environmentId: EnvironmentId.make(environmentId),
    projectId: `easychamp-${environmentId}` as ProjectId,
    coordinatorThreadId: `project-coordinator:easychamp-${environmentId}` as never,
  });
  const entry = (environmentId: string, epoch: number) => ({
    standby: member(environmentId),
    epoch,
    logicalProjectId: "logical:easychamp",
    since: "2026-11-03T10:00:00.000Z",
  });
  const at = "2026-11-03T10:05:00.000Z";

  it("owes a release once, starting a record when there is none", () => {
    const first = withPendingRelease(undefined, entry("m2", 4), "easychamp-m1", at);
    expect(first).toMatchObject({
      projectId: "easychamp-m1",
      logicalProjectId: "logical:easychamp",
      target: null,
      pendingReleases: [entry("m2", 4)],
    });
    expect(withPendingRelease(first, entry("m2", 4), "easychamp-m1", at)).toBe(first);
    expect(
      withPendingRelease(first, entry("m2", 5), "easychamp-m1", at).pendingReleases,
    ).toHaveLength(2);
  });

  it("removes only the named release, and the record once nothing is left", () => {
    const base = emptyLeaseRecord("easychamp-m1", "logical:easychamp", at);
    const two = { ...base, pendingReleases: [entry("m2", 4), entry("m3", 4)] };
    expect(withoutPendingRelease(undefined, member("m2"), 4)).toBeUndefined();
    expect(withoutPendingRelease(two, member("m2"), 5)).toBeUndefined();
    const one = withoutPendingRelease(two, member("m2"), 4);
    expect(one).toMatchObject({ pendingReleases: [entry("m3", 4)] });
    expect(withoutPendingRelease(one!, member("m3"), 4)).toBeNull();
  });
});

describe("reviewBoundary", () => {
  it("moves the standby's time into this clock and never past the last confirmed lease", () => {
    const sent = Date.parse("2026-10-26T14:00:00.000Z");
    // The standby's clock runs 2 minutes ahead.
    const at = reviewBoundary({
      takenOverAt: "2026-10-26T14:12:00.000Z",
      standbyReceivedAt: "2026-10-26T14:02:00.500Z",
      sentAtMs: sent,
      answeredAtMs: sent + 1_000,
      lastSuccessfulLeaseAt: null,
    });
    expect(at).toBe(Date.parse("2026-10-26T14:10:00.000Z"));
    expect(
      reviewBoundary({
        takenOverAt: "2026-10-26T14:12:00.000Z",
        standbyReceivedAt: "2026-10-26T14:02:00.500Z",
        sentAtMs: sent,
        answeredAtMs: sent + 1_000,
        lastSuccessfulLeaseAt: "2026-10-26T13:55:00.000Z",
      }),
    ).toBe(Date.parse("2026-10-26T13:55:00.000Z"));
  });
});
