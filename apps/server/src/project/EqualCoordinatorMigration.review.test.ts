/**
 * The cases the review of equal coordinators asked for (1390 AC-35, AC-48,
 * EC2-04, EC2-09): linking with the release named in the fixture changes
 * neither end, a coordinator is no longer moved by a handoff's role write, and
 * a machine unlinked while a third was away leaves that one's list too.
 */
import {
  environmentRunsEqualCoordinators,
  type LogicalProjectMember,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  PINNED_RELEASE,
  PINNED_RELEASE_CAPABILITIES,
  pinnedReleaseAccept,
} from "./equalCoordinatorCompat.fixture.ts";
import {
  legacyPair,
  legacyTrio,
  machine,
  operationId,
  removeCheckouts,
  unlinkId,
} from "./ProjectLink.testkit.ts";
import { withoutCoordinatorMove } from "./EqualCoordinatorMigration.ts";
import * as ProjectService from "./ProjectService.ts";

afterEach(removeCheckouts);

type Machine = ReturnType<typeof machine>;
const settingsOf = (target: Machine, projectId: string) =>
  target.projects.get(projectId)!.workspaceSettings;

describe(`linking with ${PINNED_RELEASE} (EC2-04, EC2-09)`, () => {
  it("is pinned to the release before equal coordinators", () => {
    expect(PINNED_RELEASE).toBe("1.0.386");
    // That release links projects, and says nothing of equal coordinators.
    expect(PINNED_RELEASE_CAPABILITIES.projectLink).toBe(true);
    expect(environmentRunsEqualCoordinators(PINNED_RELEASE_CAPABILITIES)).toBe(false);
    expect(environmentRunsEqualCoordinators({ projectLink: true, equalCoordinators: true })).toBe(
      true,
    );
  });

  it("new kept, old joining: the release's accept would fence its coordinator", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({
        operationId,
        projectId: pair.kept.projectId,
        joining: pair.joining,
        equalCoordinators: true,
      }),
    );
    const old = pinnedReleaseAccept({
      operationId,
      kept: prepared.kept,
      coordinatorBinding: prepared.coordinatorBinding,
    });
    expect(old.coordinatorBinding.state).toBe("transferred");
    expect(old.role.kind).toBe("gave-way");
  });

  it("new kept, old joining: prepare refuses and the kept copy is not changed", async () => {
    const pair = legacyPair();
    const before = structuredClone(settingsOf(pair.m4, pair.kept.projectId));
    // A caller that did not check the joining end, as that release's window is.
    const refused = await pair.m4.fails(
      pair.m4.runUnchecked((service) =>
        service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
      ),
    );
    expect(refused.code).toBe("needs_update");
    expect(settingsOf(pair.m4, pair.kept.projectId)).toEqual(before);
    expect(settingsOf(pair.m4, pair.kept.projectId)?.logicalProject).toBeUndefined();
  });

  it("old kept, new joining: accept refuses and the joining copy is not changed", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({
        operationId,
        projectId: pair.kept.projectId,
        joining: pair.joining,
        equalCoordinators: true,
      }),
    );
    const before = structuredClone(settingsOf(pair.m3, pair.joining.projectId));
    // What that release's kept copy sends: the same link, without the word that it is equal.
    const refused = await pair.m3.fails(
      pair.m3.runUnchecked((service) =>
        service.accept({
          operationId,
          projectId: pair.joining.projectId,
          kept: prepared.kept,
          logicalProject: prepared.logicalProject,
          coordinatorBinding: prepared.coordinatorBinding,
          keptFingerprint: prepared.fingerprint,
        }),
      ),
    );
    expect(refused.code).toBe("needs_update");
    expect(settingsOf(pair.m3, pair.joining.projectId)).toEqual(before);
    expect(settingsOf(pair.m3, pair.joining.projectId)?.logicalProject).toBeUndefined();
  });
});

describe("a handoff no longer moves the coordinator (AC-35)", () => {
  it("refuses the role write of a folder copy saved before the upgrade", async () => {
    const pair = legacyPair();
    const target = pair.m4;
    const project = target.projects.get(pair.kept.projectId)!;
    const identity = {
      id: "logical:saved-copy",
      title: project.title,
      coordinatorId: "coordinator:logical:saved-copy",
      members: [pair.kept],
    };
    const before = structuredClone(project.workspaceSettings);
    for (const state of ["transferring", "transferred"] as const) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const projects = yield* ProjectService.ProjectService;
          return yield* projects.update({
            projectId: project.id,
            commandId: `logical-project-fence:saved-copy:${state}` as never,
            ownership: {
              mode: "handoff",
              expectedRevision: project.workspaceSettings?.revision ?? 0,
              logicalProject: identity,
              coordinatorBinding: {
                epoch: 0,
                state,
                operationId: "saved-copy",
                successor: pair.joining,
              },
            },
          });
        }).pipe(Effect.provide(target.layer)),
      );
      expect(exit._tag).toBe("Failure");
    }
    expect(settingsOf(target, pair.kept.projectId)).toEqual(before);
  });
});

describe("the window's handoff call (AC-35)", () => {
  const input = { projectId: "p" as never, operationId: "op" as never };

  it("refuses to publish a coordinator move before anything is prepared", async () => {
    let prepared = 0;
    const prepare = withoutCoordinatorMove(() => Effect.sync(() => ++prepared));
    const exit = await Effect.runPromiseExit(prepare({ ...input, publish: true }));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("runs its own coordinator");
    expect(prepared).toBe(0);
  });

  it("still reads what a handoff would carry", async () => {
    const prepare = withoutCoordinatorMove(() => Effect.succeed("preview"));
    expect(await Effect.runPromise(prepare({ ...input, publish: false }))).toBe("preview");
  });
});

describe("unlinking one of three machines (AC-35)", () => {
  it("a re-link outlives the old unlink a returning machine still remembers", async () => {
    const trio = await legacyTrio();
    const keyOf = (member: { environmentId: string; projectId: string }) =>
      `${member.environmentId}:${member.projectId}`;
    const bindingOn = (target: Machine, projectId: string) =>
      settingsOf(target, projectId)?.coordinatorBinding;
    /** One copy reads the other's list, with whom that copy unlinked and linked again. */
    const reads = (
      reader: { machine: Machine; member: LogicalProjectMember },
      other: { machine: Machine; member: LogicalProjectMember },
    ) =>
      reader.machine.run((service) =>
        service.adoptMembers({
          projectId: reader.member.projectId,
          logicalProjectId: trio.logicalProjectId,
          from: other.member,
          fromEpoch: 0,
          members: trio.membersOn(other.machine, other.member.projectId),
          removed: bindingOn(other.machine, other.member.projectId)?.removedMembers ?? [],
          relinked: bindingOn(other.machine, other.member.projectId)?.relinkedMembers ?? [],
        }),
      );
    type Copy = { machine: Machine; member: LogicalProjectMember };
    const m4: Copy = { machine: trio.m4, member: trio.kept };
    const m1: Copy = { machine: trio.m1, member: trio.third };
    const listed = (copy: Copy) => trio.membersOn(copy.machine, copy.member.projectId).map(keyOf);
    const unlinkOnM4 = (id: string) =>
      trio.m4.run((service) =>
        service.unlink({
          side: "coordinator",
          operationId: id,
          projectId: trio.kept.projectId,
          member: trio.joining,
        }),
      );
    await reads(m1, m4);
    // 1. The M4 unlinks the M3, and the M1 records that.
    await unlinkOnM4(unlinkId);
    await reads(m1, m4);
    expect(listed(m1)).not.toContain(keyOf(trio.joining));
    expect(bindingOn(trio.m1, trio.third.projectId)?.removedMembers?.map(keyOf)).toEqual([
      keyOf(trio.joining),
    ]);
    // 2. The M3 is linked again on the M4 while the M1 is away.
    await trio.m4.run((service) =>
      service.commit({
        operationId: "33333333-3333-4333-8333-333333333333",
        projectId: trio.kept.projectId,
        joining: trio.joining,
        notes: [],
      }),
    );
    expect(listed(m4)).toContain(keyOf(trio.joining));
    // 3. The M1 comes back still advertising the old unlink: the M4 keeps the new link.
    await reads(m4, m1);
    expect(listed(m4)).toContain(keyOf(trio.joining));
    // And the M1 takes the M3 back from the M4, whose link is newer than that unlink.
    await reads(m1, m4);
    expect(listed(m1)).toContain(keyOf(trio.joining));
    await reads(m4, m1);
    expect(listed(m4)).toContain(keyOf(trio.joining));
    // An unlink after the re-link still removes it everywhere.
    await unlinkOnM4("44444444-4444-4444-8444-444444444444");
    await reads(m1, m4);
    expect(listed(m1)).not.toContain(keyOf(trio.joining));
    await reads(m4, m1);
    expect(listed(m4)).not.toContain(keyOf(trio.joining));
  });

  it("the third machine drops the unlinked one when it reconnects", async () => {
    const trio = await legacyTrio();
    const keyOf = (member: { environmentId: string; projectId: string }) =>
      `${member.environmentId}:${member.projectId}`;
    // The M1 learned of the M3 before it went away.
    await trio.m1.run((service) =>
      service.adoptMembers({
        projectId: trio.third.projectId,
        logicalProjectId: trio.logicalProjectId,
        from: trio.kept,
        fromEpoch: 0,
        members: trio.membersOn(trio.m4, trio.kept.projectId),
      }),
    );
    expect(trio.membersOn(trio.m1, trio.third.projectId).map(keyOf)).toContain(keyOf(trio.joining));
    // Settings unlinks the M3 through the M4 while the M1 is away.
    await trio.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: unlinkId,
        projectId: trio.kept.projectId,
        member: trio.joining,
      }),
    );
    const kept = settingsOf(trio.m4, trio.kept.projectId)!;
    expect(kept.coordinatorBinding?.removedMembers?.map(keyOf)).toEqual([keyOf(trio.joining)]);
    // The M1 reconnects and reads the M4's list, with whom the M4 removed.
    await trio.m1.run((service) =>
      service.adoptMembers({
        projectId: trio.third.projectId,
        logicalProjectId: trio.logicalProjectId,
        from: trio.kept,
        fromEpoch: 0,
        members: kept.logicalProject!.members,
        removed: kept.coordinatorBinding?.removedMembers ?? [],
      }),
    );
    expect(trio.membersOn(trio.m1, trio.third.projectId).map(keyOf).toSorted()).toEqual(
      [keyOf(trio.kept), keyOf(trio.third)].toSorted(),
    );
    // It remembers the removal, so an older list never brings the M3 back.
    await trio.m1.run((service) =>
      service.adoptMembers({
        projectId: trio.third.projectId,
        logicalProjectId: trio.logicalProjectId,
        from: trio.kept,
        fromEpoch: 0,
        members: [trio.kept, trio.joining, trio.third],
      }),
    );
    expect(trio.membersOn(trio.m1, trio.third.projectId).map(keyOf)).not.toContain(
      keyOf(trio.joining),
    );
  });

  it("a member the other copy merely does not list is kept", async () => {
    const trio = await legacyTrio();
    const keyOf = (member: { environmentId: string; projectId: string }) =>
      `${member.environmentId}:${member.projectId}`;
    // The M3 still lists only the M4 and itself; the M4 lists all three.
    await trio.m4.run((service) =>
      service.adoptMembers({
        projectId: trio.kept.projectId,
        logicalProjectId: trio.logicalProjectId,
        from: trio.joining,
        fromEpoch: 0,
        members: trio.membersOn(trio.m3, trio.joining.projectId),
        removed: [],
      }),
    );
    expect(trio.membersOn(trio.m4, trio.kept.projectId).map(keyOf)).toContain(keyOf(trio.third));
  });
});
