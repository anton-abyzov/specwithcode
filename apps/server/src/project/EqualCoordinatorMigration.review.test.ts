/**
 * The cases the review of equal coordinators asked for (1390 AC-35, AC-48,
 * EC2-04, EC2-09): linking with the release named in the fixture changes
 * neither end, a coordinator is no longer moved by a handoff's role write, and
 * a machine unlinked while a third was away leaves that one's list too.
 */
import { environmentRunsEqualCoordinators } from "@specweave-studio/contracts";
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
      pair.m4.run((service) =>
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
      pair.m3.run((service) =>
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

describe("unlinking one of three machines (AC-35)", () => {
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
    expect(trio.membersOn(trio.m1, trio.third.projectId).map(keyOf)).toContain(
      keyOf(trio.joining),
    );
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
