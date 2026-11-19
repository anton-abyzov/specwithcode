import {
  coordinatorOwnsRoutines,
  type LogicalProject,
  type ProjectCoordinatorBinding,
  ProjectCoordinatorBinding as CurrentBinding,
  type ProjectLinkError,
  projectCoordinatorIsFenced,
  projectExecutionIsFenced,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { coordinatorRoleOf } from "./CoordinatorRole.ts";
import {
  EQUAL_COORDINATORS_DETAIL,
  equalCoordinatorBinding,
  isEqualCoordinatorBinding,
  joinedBinding,
  migrate,
} from "./EqualCoordinatorMigration.ts";
import {
  PINNED_RELEASE,
  PinnedReleaseBinding,
  PinnedReleaseSupersedeRequest,
} from "./equalCoordinatorCompat.fixture.ts";
import {
  legacyPair,
  link,
  machine,
  operationId,
  removeCheckouts,
  unlinkId,
} from "./ProjectLink.testkit.ts";
import * as ProjectService from "./ProjectService.ts";

afterEach(removeCheckouts);

type Machine = ReturnType<typeof machine>;

const settingsOf = (target: Machine, projectId: string) =>
  target.projects.get(projectId)!.workspaceSettings!;
const bindingOf = (target: Machine, projectId: string) =>
  settingsOf(target, projectId).coordinatorBinding;

/** Rewrites a copy's binding as a release from before equal coordinators left it. */
const leave = (target: Machine, projectId: string, binding: ProjectCoordinatorBinding) => {
  const project = target.projects.get(projectId)!;
  target.projects.set(projectId, {
    ...project,
    workspaceSettings: { ...project.workspaceSettings!, coordinatorBinding: binding },
  });
};

const runMigration = (target: Machine) =>
  Effect.runPromise(migrate([...target.projects.values()]).pipe(Effect.provide(target.layer)));

/** Typing on a machine reaches that machine's own coordinator: active, and its thread unfenced. */
const typesToOwnCoordinator = (target: Machine, projectId: string) => {
  const project = target.projects.get(projectId)!;
  const coordinatorThread = target.member(projectId).coordinatorThreadId;
  return (
    coordinatorRoleOf(project).active &&
    !projectCoordinatorIsFenced(project.workspaceSettings) &&
    !projectExecutionIsFenced(project.workspaceSettings, projectId, coordinatorThread) &&
    // A worker thread of the same copy runs too.
    !projectExecutionIsFenced(project.workspaceSettings, projectId, "thread:worker")
  );
};

/**
 * A linked pair as the previous release left it: the kept copy active, the
 * joined copy `transferred`, following the kept one.
 */
const releasedPair = async () => {
  const pair = legacyPair();
  const { prepared } = await link(pair);
  leave(pair.m3, pair.joining.projectId, {
    epoch: 0,
    state: "transferred",
    operationId,
    successor: pair.kept,
  });
  return { ...pair, identity: prepared.logicalProject as LogicalProject };
};

/** The superseding binding a peer on the previous release holds after it took over. */
const supersedingBinding = (predecessor: ProjectCoordinatorBinding["predecessor"], epoch = 5) =>
  ({
    epoch,
    state: "active",
    operationId: "takeover-from-the-previous-release",
    predecessor,
    takenOverAt: "2026-11-19T10:00:00.000Z",
    takenOverBy: "person",
  }) satisfies ProjectCoordinatorBinding;

describe("equal coordinators: link acceptance (AC-35)", () => {
  it("writes active on the joining copy, beside the kept copy's own active coordinator", async () => {
    const pair = legacyPair();
    const { accepted } = await link(pair);
    expect(accepted.coordinatorBinding).toEqual({
      epoch: 0,
      state: "active",
      operationId,
      routineOwner: false,
    });
    expect(bindingOf(pair.m3, pair.joining.projectId)).toEqual({
      epoch: 0,
      state: "active",
      operationId,
      routineOwner: false,
    });
    expect(bindingOf(pair.m4, pair.kept.projectId)).toEqual({ epoch: 0, state: "active" });
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
    // Typing on the freshly added machine goes to its own coordinator.
    expect(typesToOwnCoordinator(pair.m3, pair.joining.projectId)).toBe(true);
    expect(typesToOwnCoordinator(pair.m4, pair.kept.projectId)).toBe(true);
  });

  it("replays a retried acceptance and keeps the joining copy's coordinator thread", async () => {
    const pair = legacyPair();
    await link(pair);
    const again = await link(pair);
    expect(again.accepted.replayed).toBe(true);
    expect(again.accepted.member.coordinatorThreadId).toBe(pair.joining.coordinatorThreadId);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
  });

  it("lets the Settings unlink take any member out, with its own coordinator", async () => {
    const pair = legacyPair();
    const { prepared } = await link(pair);
    const left = await pair.m3.run((service) =>
      service.unlink({
        operationId: unlinkId,
        projectId: pair.joining.projectId,
        side: "member",
        notes: [],
      }),
    );
    expect(left.coordinatorBinding).toMatchObject({ epoch: 0, state: "active" });
    expect(left.logicalProject.id).not.toBe(prepared.logicalProject.id);
    expect(left.logicalProject.members).toHaveLength(1);
  });
});

describe("equal coordinators: the migration (AC-35, EC2-07)", () => {
  it("turns a transferred member into an active local coordinator and keeps everything else", async () => {
    const pair = await releasedPair();
    const before = settingsOf(pair.m3, pair.joining.projectId);
    expect(typesToOwnCoordinator(pair.m3, pair.joining.projectId)).toBe(false);

    const report = await runMigration(pair.m3);

    expect(report.migrated).toEqual([
      { projectId: pair.joining.projectId, from: "transferred", retiredOperationId: null },
    ]);
    expect(report.failed).toEqual([]);
    const after = settingsOf(pair.m3, pair.joining.projectId);
    expect(after.coordinatorBinding).toEqual({
      epoch: 0,
      state: "active",
      operationId,
      routineOwner: false,
    });
    // Identity, the member list and this copy's own coordinator thread are untouched.
    expect(after.logicalProject).toEqual(before.logicalProject);
    expect(pair.m3.ownershipModes.at(-1)).toBe("equal-coordinators");
    expect(typesToOwnCoordinator(pair.m3, pair.joining.projectId)).toBe(true);
  });

  it("leaves an already equal coordinator alone and writes nothing on a second start", async () => {
    const pair = await releasedPair();
    await runMigration(pair.m3);
    const writes = pair.m3.ownershipModes.length;
    const again = await runMigration(pair.m3);
    expect(again.migrated).toEqual([]);
    expect(pair.m3.ownershipModes).toHaveLength(writes);
    // The kept copy never needed one.
    const kept = await runMigration(pair.m4);
    expect(kept.migrated).toEqual([]);
    expect(bindingOf(pair.m4, pair.kept.projectId)).toEqual({ epoch: 0, state: "active" });
  });

  it("ends a role operation that was under way, and a late write under it never fences the copy", async () => {
    const pair = await releasedPair();
    // The kept copy was moving its coordinator to the other machine when it was updated.
    leave(pair.m4, pair.kept.projectId, {
      epoch: 2,
      state: "transferring",
      operationId: "role-move",
      successor: pair.joining,
    });
    const report = await runMigration(pair.m4);
    expect(report.migrated).toEqual([
      { projectId: pair.kept.projectId, from: "transferring", retiredOperationId: "role-move" },
    ]);
    const migrated = bindingOf(pair.m4, pair.kept.projectId)!;
    expect(migrated).toEqual({
      epoch: 2,
      state: "active",
      retiredOperationIds: ["role-move"],
      routineOwner: false,
    });
    expect(typesToOwnCoordinator(pair.m4, pair.kept.projectId)).toBe(true);

    // The old operation retries its acknowledgement after the restart.
    const late = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const project = pair.m4.projects.get(pair.kept.projectId)!;
        return yield* projects.update({
          projectId: project.id,
          commandId: "late-role-write" as never,
          ownership: {
            mode: "handoff",
            expectedRevision: project.workspaceSettings!.revision ?? 0,
            logicalProject: project.workspaceSettings!.logicalProject!,
            coordinatorBinding: {
              epoch: 2,
              state: "transferred",
              operationId: "role-move",
              successor: pair.joining,
            },
          },
        });
      }).pipe(Effect.provide(pair.m4.layer)),
    );
    expect(late._tag).toBe("Failure");
    expect(JSON.stringify(late)).toContain("ended when every machine got its own coordinator");
    expect(bindingOf(pair.m4, pair.kept.projectId)).toEqual(migrated);
  });

  it("clears the standby choice, standby records and re-arm consents, and only those", async () => {
    const pair = await releasedPair();
    leave(pair.m4, pair.kept.projectId, {
      epoch: 1,
      state: "active",
      standby: { member: pair.joining, afterMinutes: 5, enabledAt: "2026-11-01T00:00:00.000Z" },
    });
    pair.m3.standby.set(pair.identity.id, {
      logicalProjectId: pair.identity.id,
    } as never);
    await Effect.runPromise(
      pair.m3.rearmStore
        .modify(pair.identity.id, () => ({
          logicalProjectId: pair.identity.id,
          projectId: pair.joining.projectId,
          consent: null,
          consentUpdatedAt: null,
          run: null,
        }))
        .pipe(Effect.orDie),
    );

    const kept = await runMigration(pair.m4);
    const joined = await runMigration(pair.m3);

    expect(bindingOf(pair.m4, pair.kept.projectId)).toEqual({
      epoch: 1,
      state: "active",
      routineOwner: false,
    });
    expect(kept.migrated[0]?.from).toBe("active");
    expect(joined.standbyRecordsCleared).toBe(1);
    expect(joined.rearmEntriesCleared).toBe(1);
    expect(pair.m3.standby.size).toBe(0);
    expect(pair.m3.rearm.size).toBe(0);
    // Nothing but the binding was written: no thread, hold or member changed.
    expect(pair.m3.ownershipModes.filter((mode) => mode === "equal-coordinators")).toHaveLength(1);
  });

  it("maps every binding a release could have left to an equal one", () => {
    const member = machine("m9").member("p");
    const cases: ProjectCoordinatorBinding[] = [
      { epoch: 0, state: "active" },
      { epoch: 4, state: "transferred", operationId: "a", successor: member },
      {
        epoch: 4,
        state: "transferred",
        operationId: "a",
        successor: member,
        takenOverAt: "2026-11-01T00:00:00.000Z",
      },
      { epoch: 4, state: "transferring", operationId: "b", successor: member },
      { epoch: 4, state: "transferring" },
      {
        epoch: 7,
        state: "active",
        operationId: "c",
        predecessor: member,
        takenOverAt: "2026-11-01T00:00:00.000Z",
        takenOverBy: "auto",
      },
    ];
    for (const binding of cases) {
      const equal = equalCoordinatorBinding(binding);
      expect(isEqualCoordinatorBinding(equal), JSON.stringify(binding)).toBe(true);
      expect(equal.epoch).toBe(binding.epoch);
      expect(equalCoordinatorBinding(equal)).toEqual(equal);
    }
    expect(equalCoordinatorBinding(cases[3])).toEqual({
      epoch: 4,
      state: "active",
      retiredOperationIds: ["b"],
      routineOwner: false,
    });
  });

  it("leaves one owner of the project's routines: the copy that was it before (AC-45)", () => {
    const member = machine("m9").member("p");
    const owns = (binding: ProjectCoordinatorBinding) =>
      coordinatorOwnsRoutines(equalCoordinatorBinding(binding));
    // The project's first coordinator, and one that was handed the role or took it over.
    expect(owns({ epoch: 0, state: "active" })).toBe(true);
    expect(owns({ epoch: 3, state: "active", operationId: "c", predecessor: member })).toBe(true);
    // A copy that followed another machine, was moving, or was started beside the first.
    expect(owns({ epoch: 0, state: "transferred", operationId: "a", successor: member })).toBe(
      false,
    );
    expect(owns({ epoch: 0, state: "transferring", operationId: "b", successor: member })).toBe(
      false,
    );
    expect(owns({ epoch: 2, state: "active" })).toBe(false);
    // A copy that joins after the update is not the owner either.
    expect(coordinatorOwnsRoutines(joinedBinding("link-1", 0))).toBe(false);
    // Migrating twice never changes the answer.
    const once = equalCoordinatorBinding({ epoch: 3, state: "active", predecessor: member });
    expect(equalCoordinatorBinding(once)).toEqual(once);
    expect(coordinatorOwnsRoutines(once)).toBe(true);
  });
});

describe("equal coordinators: retired role changes (AC-35)", () => {
  const refusal = async (attempt: Promise<unknown>, target: Machine) =>
    (await target.fails(attempt)) as ProjectLinkError;

  it("does not obey an old peer that reconnects with a superseding binding, on a migrated member", async () => {
    const pair = await releasedPair();
    await runMigration(pair.m3);
    const before = settingsOf(pair.m3, pair.joining.projectId);
    const error = await refusal(
      pair.m3.run((service) =>
        service.supersede({
          projectId: pair.joining.projectId,
          logicalProjectId: pair.identity.id,
          successor: pair.kept,
          coordinatorBinding: supersedingBinding(pair.joining),
        }),
      ),
      pair.m3,
    );
    expect(error.code).toBe("superseded_conflict");
    expect(error.detail).toBe(EQUAL_COORDINATORS_DETAIL);
    expect(settingsOf(pair.m3, pair.joining.projectId)).toEqual(before);
    expect(typesToOwnCoordinator(pair.m3, pair.joining.projectId)).toBe(true);
  });

  it("does not obey it on a freshly added member either, nor on the kept copy", async () => {
    const pair = legacyPair();
    const { prepared } = await link(pair);
    for (const [target, self, other] of [
      [pair.m3, pair.joining, pair.kept],
      [pair.m4, pair.kept, pair.joining],
    ] as const) {
      const before = settingsOf(target, self.projectId);
      const error = await refusal(
        target.run((service) =>
          service.supersede({
            projectId: self.projectId,
            logicalProjectId: prepared.logicalProject.id,
            successor: other,
            coordinatorBinding: supersedingBinding(self),
          }),
        ),
        target,
      );
      expect(error.code).toBe("superseded_conflict");
      expect(settingsOf(target, self.projectId)).toEqual(before);
      expect(typesToOwnCoordinator(target, self.projectId)).toBe(true);
    }
  });

  it("refuses a takeover, a new standby and a planned handover", async () => {
    const pair = legacyPair();
    await link(pair);
    const attempts: Array<Promise<unknown>> = [
      pair.m3.run((service) =>
        service.takeover({ operationId: "t", projectId: pair.joining.projectId }),
      ),
      pair.m4.run((service) =>
        service.setStandby({
          operationId: "s",
          projectId: pair.kept.projectId,
          standby: { member: pair.joining, afterMinutes: 5 },
        } as never),
      ),
      pair.m4.run((service) =>
        service.plannedGiveWay({
          projectId: pair.kept.projectId,
          successorEnvironmentId: pair.m3.environmentId,
        } as never),
      ),
      pair.m3.run((service) =>
        service.plannedTakeover({ projectId: pair.joining.projectId } as never),
      ),
    ];
    for (const attempt of attempts) {
      const error = await refusal(attempt, pair.m3);
      expect(error.detail).toBe(EQUAL_COORDINATORS_DETAIL);
    }
    expect(bindingOf(pair.m3, pair.joining.projectId)?.state).toBe("active");
    expect(bindingOf(pair.m4, pair.kept.projectId)).toEqual({ epoch: 0, state: "active" });
  });
});

/**
 * EC2-09: both directions against the release named in the fixture. The
 * fixture holds that release's wire shapes and its list of final refusals,
 * copied from its tag.
 */
describe(`equal coordinators: compatibility with ${PINNED_RELEASE} (EC2-09)`, () => {
  const decodeOld = Schema.decodeUnknownSync(PinnedReleaseBinding);
  const decodeNew = Schema.decodeUnknownSync(CurrentBinding);

  it("new to old: every binding this build writes is one the release reads", async () => {
    const pair = await releasedPair();
    leave(pair.m4, pair.kept.projectId, {
      epoch: 2,
      state: "transferring",
      operationId: "role-move",
      successor: pair.joining,
    });
    await runMigration(pair.m4);
    await runMigration(pair.m3);
    const fresh = legacyPair();
    await link(fresh);
    const written = [
      bindingOf(pair.m4, pair.kept.projectId),
      bindingOf(pair.m3, pair.joining.projectId),
      bindingOf(fresh.m3, fresh.joining.projectId),
    ];
    for (const binding of written) {
      const read = decodeOld(JSON.parse(JSON.stringify(binding)));
      // The release sees an active coordinator at the same epoch, following nobody.
      expect(read.state).toBe("active");
      expect(read.epoch).toBe(binding!.epoch);
      expect(read.successor).toBeUndefined();
      // The field it does not know is dropped, not refused.
      expect("retiredOperationIds" in read).toBe(false);
    }
  });

  it("new to old: a copy on the release still joins a kept copy on this build", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    // The release's accept requires an active kept binding it can read.
    expect(decodeOld(JSON.parse(JSON.stringify(prepared.coordinatorBinding))).state).toBe("active");
    // It then joins as that release does: transferred, naming this copy as successor.
    const committed = await pair.m4.run((service) =>
      service.commit({
        operationId,
        projectId: pair.kept.projectId,
        joining: pair.joining,
        notes: [],
      }),
    );
    expect(committed.logicalProject.members).toEqual([
      pair.kept,
      // The accept of that release counts no links: the entry is named and counts as the oldest.
      { ...pair.joining, linkId: operationId },
    ]);
    expect(typesToOwnCoordinator(pair.m4, pair.kept.projectId)).toBe(true);
  });

  it("old to new: the release's bindings are read, and its kept copy is joined with an active binding", async () => {
    const member = machine("old").member("p");
    for (const binding of [
      { epoch: 3, state: "transferred", operationId: "x", successor: member },
      { epoch: 3, state: "transferring", operationId: "x", successor: member },
      supersedingBinding(member),
    ])
      expect(decodeNew(decodeOld(binding)).state).toBe(binding.state);
    // The release prepared the link; this build accepts it and stays active.
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    const accepted = await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: decodeNew(
          decodeOld(JSON.parse(JSON.stringify(prepared.coordinatorBinding))),
        ),
        keptFingerprint: prepared.fingerprint,
      }),
    );
    expect(accepted.coordinatorBinding.state).toBe("active");
  });

  it("old to new: the release's supersede request is read and refused, before and after a restart", async () => {
    const pair = await releasedPair();
    await runMigration(pair.m3);
    // The request exactly as the release's peer sync sends it after a takeover there.
    const request = Schema.decodeUnknownSync(PinnedReleaseSupersedeRequest)({
      protocolVersion: 1,
      logicalProjectId: pair.identity.id,
      projectId: pair.joining.projectId,
      successor: pair.kept,
      coordinatorBinding: supersedingBinding(pair.joining),
    });
    expect(request.successor).toEqual(pair.kept);
    const error = (await pair.m3.fails(
      pair.m3.run((service) =>
        service.supersede({
          projectId: pair.joining.projectId,
          logicalProjectId: request.logicalProjectId,
          // The successor the request names, as this build's own member type.
          successor: pair.kept,
          coordinatorBinding: decodeNew(request.coordinatorBinding),
        }),
      ),
    )) as ProjectLinkError;
    expect(error.code).toBe("superseded_conflict");
    expect(bindingOf(pair.m3, pair.joining.projectId)).toEqual({
      epoch: 0,
      state: "active",
      operationId,
      routineOwner: false,
    });
    // Typing on the formerly transferred member still goes to its own coordinator.
    expect(typesToOwnCoordinator(pair.m3, pair.joining.projectId)).toBe(true);
    // And after a restart, with the old peer still retrying.
    const restarted = await runMigration(pair.m3);
    expect(restarted.migrated).toEqual([]);
    expect(typesToOwnCoordinator(pair.m3, pair.joining.projectId)).toBe(true);
  });
});
