import {
  EnvironmentId,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  ProjectId,
  type ProjectLinkError,
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

  it("B adds C from A's list, keeps its own folder and stays an active coordinator", async () => {
    const t = await trio();
    const ownBefore = t.membersOn(t.m3, t.joining.projectId).find((m) => m.environmentId === "m3");
    const bindingBefore = t.m3.projects.get(t.joining.projectId)!.workspaceSettings!
      .coordinatorBinding;
    expect(bindingBefore?.state).toBe("active");
    const revision = t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.revision;
    expect(await t.adoptOnB()).toEqual({ replayed: false, changed: true });
    const after = t.membersOn(t.m3, t.joining.projectId);
    expect(keys(after)).toEqual(keys([t.a, t.b, t.c]));
    expect(after.find((m) => m.environmentId === "m3")).toEqual(ownBefore);
    expect(t.m3.ownershipModes).toContain("sync-members");
    // The binding is untouched.
    expect(t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.coordinatorBinding).toEqual(
      bindingBefore,
    );

    // A repeat changes nothing and writes nothing.
    const written = t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.revision;
    expect(written).toBeGreaterThan(revision ?? 0);
    expect(await t.adoptOnB()).toEqual({ replayed: true, changed: false });
    expect(t.m3.projects.get(t.joining.projectId)!.workspaceSettings!.revision).toBe(written);
  });

  it("never removes a member on another copy's word: each machine unlinks for itself", async () => {
    const t = await trio();
    await t.adoptOnB();
    // A unlinked C. B still lists C until B unlinks it too.
    expect(await t.adoptOnB({ members: [t.a, t.b] })).toEqual({ replayed: true, changed: false });
    expect(keys(t.membersOn(t.m3, t.joining.projectId))).toEqual(keys([t.a, t.b, t.c]));
  });

  it("adds from any listed copy, whatever epoch it names, since none coordinates the others", async () => {
    const t = await trio();
    // C takes D from B, a copy it did not join through.
    const result = await on(t.m1, (service) =>
      service.adoptMembers({
        projectId: t.c.projectId,
        logicalProjectId: t.logicalProjectId,
        from: t.b,
        fromEpoch: 7,
        members: [t.a, t.b, t.c, d],
      }),
    );
    expect(result).toEqual({ replayed: false, changed: true });
    expect(keys(t.membersOn(t.m1, t.c.projectId))).toEqual(keys([t.a, t.b, t.c, d]));
  });

  it("never lists again a member this copy unlinked, from another copy's older list", async () => {
    const t = await trio();
    await on(t.m4, (service) =>
      service.unlink({
        side: "coordinator",
        operationId: "88888888-8888-4888-8888-888888888888",
        projectId: t.kept.projectId,
        member: t.c,
      }),
    );
    expect(keys(t.membersOn(t.m4, t.kept.projectId))).toEqual(keys([t.a, t.b]));
    // B still lists C, and offers its list.
    await t.adoptOnB();
    const fromB = await on(t.m4, (service) =>
      service.adoptMembers({
        projectId: t.kept.projectId,
        logicalProjectId: t.logicalProjectId,
        from: t.b,
        fromEpoch: 0,
        members: t.membersOn(t.m3, t.joining.projectId),
      }),
    );
    expect(fromB).toEqual({ replayed: true, changed: false });
    expect(keys(t.membersOn(t.m4, t.kept.projectId))).toEqual(keys([t.a, t.b]));
  });

  it("refuses a list from a copy it does not list, and another project's, and writes nothing", async () => {
    const t = await trio();
    const before = t.m3.projects.get(t.joining.projectId)!.workspaceSettings;
    const refused = async (
      input: Partial<Parameters<ProjectLink.ProjectLink["Service"]["adoptMembers"]>[0]>,
    ) => (await t.m3.fails(t.adoptOnB(input))).code;
    // C is not listed on B yet, a stranger never is, and B does not take its own word.
    expect(await refused({ from: t.c })).toBe("not_member");
    expect(await refused({ from: d })).toBe("not_member");
    expect(await refused({ from: t.b })).toBe("not_member");
    expect(await refused({ logicalProjectId: "logical:other" })).toBe("not_linked");
    expect(t.m3.projects.get(t.joining.projectId)!.workspaceSettings).toEqual(before);
    // Another copy on this machine is never added.
    const sameMachine = { ...d, environmentId: t.b.environmentId };
    expect(await t.adoptOnB({ members: [t.a, t.b, sameMachine] })).toEqual({
      replayed: true,
      changed: false,
    });
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
