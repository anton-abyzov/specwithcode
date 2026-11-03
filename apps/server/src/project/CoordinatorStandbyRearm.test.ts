/**
 * Re-arming a standby after an automatic takeover (CoordinatorStandbyRearm).
 *
 * Four machines, each with its own ProjectLink over in-memory projects
 * (ProjectLink.testkit.ts): C coordinated at epoch 2 and went quiet, S1 took
 * over automatically at epoch 3, and S2 and S3 are members. The owner's
 * consent is on S1, S2 and S3. S1 runs the real re-arm over a stub network:
 * the digest probe reads the target's binding, the claim lands on the
 * target's real `acceptStandbyFromPeer` and epoch store, and a simulated
 * lease round does what CoordinatorLease's sync, lease and release do to the
 * lease record and to the standby's registration.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  ProjectCoordinatorBinding,
  ProjectCoordinatorStandby,
  ProjectId,
  ProjectLinkError,
  type StandbyRearmConsent,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { TEAM_RULES_NONE } from "@specweave-studio/shared/teamRules";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { applyEpochClaim } from "../fleet/WorkerEpochStore.ts";
import { RemoteMcpError, TEAM_RULES_REMOTE_CODE } from "../fleet/RemoteStudioMcpClient.ts";
import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import {
  COORDINATOR_LEASE_PROTOCOL_VERSION,
  CoordinatorLeaseRequest,
  CoordinatorLeaseResponse,
} from "../handoff/handoffWire.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  LinkedDigestResponse,
  LinkedSupersedeRequest,
} from "../handoff/linkedSyncWire.ts";
import { peerArmCode } from "../mcp/workGrantAccess.ts";
import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import { desiredLeaseTarget } from "./CoordinatorLease.ts";
import {
  type CoordinatorLeaseRecord,
  emptyLeaseRecord,
  makeMemory as makeLeaseMemory,
} from "./CoordinatorLeaseStore.ts";
import type { RearmEntry, RearmRun } from "./CoordinatorRearmStore.ts";
import {
  classifyClaim,
  type ClaimStandbyOutcome,
  makeStandbyRearm,
  makeStandbyRearmRound,
  nextAttemptMs,
  REARM_BACKOFF_MAX_MS,
  REARM_MAX_ROTATIONS,
  REARM_MONITOR_MS,
  REARM_STUCK_BACKOFF_MS,
  rearmCandidates,
  rearmOffOperationId,
  rearmOperationId,
  verifyWindowMs,
} from "./CoordinatorStandbyRearm.ts";
import { fenceAt } from "./CoordinatorWakeGate.ts";
import * as ProjectLink from "./ProjectLink.ts";
import { machine, removeCheckouts } from "./ProjectLink.testkit.ts";
import { autoTakeoverOperationId, REARM_OWNER_CHOSE } from "./ProjectLinkStandby.ts";

afterEach(removeCheckouts);

const L = "logical:easychamp";
const E = 3;
const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const chainId = "77777777-7777-4777-8777-777777777777";
const newChain = "88888888-8888-4888-8888-888888888888";
const ownerOp = "99999999-9999-4999-8999-999999999999";

type Name = "c" | "s1" | "s2" | "s3";
const NAMES: ReadonlyArray<Name> = ["c", "s1", "s2", "s3"];
type Machine = ReturnType<typeof machine>;

const liveClock = Effect.runSync(Clock.clockWith(Effect.succeed));
const clockReading = (wall: () => number): Clock.Clock =>
  Object.assign(Object.create(liveClock) as Clock.Clock, {
    currentTimeMillisUnsafe: wall,
    currentTimeMillis: Effect.sync(wall),
    currentTimeNanosUnsafe: () => BigInt(wall()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(wall()) * 1_000_000n),
  });

/** Runs on one machine's ProjectLink with no team rules. */
const viaLink = <A>(
  target: Machine,
  use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, ProjectLinkError>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* ProjectLink.ProjectLink);
  }).pipe(
    Effect.provide(target.layer),
    Effect.provideService(TeamRules, teamRulesOf(TEAM_RULES_NONE)),
  );

function fleet(options: { readonly list?: ReadonlyArray<Name> } = {}) {
  let wall = T0;
  const clock = clockReading(() => wall);
  const machines = Object.fromEntries(NAMES.map((name) => [name, machine(name)])) as Record<
    Name,
    Machine
  >;
  const members = Object.fromEntries(
    NAMES.map((name) => [name, machines[name].member(`easychamp-${name}`)]),
  ) as Record<Name, LogicalProjectMember>;
  const identity: LogicalProject = {
    id: L,
    title: "EasyChamp",
    coordinatorId: `coordinator:${L}`,
    members: NAMES.map((name) => members[name]),
  };
  const bindings: Record<Name, ProjectCoordinatorBinding> = {
    c: { epoch: 2, state: "active" },
    s1: {
      epoch: E,
      state: "active",
      operationId: autoTakeoverOperationId(L, E),
      predecessor: members.c,
      takenOverAt: iso(T0 - 60_000),
      takenOverBy: "auto",
    },
    s2: { epoch: 2, state: "transferred" },
    s3: { epoch: 2, state: "transferred" },
  };
  for (const name of NAMES)
    machines[name].add(`easychamp-${name}`, `/tmp/rearm-${name}`, {
      logicalProject: identity,
      coordinatorBinding: bindings[name],
    });
  const projectIdOf = (name: Name) => ProjectId.make(`easychamp-${name}`);
  const copy = (name: Name) => machines[name].projects.get(projectIdOf(name))!;
  const binding = (name: Name) => copy(name).workspaceSettings!.coordinatorBinding!;
  const setBinding = (name: Name, next: ProjectCoordinatorBinding) => {
    const project = copy(name);
    machines[name].projects.set(projectIdOf(name), {
      ...project,
      workspaceSettings: { ...project.workspaceSettings!, coordinatorBinding: next },
    } as Project);
  };

  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.orDie, Effect.provideService(Clock.Clock, clock)));
  const runExit = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseExit(effect.pipe(Effect.provideService(Clock.Clock, clock)));

  const consent = (
    list: ReadonlyArray<Name> = options.list ?? ["s1", "s2", "s3"],
    overrides: Partial<StandbyRearmConsent> = {},
  ): StandbyRearmConsent => ({
    chainId,
    members: list.map((name) => members[name]),
    afterMinutes: 5,
    fromEpoch: 2,
    ...overrides,
  });
  const writeConsent = (name: Name, value: StandbyRearmConsent | null) =>
    run(
      viaLink(machines[name], (link) =>
        link.acceptStandby({ projectId: projectIdOf(name), logicalProjectId: L, rearm: value }),
      ),
    );

  /** Links that carry nothing; claims there time out. */
  const down = new Set<Name>();
  /** Machines that register a claim but whose answer is lost. */
  const lost = new Set<Name>();
  /** Machines whose lease answer is lost after it arrived (maybe delivered). */
  const silentAfterDelivery = new Set<Name>();
  const noGrant = new Set<Name>();
  const notConfigured = new Set<Name>();
  /** S1's project reads fail, as a busy database would. */
  const reads = { fail: false };
  const claims: Array<Name> = [];
  const probes: Array<Name> = [];

  const lease = makeLeaseMemory();
  const nameOf = (environmentId: string) => environmentId as Name;

  const claimOn = (name: Name, input: { epoch: number; chainId: string }) =>
    Effect.gen(function* () {
      const target = machines[name];
      const applied = applyEpochClaim(target.epochs.get(L), {
        logicalProjectId: L,
        epoch: input.epoch,
        by: "s1",
      });
      if (applied.next !== undefined) target.epochs.set(L, applied.next);
      if (!applied.accepted)
        return { accepted: false, standby: { armed: false, code: "superseded_conflict" } };
      const accepted = yield* viaLink(target, (link) =>
        link.acceptStandbyFromPeer({
          logicalProjectId: L,
          callerEnvironmentId: "s1",
          epoch: input.epoch,
          chainId: input.chainId,
        }),
      ).pipe(
        Effect.as({ armed: true } as Record<string, unknown>),
        Effect.catchTag("ProjectLinkError", (error) =>
          Effect.succeed({ armed: false, code: peerArmCode(error) } as Record<string, unknown>),
        ),
      );
      return { accepted: true, epoch: input.epoch, origins: [], standby: accepted };
    });

  const rearm = makeStandbyRearm({
    rearmStore: machines.s1.rearmStore,
    leaseStore: lease.service,
    loadProject: (id) =>
      Effect.suspend(() =>
        reads.fail
          ? Effect.die("database is locked")
          : Effect.sync(() => machines.s1.projects.get(id)),
      ),
    rearmStandby: (input) => viaLink(machines.s1, (link) => link.rearmStandby(input)),
    probe: (environmentId, _logicalProjectId, projectId) =>
      Effect.suspend(() => {
        const name = nameOf(environmentId);
        probes.push(name);
        if (down.has(name))
          return Effect.fail(
            new HandoffPeerError({ code: "unreachable", message: "no answer", uncertain: false }),
          );
        return Effect.succeed({
          protocolVersion: 1,
          member: members[name],
          binding:
            machines[name].projects.get(projectId)?.workspaceSettings?.coordinatorBinding ?? null,
          coordinatorDigest: "digest",
          replica: null,
          memoryDigest: null,
          planDigest: null,
        });
      }),
    claimStandby: (input) =>
      Effect.gen(function* () {
        const name = nameOf(input.machineId.slice("machine-".length));
        claims.push(name);
        if (down.has(name))
          return classifyClaim(Exit.fail(new RemoteMcpError({ reason: "unreachable" })));
        const answer = yield* claimOn(name, input);
        if (lost.has(name))
          return classifyClaim(Exit.fail(new RemoteMcpError({ reason: "unreachable" })));
        return classifyClaim(Exit.succeed(answer));
      }).pipe(Effect.orDie) as Effect.Effect<ClaimStandbyOutcome>,
    fleetMachineFor: (environmentId) =>
      Effect.succeed(
        notConfigured.has(nameOf(environmentId))
          ? undefined
          : { id: `machine-${environmentId}`, label: environmentId.toUpperCase() },
      ),
    grantStatus: (machineId) =>
      Effect.succeed({
        status: noGrant.has(nameOf(machineId.slice("machine-".length))) ? "expired" : "allowed",
        renewable: false,
      }),
    selfEnvironmentId: "s1",
  });

  const entry = () => machines.s1.rearm.get(L)!;
  const once = () => run(rearm.rearmOnce(entry()));
  const runOf = () => entry().run!;

  const sameStandby = (a: LogicalProjectMember, b: LogicalProjectMember) =>
    a.environmentId === b.environmentId && a.projectId === b.projectId;

  /**
   * One round of S1's lease loop: sync the target from the binding (owing
   * the old one a release, never the current one), lease to it, and send
   * the releases still owed to machines that answer.
   */
  const leaseRound = () => {
    const pid = projectIdOf("s1");
    const at = iso(wall);
    const desired = desiredLeaseTarget(copy("s1"));
    let record: CoordinatorLeaseRecord = lease.records.get(pid) ?? emptyLeaseRecord(pid, L, at);
    const unchanged =
      record.target === null || desired === null
        ? record.target === desired
        : sameStandby(record.target.standby, desired.standby) &&
          record.target.epoch === desired.epoch;
    if (!unchanged) {
      const owed =
        record.target === null
          ? record.pendingReleases
          : [
              ...record.pendingReleases,
              {
                standby: record.target.standby,
                epoch: record.target.epoch,
                logicalProjectId: L,
                since: at,
              },
            ];
      record = {
        ...record,
        target: desired,
        lastSuccessfulLeaseAt: null,
        maybeDeliveredAt: null,
        standbyMissingAt: null,
        fencedSince: null,
        pendingReleases: owed.filter(
          (entry) =>
            !(
              desired !== null &&
              sameStandby(entry.standby, desired.standby) &&
              entry.epoch === desired.epoch
            ),
        ),
      };
    }
    if (desired !== null) {
      const name = nameOf(desired.standby.environmentId);
      const held = machines[name].standby.get(L);
      const registered =
        held !== undefined &&
        held.coordinator.environmentId === "s1" &&
        held.epoch === desired.epoch;
      if (silentAfterDelivery.has(name)) record = { ...record, maybeDeliveredAt: at };
      else if (!down.has(name))
        record = registered
          ? { ...record, lastSuccessfulLeaseAt: at, maybeDeliveredAt: at, standbyMissingAt: null }
          : { ...record, standbyMissingAt: at };
    }
    record = {
      ...record,
      pendingReleases: record.pendingReleases.filter((owed) => {
        const name = nameOf(owed.standby.environmentId);
        if (down.has(name) || silentAfterDelivery.has(name)) return true;
        const held = machines[name].standby.get(L);
        if (
          held !== undefined &&
          held.coordinator.environmentId === "s1" &&
          held.epoch === owed.epoch
        )
          machines[name].standby.delete(L);
        return false;
      }),
    };
    lease.records.set(pid, record);
  };

  return {
    machines,
    members,
    copy,
    binding,
    setBinding,
    projectIdOf,
    consent,
    writeConsent,
    down,
    lost,
    silentAfterDelivery,
    noGrant,
    notConfigured,
    reads,
    claims,
    probes,
    lease,
    leaseRecord: () => lease.records.get(projectIdOf("s1")),
    once,
    entry,
    runOf,
    leaseRound,
    run,
    runExit,
    advance: (ms: number) => {
      wall += ms;
    },
    now: () => wall,
  };
}

/** A fleet with the owner's consent on S1, S2 and S3. */
const consented = async (options: { readonly list?: ReadonlyArray<Name> } = {}) => {
  const f = fleet(options);
  for (const name of ["s1", "s2", "s3"] as const) await f.writeConsent(name, f.consent());
  return f;
};

const outcomeRun = (outcome: Awaited<ReturnType<ReturnType<typeof fleet>["once"]>>) => {
  expect(outcome.kind).toBe("run");
  return (outcome as { run: RearmRun }).run;
};

describe("re-arming after an automatic takeover", () => {
  it("registers the next machine, names it, and counts it armed after a lease came back", async () => {
    const f = await consented();
    const run = outcomeRun(await f.once());
    expect(run).toMatchObject({ state: "verifying", epoch: E, chainId, reason: null });
    expect(run.standby?.environmentId).toBe("s2");
    expect(f.binding("s1").standby?.member.environmentId).toBe("s2");
    expect(f.binding("s1").standby?.afterMinutes).toBe(5);
    // S2 stands by for S1 at E, marked as a peer's registration under the owner's chain.
    expect(f.machines.s2.standby.get(L)).toMatchObject({
      coordinator: { environmentId: "s1" },
      epoch: E,
      afterMinutes: 5,
      armedBy: { kind: "peer", chainId },
    });
    expect(f.machines.s2.epochs.get(L)).toMatchObject({ epoch: E, claimedBy: "s1" });
    expect(f.claims).toEqual(["s2"]);

    f.advance(30_000);
    f.leaseRound();
    expect(outcomeRun(await f.once()).state).toBe("armed");
    expect(f.machines.s3.standby.size).toBe(0);

    const status = await f.run(
      viaLink(f.machines.s1, (link) => link.rearmStatus(f.projectIdOf("s1"))),
    );
    expect(status).toMatchObject({
      consent: { chainId, afterMinutes: 5 },
      run: { state: "armed", epoch: E, standby: { environmentId: "s2" }, reason: null },
    });
    // Watching an armed standby sends nothing.
    f.advance(120_000);
    f.leaseRound();
    expect(outcomeRun(await f.once()).state).toBe("armed");
    expect(f.claims).toEqual(["s2"]);
  });

  it("skips a machine whose probe fails, with no registration and no release owed", async () => {
    const f = await consented();
    f.down.add("s2");
    const run = outcomeRun(await f.once());
    expect(run.state).toBe("verifying");
    expect(run.standby?.environmentId).toBe("s3");
    expect(f.claims).toEqual(["s3"]);
    expect(f.probes).toEqual(["s2", "s3"]);
    expect(f.machines.s2.standby.size).toBe(0);
    expect(f.leaseRecord()).toBeUndefined();
  });

  it("owes a release to a machine whose claim got no answer, and the release reaches it later", async () => {
    const f = await consented();
    f.lost.add("s2");
    const run = outcomeRun(await f.once());
    expect(run.standby?.environmentId).toBe("s3");
    expect(run.uncertain.map((note) => note.member.environmentId)).toEqual(["s2"]);
    // S2 did register; nothing leases to it, so it cannot fire, and it is owed a release.
    expect(f.machines.s2.standby.get(L)?.coordinator.environmentId).toBe("s1");
    expect(
      f.leaseRecord()?.pendingReleases.map((owed) => [owed.standby.environmentId, owed.epoch]),
    ).toEqual([["s2", E]]);
    f.lost.delete("s2");
    f.leaseRound();
    expect(f.machines.s2.standby.size).toBe(0);
    expect(f.leaseRecord()?.pendingReleases).toEqual([]);
    // S3, the standby named, is untouched and answers its lease.
    expect(f.machines.s3.standby.get(L)?.coordinator.environmentId).toBe("s1");
    expect(f.leaseRecord()?.lastSuccessfulLeaseAt).not.toBeNull();
    expect(outcomeRun(await f.once()).state).toBe("armed");
  });

  it("owes the release again when a machine that did not answer before now refuses", async () => {
    const f = await consented();
    f.lost.add("s2");
    f.down.add("s3");
    expect(outcomeRun(await f.once()).state).toBe("pending");
    expect(f.machines.s2.standby.get(L)?.coordinator.environmentId).toBe("s1");
    // S2's consent is gone; its registration from the unanswered call is not.
    f.lost.delete("s2");
    await f.writeConsent("s2", null);
    f.advance(30_000);
    const run = outcomeRun(await f.once());
    expect(run.failed.map((note) => [note.member.environmentId, note.reason])).toEqual([
      ["s2", "no_consent"],
    ]);
    expect(
      f.leaseRecord()?.pendingReleases.map((owed) => [owed.standby.environmentId, owed.epoch]),
    ).toEqual([["s2", E]]);
    f.leaseRound();
    expect(f.machines.s2.standby.size).toBe(0);
  });

  it("names nobody while every machine is unreachable, then arms one that comes back", async () => {
    const f = await consented();
    f.down.add("s2");
    f.down.add("s3");
    const run = outcomeRun(await f.once());
    expect(run).toMatchObject({ state: "pending", reason: "unreachable", standby: null });
    expect(f.claims).toEqual([]);
    expect(f.binding("s1").standby).toBeUndefined();
    f.leaseRound();
    // No target, so this copy is never fenced.
    expect(f.leaseRecord()?.target ?? null).toBeNull();
    expect(fenceAt(f.leaseRecord()!)).toBeNull();

    f.advance(20 * 60_000);
    f.down.delete("s3");
    const later = outcomeRun(await f.once());
    expect(later.state).toBe("verifying");
    expect(later.standby?.environmentId).toBe("s3");
    expect(later.attempts).toBe(2);
  });

  it("tries the machine in flight first after a restart, and one registration results", async () => {
    const f = await consented({ list: ["s1", "s3", "s2"] });
    // The claim reached S2 and the process stopped before anything else.
    await f.run(
      f.machines.s1.rearmStore.modify(L, (current) => ({
        ...current!,
        run: {
          epoch: E,
          chainId,
          state: "pending",
          reason: null,
          detail: null,
          standby: null,
          enabledAt: null,
          inFlight: { member: f.members.s2, since: iso(f.now()) },
          rotatingFrom: null,
          failed: [],
          uncertain: [],
          rotations: 0,
          attempts: 1,
          since: iso(f.now()),
          updatedAt: iso(f.now()),
        },
      })),
    );
    const first = await f.run(
      viaLink(f.machines.s2, (link) =>
        link.acceptStandbyFromPeer({
          logicalProjectId: L,
          callerEnvironmentId: "s1",
          epoch: E,
          chainId,
        }),
      ),
    );
    expect(first.replayed).toBe(false);
    f.advance(5_000);
    const run = outcomeRun(await f.once());
    expect(f.claims).toEqual(["s2"]);
    expect(run).toMatchObject({ state: "verifying", inFlight: null });
    expect(run.standby?.environmentId).toBe("s2");
    expect(f.machines.s2.standby.get(L)?.acceptedAt).toBe(first.standby?.acceptedAt);
    expect(f.machines.s3.standby.size).toBe(0);
  });

  it("recovers a binding written before the run recorded it, without calling anyone", async () => {
    const f = await consented();
    await f.run(
      f.machines.s1.rearmStore.modify(L, (current) => ({
        ...current!,
        run: {
          epoch: E,
          chainId,
          state: "pending",
          reason: null,
          detail: null,
          standby: null,
          enabledAt: null,
          inFlight: { member: f.members.s2, since: iso(f.now() - 1_000) },
          rotatingFrom: null,
          failed: [],
          uncertain: [],
          rotations: 0,
          attempts: 1,
          since: iso(f.now()),
          updatedAt: iso(f.now()),
        },
      })),
    );
    await f.run(
      viaLink(f.machines.s1, (link) =>
        link.rearmStandby({
          projectId: f.projectIdOf("s1"),
          logicalProjectId: L,
          epoch: E,
          operationId: rearmOperationId(L, E, f.members.s2),
          standby: { member: f.members.s2, afterMinutes: 5 },
        }),
      ),
    );
    const run = outcomeRun(await f.once());
    expect(run).toMatchObject({ state: "verifying", inFlight: null });
    expect(run.standby?.environmentId).toBe("s2");
    expect(run.enabledAt).toBe(f.binding("s1").standby?.enabledAt);
    expect(f.claims).toEqual([]);
    expect(f.probes).toEqual([]);
  });

  it("replaces a standby no lease reached before the fence could rise", async () => {
    const f = await consented();
    await f.once();
    const enabledAt = Date.parse(f.binding("s1").standby!.enabledAt);
    f.down.add("s2");
    for (let step = 0; step < 3; step += 1) {
      f.advance(30_000);
      f.leaseRound();
      expect(outcomeRun(await f.once()).state).toBe("verifying");
    }
    f.advance(enabledAt + verifyWindowMs(5) - f.now() + 1_000);
    expect(f.now() - enabledAt).toBeLessThan(170_000);
    f.leaseRound();
    // Nothing reached S2, so it never started counting: the copy was never fenced.
    expect(f.leaseRecord()?.maybeDeliveredAt).toBeNull();
    expect(fenceAt(f.leaseRecord()!)!).toBeGreaterThan(f.now());
    const run = outcomeRun(await f.once());
    expect(run).toMatchObject({ state: "verifying", rotations: 1, rotatingFrom: null });
    expect(run.standby?.environmentId).toBe("s3");
    expect(run.failed.map((note) => [note.member.environmentId, note.reason])).toEqual([
      ["s2", "lease_failed"],
    ]);
    expect(f.binding("s1").standby?.member.environmentId).toBe("s3");
    expect(f.now() - enabledAt).toBeLessThan(170_000);
    f.leaseRound();
    expect(f.leaseRecord()?.pendingReleases.map((owed) => owed.standby.environmentId)).toEqual([
      "s2",
    ]);
    f.down.delete("s2");
    f.leaseRound();
    expect(f.machines.s2.standby.size).toBe(0);
    expect(f.machines.s3.standby.get(L)?.coordinator.environmentId).toBe("s1");
  });

  it("keeps a standby a lease may have reached, under today's fence", async () => {
    const f = await consented();
    await f.once();
    f.silentAfterDelivery.add("s2");
    f.leaseRound();
    f.advance(verifyWindowMs(5) + 30_000);
    f.leaseRound();
    const run = outcomeRun(await f.once());
    expect(run).toMatchObject({ state: "verifying", reason: "lease_failed", rotations: 0 });
    expect(f.binding("s1").standby?.member.environmentId).toBe("s2");
    expect(f.claims).toEqual(["s2"]);
  });

  it("replaces an armed standby that says it no longer stands by, up to a limit", async () => {
    const f = await consented();
    await f.once();
    f.leaseRound();
    expect(outcomeRun(await f.once()).state).toBe("armed");
    f.machines.s2.standby.delete(L);
    f.advance(30_000);
    f.leaseRound();
    expect(f.leaseRecord()?.standbyMissingAt).not.toBeNull();
    const run = outcomeRun(await f.once());
    expect(run.standby?.environmentId).toBe("s3");
    expect(run.rotations).toBe(1);
    expect(run.failed.map((note) => note.reason)).toEqual(["standby_missing"]);

    // At the limit it stops replacing and waits for hours.
    f.leaseRound();
    await f.once();
    await f.run(
      f.machines.s1.rearmStore.modify(L, (current) => ({
        ...current!,
        run: { ...current!.run!, rotations: REARM_MAX_ROTATIONS },
      })),
    );
    f.machines.s3.standby.delete(L);
    f.advance(30_000);
    f.leaseRound();
    const stuck = await f.once();
    expect(stuck).toMatchObject({
      kind: "run",
      stuck: true,
      run: { state: "pending", reason: "standby_missing" },
    });
    expect(nextAttemptMs(stuck, 1, 0)).toBe(REARM_STUCK_BACKOFF_MS);
    // The standby that cannot fire is turned off, so the coordinator is not left fenced.
    expect(outcomeRun(stuck).standby).toBeNull();
    expect(f.binding("s1").standby ?? null).toBeNull();
  });

  it("gives a standby that answered a fresh allowance of replacements", async () => {
    const f = await consented();
    await f.once();
    f.machines.s2.standby.delete(L);
    f.leaseRound();
    const rotated = outcomeRun(await f.once());
    expect(rotated).toMatchObject({ rotations: 1 });
    expect(rotated.standby?.environmentId).toBe("s3");
    f.leaseRound();
    expect(outcomeRun(await f.once())).toMatchObject({ state: "armed", rotations: 0 });
  });

  it("keeps a silent armed standby armed, with no replacement", async () => {
    const f = await consented();
    await f.once();
    f.leaseRound();
    await f.once();
    f.down.add("s2");
    for (let step = 0; step < 20; step += 1) {
      f.advance(30_000);
      f.leaseRound();
      expect(outcomeRun(await f.once()).state).toBe("armed");
    }
    expect(f.binding("s1").standby?.member.environmentId).toBe("s2");
    // Today's fence rises after the standby's silence.
    expect(fenceAt(f.leaseRecord()!)).not.toBeNull();
  });

  it("retries a grant missing here on the usual backoff, so a renewed grant is used soon", async () => {
    const f = await consented();
    f.noGrant.add("s2");
    f.notConfigured.add("s3");
    const outcome = await f.once();
    expect(outcome).toMatchObject({
      kind: "run",
      stuck: false,
      run: { state: "pending", reason: "needs_grant" },
    });
    expect(f.probes).toEqual([]);
    expect(f.claims).toEqual([]);
    expect(nextAttemptMs(outcome, 1, 0)).toBe(30_000);
    // The renewal pass renewed the grant: the next attempt arms.
    f.noGrant.delete("s2");
    f.advance(30_000);
    expect(outcomeRun(await f.once())).toMatchObject({ state: "verifying" });
    expect(f.claims).toEqual(["s2"]);
  });

  it("waits hours when only the owner can help, and tries again when the consent is rewritten", async () => {
    const f = await consented();
    // Both machines answer that they hold no consent from the owner.
    await f.writeConsent("s2", null);
    await f.writeConsent("s3", null);
    const outcome = await f.once();
    expect(outcome).toMatchObject({
      kind: "run",
      stuck: true,
      run: { state: "pending", reason: "no_consent" },
    });
    expect(f.claims).toEqual(["s2", "s3"]);

    const calls: Array<string> = [];
    let nowMs = 0;
    const loop = makeStandbyRearmRound({
      rearmStore: f.machines.s1.rearmStore,
      rearmOnce: (entry) => {
        calls.push(entry.consentUpdatedAt ?? "");
        return Effect.succeed(outcome);
      },
      bindingEpoch: () => Effect.succeed(E),
      held: Effect.succeed(false),
    });
    const round = () =>
      Effect.runPromise(
        loop.round.pipe(
          Effect.provideService(
            Clock.Clock,
            clockReading(() => nowMs),
          ),
        ),
      );
    await round();
    nowMs += 60 * 60_000;
    await round();
    expect(calls).toHaveLength(1);
    f.advance(1_000);
    await f.writeConsent("s1", f.consent(undefined, { fromEpoch: 3 }));
    await round();
    expect(calls).toHaveLength(2);
  });

  it("stops when the owner chooses the standby, before or after re-arm", async () => {
    const f = await consented();
    f.down.add("s2");
    f.down.add("s3");
    await f.once();
    await f.run(
      viaLink(f.machines.s1, (link) =>
        link.setStandby({
          operationId: ownerOp,
          projectId: f.projectIdOf("s1"),
          standby: { member: f.members.s3, afterMinutes: 15 },
        }),
      ),
    );
    expect(outcomeRun(await f.once())).toMatchObject({ state: "stopped", reason: "owner_changed" });
    const refused = await f.runExit(
      viaLink(f.machines.s1, (link) =>
        link.rearmStandby({
          projectId: f.projectIdOf("s1"),
          logicalProjectId: L,
          epoch: E,
          operationId: rearmOperationId(L, E, f.members.s2),
          standby: { member: f.members.s2, afterMinutes: 5 },
        }),
      ),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    const error = Exit.isFailure(refused) ? (refused.cause as unknown) : undefined;
    expect(JSON.stringify(error)).toContain(REARM_OWNER_CHOSE);
    expect(f.binding("s1").standby?.member.environmentId).toBe("s3");
    expect(f.binding("s1").standby?.afterMinutes).toBe(15);

    // After an arm, the owner turning the standby off stops it as well.
    const g = await consented();
    await g.once();
    g.leaseRound();
    await g.once();
    await g.run(
      viaLink(g.machines.s1, (link) =>
        link.setStandby({ operationId: ownerOp, projectId: g.projectIdOf("s1"), standby: null }),
      ),
    );
    expect(outcomeRun(await g.once())).toMatchObject({ state: "stopped", reason: "owner_changed" });
    expect(g.binding("s1").standby).toBeUndefined();
  });

  it("uses the owner's new list on the next round while still pending", async () => {
    const f = await consented();
    f.down.add("s2");
    f.down.add("s3");
    expect(outcomeRun(await f.once()).state).toBe("pending");
    const edited = f.consent(["s1", "s3"], { chainId: newChain, fromEpoch: E });
    await f.writeConsent("s1", edited);
    await f.writeConsent("s3", edited);
    f.down.delete("s2");
    f.down.delete("s3");
    const run = outcomeRun(await f.once());
    expect(run).toMatchObject({ state: "verifying", chainId: newChain });
    expect(run.standby?.environmentId).toBe("s3");
    expect(f.machines.s3.standby.get(L)?.armedBy).toEqual({ kind: "peer", chainId: newChain });
    expect(f.claims).toEqual(["s3"]);
  });

  it("never runs on a copy that did not take over automatically, and stops once superseded", async () => {
    const f = await consented();
    // A copy a person started, or took over, never re-arms.
    f.setBinding("s1", {
      epoch: E,
      state: "active",
      takenOverBy: "person",
      predecessor: f.members.c,
    });
    expect(await f.once()).toEqual({ kind: "idle" });
    f.setBinding("s1", { epoch: E, state: "active" });
    expect(await f.once()).toEqual({ kind: "idle" });
    expect(f.entry().run).toBeNull();

    const g = await consented();
    g.down.add("s2");
    g.down.add("s3");
    await g.once();
    // A person takes over on another machine; this copy gives way.
    g.setBinding("s1", { epoch: E + 1, state: "transferred", successor: g.members.s2 });
    expect(outcomeRun(await g.once())).toMatchObject({ state: "stopped", reason: "superseded" });
    expect(await g.once()).toMatchObject({ kind: "idle" });
  });

  it("keeps a run through a failed read or a handoff that rolled back", async () => {
    const f = await consented();
    await f.once();
    f.leaseRound();
    expect(outcomeRun(await f.once()).state).toBe("armed");
    const armedRun = f.runOf();

    // A failed read is not a project that is gone: the round fails and backs off.
    f.reads.fail = true;
    expect(await f.once()).toEqual({ kind: "failed" });
    f.reads.fail = false;
    expect(f.runOf()).toEqual(armedRun);

    // A person's handoff in progress waits, and the run goes on once it rolled back.
    const active = f.binding("s1");
    f.setBinding("s1", { ...active, state: "transferring" });
    expect(await f.once()).toEqual({ kind: "idle" });
    expect(f.runOf()).toEqual(armedRun);
    f.setBinding("s1", active);
    expect(outcomeRun(await f.once()).state).toBe("armed");

    // A run stopped by a state that reverted at the same epoch goes on too.
    f.setBinding("s1", { epoch: E, state: "active" });
    const stopped = outcomeRun(await f.once());
    expect(stopped).toMatchObject({ state: "stopped", reason: "superseded" });
    expect(nextAttemptMs({ kind: "run", run: stopped }, 1, 0)).toBe(REARM_MONITOR_MS);
    f.setBinding("s1", active);
    f.advance(30_000);
    f.leaseRound();
    expect(outcomeRun(await f.once())).toMatchObject({ state: "armed", reason: null });
    expect(f.binding("s1").standby?.member.environmentId).toBe("s2");
    expect(f.claims).toEqual(["s2"]);
  });

  it("refuses the old coordinator's registration on a machine armed for the new one", async () => {
    const f = await consented();
    await f.once();
    const before = f.machines.s2.standby.get(L);
    // C returns and asks S2 to stand by for it at its old epoch.
    const refused = await f.runExit(
      viaLink(f.machines.s2, (link) =>
        link.acceptStandby({
          projectId: f.projectIdOf("s2"),
          logicalProjectId: L,
          standby: { coordinator: f.members.c, epoch: 2, afterMinutes: 5 },
        }),
      ),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(f.machines.s2.standby.get(L)).toEqual(before);
    // Its claim at the old epoch is refused there too.
    expect(
      applyEpochClaim(f.machines.s2.epochs.get(L), { logicalProjectId: L, epoch: 2, by: "c" })
        .accepted,
    ).toBe(false);
  });

  it("goes on to the next machine when one refuses, without owing it a release", async () => {
    const f = await consented();
    await f.writeConsent("s2", null);
    const run = outcomeRun(await f.once());
    expect(run.standby?.environmentId).toBe("s3");
    expect(run.failed.map((note) => [note.member.environmentId, note.reason])).toEqual([
      ["s2", "no_consent"],
    ]);
    expect(f.machines.s2.standby.size).toBe(0);
    expect(f.leaseRecord()?.pendingReleases ?? []).toEqual([]);
  });
});

describe("one armed standby at a time", () => {
  it("leaves every registration for this copy either named or owed a release, whatever the network does", async () => {
    // A small seeded generator, so a failure replays.
    let seed = 20261103;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const others = ["s2", "s3"] as const;
    for (let trial = 0; trial < 12; trial += 1) {
      const f = await consented();
      for (let step = 0; step < 25; step += 1) {
        for (const name of others) {
          const roll = random();
          f.down.delete(name);
          f.lost.delete(name);
          f.silentAfterDelivery.delete(name);
          if (roll < 0.2) f.down.add(name);
          else if (roll < 0.3) f.lost.add(name);
          else if (roll < 0.4) f.silentAfterDelivery.add(name);
        }
        if (random() < 0.5) await f.once();
        f.leaseRound();
        f.advance(Math.floor(random() * 90_000));
        const named = f.binding("s1").standby?.member ?? null;
        const owed = f.leaseRecord()?.pendingReleases ?? [];
        for (const name of others) {
          const held = f.machines[name].standby.get(L);
          if (held === undefined || held.coordinator.environmentId !== "s1") continue;
          const isNamed = named !== null && named.environmentId === name;
          const isOwed = owed.some(
            (entry) => entry.standby.environmentId === name && entry.epoch === held.epoch,
          );
          expect({ trial, step, name, covered: isNamed || isOwed }).toMatchObject({
            covered: true,
          });
        }
      }
    }
  });
});

describe("candidates", () => {
  const member = (name: string): LogicalProjectMember =>
    ({
      environmentId: name,
      projectId: `p-${name}`,
      coordinatorThreadId: `project-coordinator:p-${name}`,
    }) as unknown as LogicalProjectMember;
  const [c, s1, s2, s3] = ["c", "s1", "s2", "s3"].map(member) as [
    LogicalProjectMember,
    LogicalProjectMember,
    LogicalProjectMember,
    LogicalProjectMember,
  ];
  const names = (list: ReadonlyArray<LogicalProjectMember>) => list.map((m) => m.environmentId);
  const base = { listed: [c, s1, s2, s3], failed: [], uncertain: [], inFlight: null };

  it("orders a cascade: the owner's list, then the predecessor it lists, never this copy", () => {
    expect(
      names(rearmCandidates({ ...base, members: [s1, s2, s3], self: s2, predecessor: s1 })),
    ).toEqual(["s3", "s1"]);
  });

  it("never tries the old coordinator the owner did not list", () => {
    expect(
      names(rearmCandidates({ ...base, members: [s1, s2], self: s2, predecessor: s1 })),
    ).toEqual(["s1"]);
    expect(
      names(rearmCandidates({ ...base, members: [s1, s2], self: s1, predecessor: c })),
    ).toEqual(["s2"]);
  });

  it("puts the machine in flight first, unanswered next to last, failed last, unlisted never", () => {
    const at = "2026-11-03T10:00:00.000Z";
    expect(
      names(
        rearmCandidates({
          members: [s1, s2, s3, c],
          listed: [c, s1, s2],
          self: s1,
          predecessor: c,
          failed: [{ member: s2, reason: "refused", at }],
          uncertain: [{ member: c, since: at }],
          inFlight: null,
        }),
      ),
    ).toEqual(["c", "s2"]);
    expect(
      names(
        rearmCandidates({
          members: [s1, s2, s3],
          listed: [s1, s2, s3],
          self: s1,
          predecessor: c,
          failed: [],
          uncertain: [{ member: s2, since: at }],
          inFlight: s2,
        }),
      ),
    ).toEqual(["s2", "s3"]);
  });

  it("names operations within 128 characters, apart for arm and disarm", () => {
    const on = rearmOperationId("logical:" + "x".repeat(400), 12345, s2);
    const off = rearmOffOperationId("logical:" + "x".repeat(400), 12345, s2);
    expect(on.length).toBeLessThanOrEqual(128);
    expect(off.length).toBeLessThanOrEqual(128);
    expect(on).not.toBe(off);
    expect(rearmOperationId(L, 3, s2)).toBe(rearmOperationId(L, 3, s2));
  });

  it("ends the verify window two ticks before the fence rises", () => {
    expect(verifyWindowMs(5)).toBe(110_000);
    expect(verifyWindowMs(15)).toBe(15 * 60_000 - 190_000);
  });
});

describe("claim answers", () => {
  const fail = (fields: ConstructorParameters<typeof RemoteMcpError>[0]) =>
    classifyClaim(Exit.fail(new RemoteMcpError(fields)));
  it.each([
    [
      "armed",
      classifyClaim(Exit.succeed({ accepted: true, standby: { armed: true } })),
      { kind: "armed" },
    ],
    [
      "refused with a code",
      classifyClaim(Exit.succeed({ standby: { armed: false, code: "no_consent" } })),
      { kind: "refused", reason: "no_consent" },
    ],
    [
      "refused with an unknown code",
      classifyClaim(Exit.succeed({ standby: { armed: false, code: "later" } })),
      { kind: "refused", reason: "refused" },
    ],
    [
      "an older receiver with no standby answer",
      classifyClaim(Exit.succeed({ accepted: true, epoch: 3, origins: [] })),
      { kind: "refused", reason: "needs_update" },
    ],
    ["unsupported", fail({ reason: "unsupported" }), { kind: "refused", reason: "needs_update" }],
    [
      "invalid params from an older receiver",
      fail({ reason: "unreachable", cause: new McpError(ErrorCode.InvalidParams, "bad") }),
      { kind: "refused", reason: "needs_update" },
    ],
    [
      "team rules",
      fail({ reason: "tool_failure", remoteCode: TEAM_RULES_REMOTE_CODE }),
      { kind: "refused", reason: "team_rules" },
    ],
    [
      "outside the grant",
      fail({ reason: "tool_failure", remoteCode: "outside_grant_scope" }),
      { kind: "refused", reason: "needs_grant" },
    ],
    [
      "another tool failure",
      fail({ reason: "tool_failure", remoteCode: "x" }),
      { kind: "refused", reason: "refused" },
    ],
    [
      "not authorized",
      fail({ reason: "not_authorized" }),
      { kind: "refused", reason: "needs_grant" },
    ],
    [
      "unknown machine",
      fail({ reason: "unknown_machine" }),
      { kind: "refused", reason: "needs_grant" },
    ],
    [
      "identity mismatch",
      fail({ reason: "identity_mismatch" }),
      { kind: "refused", reason: "needs_grant" },
    ],
    ["local allowlist", fail({ reason: "refused" }), { kind: "refused", reason: "needs_update" }],
    ["unreachable", fail({ reason: "unreachable" }), { kind: "uncertain" }],
    ["invalid response", fail({ reason: "invalid_response" }), { kind: "uncertain" }],
  ] as const)("%s", (_name, outcome, expected) => {
    expect(outcome).toMatchObject(expected);
  });
});

describe("the re-arm round", () => {
  const entryFor = (id: string, overrides: Partial<RearmEntry> = {}): RearmEntry => ({
    logicalProjectId: id,
    projectId: `p-${id}`,
    consent: {
      chainId,
      members: [],
      afterMinutes: 5,
      fromEpoch: 0,
    } as unknown as StandbyRearmConsent,
    consentUpdatedAt: "2026-11-03T10:00:00.000Z",
    run: null,
    ...overrides,
  });

  it("backs off 30 s, 60 s, 120 s up to 10 minutes while pending", () => {
    const pending = { kind: "run", run: { state: "pending" } as RearmRun } as const;
    expect([1, 2, 3, 10].map((failures) => nextAttemptMs(pending, failures, 0))).toEqual([
      30_000,
      60_000,
      120_000,
      REARM_BACKOFF_MAX_MS,
    ]);
    expect(nextAttemptMs({ kind: "run", run: { state: "verifying" } as RearmRun }, 1, 0)).toBe(
      30_000,
    );
    expect(nextAttemptMs({ kind: "run", run: { state: "armed" } as RearmRun }, 1, 0)).toBe(120_000);
    expect(nextAttemptMs({ kind: "run", run: { state: "stopped" } as RearmRun }, 1, 0)).toBeNull();
  });

  it("skips a dead entry and keeps going, at most two projects a round", async () => {
    const entries = [
      entryFor("dead"),
      entryFor("gone", { consent: null }),
      entryFor("a"),
      entryFor("b"),
    ];
    const seen: Array<string> = [];
    let nowMs = 0;
    const loop = makeStandbyRearmRound({
      rearmStore: { list: Effect.succeed(entries) },
      rearmOnce: (entry) => {
        seen.push(entry.logicalProjectId);
        return entry.logicalProjectId === "dead"
          ? Effect.succeed({ kind: "failed" } as const)
          : Effect.succeed({ kind: "run", run: { state: "armed" } as RearmRun } as const);
      },
      bindingEpoch: () => Effect.succeed(3),
      held: Effect.succeed(false),
    });
    const round = () =>
      Effect.runPromise(
        loop.round.pipe(
          Effect.provideService(
            Clock.Clock,
            clockReading(() => nowMs),
          ),
        ),
      );
    expect(await round()).toBe(2);
    expect(seen).toEqual(["dead", "a"]);
    nowMs += 30_000;
    await round();
    // The failed entry is tried again after its backoff; the next one gets its turn.
    expect(seen).toEqual(["dead", "a", "dead", "b"]);
  });

  it("lets idle entries take no turn, so a project that took over is never starved", async () => {
    const entries = [entryFor("idle-1"), entryFor("idle-2"), entryFor("idle-3"), entryFor("taken")];
    const seen: Array<string> = [];
    let nowMs = 0;
    const loop = makeStandbyRearmRound({
      rearmStore: { list: Effect.succeed(entries) },
      rearmOnce: (entry) => {
        seen.push(entry.logicalProjectId);
        return entry.logicalProjectId === "taken"
          ? Effect.succeed({ kind: "run", run: { state: "verifying" } as RearmRun } as const)
          : Effect.succeed({ kind: "idle" } as const);
      },
      bindingEpoch: () => Effect.succeed(3),
      held: Effect.succeed(false),
    });
    const round = () =>
      Effect.runPromise(
        loop.round.pipe(
          Effect.provideService(
            Clock.Clock,
            clockReading(() => nowMs),
          ),
        ),
      );
    expect(await round()).toBe(1);
    expect(seen).toEqual(["idle-1", "idle-2", "idle-3", "taken"]);
    nowMs += 30_000;
    seen.length = 0;
    await round();
    expect(seen).toContain("taken");
  });

  it("does nothing while a service update holds this machine", async () => {
    const loop = makeStandbyRearmRound({
      rearmStore: { list: Effect.die("not read") },
      rearmOnce: () => Effect.die("not run"),
      bindingEpoch: () => Effect.succeed(3),
      held: Effect.succeed(true),
    });
    expect(await Effect.runPromise(loop.round)).toBe(0);
  });
});

describe("the wire stays as it was", () => {
  const fieldsOf = (schema: { readonly fields: Record<string, unknown> }) =>
    Object.keys(schema.fields).toSorted();

  it("keeps the binding, lease, digest and supersede payloads and their versions", () => {
    // The fields as released before re-arm; a re-arm adds nothing a peer must decode.
    expect(fieldsOf(ProjectCoordinatorBinding)).toEqual(
      [
        "epoch",
        "state",
        "operationId",
        "predecessor",
        "successor",
        "releaseReason",
        "takenOverAt",
        "takenOverBy",
        "standby",
      ].toSorted(),
    );
    expect(fieldsOf(ProjectCoordinatorStandby)).toEqual(
      ["member", "afterMinutes", "enabledAt"].toSorted(),
    );
    expect(fieldsOf(CoordinatorLeaseRequest)).toEqual(
      [
        "protocolVersion",
        "kind",
        "logicalProjectId",
        "epoch",
        "seq",
        "afterMinutes",
        "contentDigest",
        "runningThreads",
        "workers",
        "pausedUntil",
        "sleeping",
        // Added by routine failover, not by re-arm.
        "routinesDigest",
      ].toSorted(),
    );
    expect(fieldsOf(CoordinatorLeaseResponse)).toEqual(
      ["takenOver", "wantsContent", "standbySleeping", "receivedAt"].toSorted(),
    );
    expect(fieldsOf(LinkedDigestResponse)).toEqual(
      [
        "protocolVersion",
        "member",
        "binding",
        "coordinatorDigest",
        "replica",
        "memoryDigest",
        "planDigest",
      ].toSorted(),
    );
    expect(fieldsOf(LinkedSupersedeRequest)).toEqual(
      [
        "protocolVersion",
        "logicalProjectId",
        "projectId",
        "successor",
        "coordinatorBinding",
      ].toSorted(),
    );
    expect(COORDINATOR_LEASE_PROTOCOL_VERSION).toBe(1);
    expect(LINKED_SYNC_PROTOCOL_VERSION).toBe(1);
  });

  it("writes a re-armed binding that peers decode unchanged in every payload carrying it", async () => {
    const f = await consented();
    await f.once();
    const binding = f.binding("s1");
    expect(binding.standby?.member.environmentId).toBe("s2");
    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeSync(ProjectCoordinatorBinding)(binding)),
    ) as unknown;
    expect(Schema.decodeUnknownSync(ProjectCoordinatorBinding)(encoded)).toEqual(binding);
    expect(
      Schema.decodeUnknownSync(LinkedDigestResponse)({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        member: f.members.s1,
        binding: encoded,
        coordinatorDigest: "digest",
        replica: null,
        memoryDigest: null,
        planDigest: null,
      }).binding,
    ).toEqual(binding);
    expect(
      Schema.decodeUnknownSync(CoordinatorLeaseResponse)({
        takenOver: { coordinatorBinding: encoded, successor: f.members.s1 },
        wantsContent: false,
        standbySleeping: false,
        receivedAt: iso(T0),
      }).takenOver?.coordinatorBinding,
    ).toEqual(binding);
    expect(
      Schema.decodeUnknownSync(LinkedSupersedeRequest)({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        logicalProjectId: L,
        projectId: f.projectIdOf("c"),
        successor: f.members.s1,
        coordinatorBinding: encoded,
      }).coordinatorBinding,
    ).toEqual(binding);
  });
});
