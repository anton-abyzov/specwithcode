import {
  EnvironmentId,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  ProjectId,
  type ProjectLinkError,
  type StandbyRearmConsent,
  ThreadId,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { TEAM_RULES_NONE } from "@specweave-studio/shared/teamRules";
import * as Effect from "effect/Effect";

import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import * as ProjectLink from "./ProjectLink.ts";
import { legacyTrio, machine, removeCheckouts, runOn } from "./ProjectLink.testkit.ts";
import { coordinatorClaimWindow, sameMemberSet } from "./ProjectLinkMembers.ts";

afterEach(removeCheckouts);

type Machine = ReturnType<typeof machine>;

const on = <A>(
  target: Machine,
  use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, ProjectLinkError>,
) => runOn(target.layer, use, TeamRules, teamRulesOf(TEAM_RULES_NONE));

const keys = (members: ReadonlyArray<LogicalProjectMember>) =>
  members.map(logicalProjectMemberKey).toSorted();

/** A machine linked on the coordinator that the other copies never heard of. */
const d: LogicalProjectMember = {
  environmentId: EnvironmentId.make("m2"),
  projectId: ProjectId.make("easychamp-m2"),
  coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m2"),
};

const chainId = "77777777-7777-4777-8777-777777777777";
const consentOf = (members: ReadonlyArray<LogicalProjectMember>): StandbyRearmConsent => ({
  chainId,
  members,
  afterMinutes: 5,
  fromEpoch: 0,
});

/** A, B and C as the verify run had them: A keeps, B joins, C joins later. */
const trio = async () => {
  const t = await legacyTrio();
  const a = t.membersOn(t.m4, t.kept.projectId).find((m) => m.environmentId === "m4")!;
  const b = t.membersOn(t.m3, t.joining.projectId).find((m) => m.environmentId === "m3")!;
  const c = t.third;
  const adoptOnB = (
    input: Partial<Parameters<ProjectLink.ProjectLink["Service"]["adoptMembers"]>[0]> = {},
  ) =>
    on(t.m3, (service) =>
      service.adoptMembers({
        projectId: t.joining.projectId,
        logicalProjectId: t.logicalProjectId,
        from: a,
        fromEpoch: 0,
        members: t.membersOn(t.m4, t.kept.projectId),
        ...input,
      }),
    );
  return { ...t, a, b, c, adoptOnB };
};

describe("member lists follow the coordinator", () => {
  it("starts from the reported state: B lists only A and itself, A and C list all three", async () => {
    const t = await trio();
    expect(keys(t.membersOn(t.m3, t.joining.projectId))).toEqual(keys([t.a, t.b]));
    expect(keys(t.membersOn(t.m4, t.kept.projectId))).toEqual(keys([t.a, t.b, t.c]));
    expect(keys(t.membersOn(t.m1, t.c.projectId))).toEqual(keys([t.a, t.b, t.c]));
  });

  it("B adopts [A,B,C] from its successor and keeps its own folder", async () => {
    const t = await trio();
    const ownBefore = t.membersOn(t.m3, t.joining.projectId).find((m) => m.environmentId === "m3");
    const revision = t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.revision;
    expect(await t.adoptOnB()).toEqual({ replayed: false, changed: true });
    const after = t.membersOn(t.m3, t.joining.projectId);
    expect(keys(after)).toEqual(keys([t.a, t.b, t.c]));
    expect(after.find((m) => m.environmentId === "m3")).toEqual(ownBefore);
    expect(t.m3.ownershipModes).toContain("sync-members");
    // The binding is untouched.
    expect(
      t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.coordinatorBinding,
    ).toMatchObject({ state: "transferred", successor: { environmentId: "m4" } });

    // A repeat changes nothing and writes nothing.
    const written = t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.revision;
    expect(written).toBeGreaterThan(revision ?? 0);
    expect(await t.adoptOnB()).toEqual({ replayed: true, changed: false });
    expect(t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.revision).toBe(written);
  });

  it("removes a member only on its successor's word", async () => {
    const t = await trio();
    await t.adoptOnB();
    // A unlinked C: B follows.
    expect(await t.adoptOnB({ members: [t.a, t.b] })).toMatchObject({ changed: true });
    expect(keys(t.membersOn(t.m3, t.joining.projectId))).toEqual(keys([t.a, t.b]));
  });

  it("never takes another machine's word that it coordinates one takeover later", async () => {
    const t = await trio();
    const before = t.m1.projects.get(t.c.projectId)!.workspaceSettings;
    // B claims epoch 1 and adds D; C gave way to A, not to B.
    const injected = await t.m1.fails(
      on(t.m1, (service) =>
        service.adoptMembers({
          projectId: t.c.projectId,
          logicalProjectId: t.logicalProjectId,
          from: t.b,
          fromEpoch: 1,
          members: [t.a, t.b, t.c, d],
        }),
      ),
    );
    expect(injected.code).toBe("not_coordinator");
    expect(t.m1.projects.get(t.c.projectId)!.workspaceSettings).toEqual(before);
  });

  it("takes additions, never removals, from the app's coordinator one takeover later", async () => {
    const t = await trio();
    // B took over at epoch 1; C still names A as the copy it gave way to.
    const onC = (members: ReadonlyArray<LogicalProjectMember>, fromEpoch = 1) =>
      on(t.m1, (service) =>
        service.adoptMembers({
          projectId: t.c.projectId,
          logicalProjectId: t.logicalProjectId,
          from: t.b,
          fromEpoch,
          members,
          viaApp: true,
        }),
      );
    expect(await onC([t.a, t.b, t.c, d])).toMatchObject({ changed: true });
    expect(keys(t.membersOn(t.m1, t.c.projectId))).toEqual(keys([t.a, t.b, t.c, d]));
    expect((await t.m1.fails(onC([t.a, t.b, t.c]))).code).toBe("invalid");
    // Not at C's own epoch (B is not its successor), and not two past it.
    expect((await t.m1.fails(onC([t.a, t.b, t.c, d], 0))).code).toBe("not_coordinator");
    expect((await t.m1.fails(onC([t.a, t.b, t.c, d], 2))).code).toBe("not_coordinator");
  });

  it("refuses a list it cannot trust and writes nothing", async () => {
    const t = await trio();
    const before = t.m3.projects.get(t.joining.projectId)!.workspaceSettings;
    const refused = async (
      input: Parameters<typeof t.adoptOnB>[0],
    ): Promise<ProjectLinkError["code"]> => (await t.m3.fails(t.adoptOnB(input))).code;
    const twin: LogicalProjectMember = {
      ...t.c,
      environmentId: t.b.environmentId,
      projectId: ProjectId.make("twin"),
    };
    expect(await refused({ fromEpoch: 0, from: t.b })).toBe("not_member");
    expect(await refused({ from: t.c })).toBe("not_member");
    expect(await refused({ members: [t.a, t.c] })).toBe("invalid");
    expect(await refused({ members: [t.b, t.c] })).toBe("invalid");
    expect(await refused({ members: [t.a, t.b, t.c, twin] })).toBe("invalid");
    expect(
      await refused({
        members: [t.a, { ...t.b, coordinatorThreadId: ThreadId.make("other-thread") }, t.c],
      }),
    ).toBe("conflict");
    expect(await refused({ logicalProjectId: "logical:other" })).toBe("not_linked");
    expect(t.m3.projects.get(t.joining.projectId)!.workspaceSettings).toEqual(before);
    // The coordinator itself never adopts through this path.
    expect(
      (
        await t.m4.fails(
          on(t.m4, (service) =>
            service.adoptMembers({
              projectId: t.kept.projectId,
              logicalProjectId: t.logicalProjectId,
              from: t.b,
              fromEpoch: 0,
              members: [t.a, t.b],
            }),
          ),
        )
      ).code,
    ).toBe("not_member");
  });

  it("refuses a personal assistant", async () => {
    const t = await trio();
    const copy = t.m3.projects.get(t.joining.projectId)!;
    t.m3.projects.set(t.joining.projectId, {
      ...copy,
      workspaceSettings: { ...copy.workspaceSettings!, kind: "personal" },
    });
    expect((await t.m3.fails(t.adoptOnB())).code).toBe("not_code_project");
  });

  it("adds the predecessor's extra members after a takeover, never one on this machine", async () => {
    const t = await trio();
    await on(t.m3, (service) =>
      service.takeover({
        operationId: "44444444-4444-4444-8444-444444444444",
        projectId: t.joining.projectId,
      }),
    );
    const twin: LogicalProjectMember = {
      ...t.c,
      environmentId: t.b.environmentId,
      projectId: ProjectId.make("twin"),
    };
    const add = (predecessor: LogicalProjectMember) =>
      on(t.m3, (service) =>
        service.addPredecessorMembers({
          projectId: t.joining.projectId,
          predecessor,
          members: [t.a, t.b, t.c, twin],
        }),
      );
    expect((await t.m3.fails(add(t.c))).code).toBe("invalid");
    expect(await add(t.a)).toEqual({ changed: true });
    expect(keys(t.membersOn(t.m3, t.joining.projectId))).toEqual(keys([t.a, t.b, t.c]));
    expect(t.m3.ownershipModes.at(-1)).toBe("link-member");
    expect(await add(t.a)).toEqual({ changed: false });
  });

  it("never lists again a member it unlinked after the takeover, from a late predecessor list", async () => {
    const t = await trio();
    await t.adoptOnB();
    await on(t.m3, (service) =>
      service.takeover({
        operationId: "44444444-4444-4444-8444-444444444444",
        projectId: t.joining.projectId,
      }),
    );
    // B unlinks C while A is still away.
    const removed = await on(t.m3, (service) =>
      service.unlink({
        side: "coordinator",
        operationId: "55555555-5555-4555-8555-555555555555",
        projectId: t.joining.projectId,
        member: t.c,
      }),
    );
    expect(removed.coordinatorBinding.removedMembers).toEqual([
      { environmentId: t.c.environmentId, projectId: t.c.projectId },
    ]);
    expect(
      t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.coordinatorBinding,
    ).toMatchObject({ state: "active", removedMembers: [{ environmentId: "m1" }] });
    // A returns and gives way with its stale list, which still names C (and D, new to B).
    expect(
      await on(t.m3, (service) =>
        service.addPredecessorMembers({
          projectId: t.joining.projectId,
          predecessor: t.a,
          members: [t.a, t.b, t.c, d],
        }),
      ),
    ).toEqual({ changed: true });
    expect(keys(t.membersOn(t.m3, t.joining.projectId))).toEqual(keys([t.a, t.b, d]));
    // Only C: a stale list alone changes nothing more.
    expect(
      await on(t.m3, (service) =>
        service.addPredecessorMembers({
          projectId: t.joining.projectId,
          predecessor: t.a,
          members: [t.a, t.b, t.c],
        }),
      ),
    ).toEqual({ changed: false });
  });

  it("an archived copy refuses a member list and writes nothing", async () => {
    const t = await trio();
    const copy = t.m3.projects.get(t.joining.projectId)!;
    t.m3.projects.set(t.joining.projectId, {
      ...copy,
      workspaceSettings: { ...copy.workspaceSettings!, archived: true },
    });
    const before = t.m3.projects.get(t.joining.projectId)!.workspaceSettings;
    expect((await t.m3.fails(t.adoptOnB())).code).toBe("archived");
    expect(t.m3.projects.get(t.joining.projectId)!.workspaceSettings).toEqual(before);
  });

  it("two concurrent syncs of one list write it once; the other replays", async () => {
    const t = await trio();
    const results = await Promise.all([t.adoptOnB(), t.adoptOnB()]);
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(t.m3.ownershipModes.filter((mode) => mode === "sync-members")).toHaveLength(1);
    expect(keys(t.membersOn(t.m3, t.joining.projectId))).toEqual(keys([t.a, t.b, t.c]));
  });
});

describe("re-arm consent on a copy that joined before a later member (verify regression)", () => {
  it("refuses [B,C] on B before the member sync and accepts it after", async () => {
    const t = await trio();
    const write = (target: Machine, projectId: string) =>
      on(target, (service) =>
        service.acceptStandby({
          projectId: ProjectId.make(projectId),
          logicalProjectId: t.logicalProjectId,
          rearm: consentOf([t.b, t.c]),
        }),
      );
    const refused = await t.m3.fails(write(t.m3, t.joining.projectId));
    expect(refused.detail).toBe("Every machine to re-arm is a member of this project.");
    expect(await write(t.m1, t.c.projectId)).toMatchObject({ rearm: { chainId } });

    // The coordinator's list reaches B (as the peer push or the app does), then the same consent.
    expect(await t.adoptOnB()).toMatchObject({ changed: true });
    expect(await write(t.m3, t.joining.projectId)).toMatchObject({ rearm: { chainId } });
    expect(t.m3.rearm.get(t.logicalProjectId)).toMatchObject({
      projectId: t.joining.projectId,
      consent: { members: [t.b, t.c] },
    });

    // C, once it took over, may arm B under that consent.
    const armed = await on(t.m3, (service) =>
      service.acceptStandbyFromPeer({
        logicalProjectId: t.logicalProjectId,
        callerEnvironmentId: t.c.environmentId,
        epoch: 1,
        chainId,
      }),
    );
    expect(armed).toMatchObject({ standby: { coordinator: { environmentId: "m1" }, epoch: 1 } });
  });

  it("refreshes from the coordinator, outside the lock, when a consent names an unknown member", async () => {
    const t = await trio();
    const result = await on(t.m3, (service) =>
      Effect.gen(function* () {
        const refreshed: string[] = [];
        yield* service.registerMembersSync({
          // As LinkedPeerSync would: read A's list over the peer route and adopt it.
          refresh: (projectId) =>
            service
              .adoptMembers({
                projectId,
                logicalProjectId: t.logicalProjectId,
                from: t.a,
                fromEpoch: 0,
                members: t.membersOn(t.m4, t.kept.projectId),
              })
              .pipe(
                Effect.tap(() => Effect.sync(() => refreshed.push(projectId))),
                Effect.ignore,
              ),
          expedite: () => Effect.void,
        });
        const accepted = yield* service.acceptStandby({
          projectId: t.joining.projectId,
          logicalProjectId: t.logicalProjectId,
          rearm: consentOf([t.b, t.c]),
        });
        return { accepted, refreshed };
      }),
    );
    expect(result.refreshed).toEqual([t.joining.projectId]);
    expect(result.accepted).toMatchObject({ rearm: { chainId } });
  });

  it("keeps the member error when the refresh learns nothing", async () => {
    const t = await trio();
    const refused = await t.m3.fails(
      on(t.m3, (service) =>
        service
          .registerMembersSync({ refresh: () => Effect.void, expedite: () => Effect.void })
          .pipe(
            Effect.andThen(
              service.acceptStandby({
                projectId: t.joining.projectId,
                logicalProjectId: t.logicalProjectId,
                rearm: consentOf([t.b, t.c]),
              }),
            ),
          ),
      ),
    );
    expect(refused.detail).toBe("Every machine to re-arm is a member of this project.");
  });
});

describe("helpers", () => {
  it("compares member sets regardless of order and folders", () => {
    const one: LogicalProjectMember = {
      environmentId: EnvironmentId.make("m1"),
      projectId: ProjectId.make("p1"),
      coordinatorThreadId: ThreadId.make("t1"),
    };
    const two = { ...one, environmentId: EnvironmentId.make("m2") };
    expect(sameMemberSet([one, two], [{ ...two, workspaceRoot: "/x" }, one])).toBe(true);
    expect(sameMemberSet([one], [one, two])).toBe(false);
    expect(sameMemberSet([one], [{ ...one, coordinatorThreadId: ThreadId.make("t2") }])).toBe(
      false,
    );
  });

  it("keeps the replica epoch window", () => {
    const successor: LogicalProjectMember = {
      environmentId: EnvironmentId.make("m4"),
      projectId: ProjectId.make("p4"),
      coordinatorThreadId: ThreadId.make("t4"),
    };
    const binding = { epoch: 3, state: "transferred" as const, successor };
    expect(coordinatorClaimWindow(binding, logicalProjectMemberKey(successor))).toEqual({
      isSuccessor: true,
      lowest: 3,
      highest: Number.MAX_SAFE_INTEGER,
    });
    expect(coordinatorClaimWindow(binding, "other")).toEqual({
      isSuccessor: false,
      lowest: 4,
      highest: 4,
    });
    expect(coordinatorClaimWindow({ epoch: 3, state: "transferred" }, "other")).toEqual({
      isSuccessor: false,
      lowest: 3,
      highest: 4,
    });
  });
});
