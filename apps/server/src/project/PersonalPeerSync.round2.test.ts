/**
 * Review round 2 for linked personal assistant sync (1448): stamps read as ISO
 * times, unknown icon kinds over the wire, removals copied as the peer wrote
 * them and ended by a later link, a seat that left (C1), and the hooks that
 * write all of it.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  ProjectId,
  type ProjectWorkspaceSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { ProjectUpdateInput } from "./ProjectService.ts";
import * as Schema from "effect/Schema";

import type * as WorkGrants from "../fleet/WorkGrants.ts";
import { LinkedPersonalSettings, UNKNOWN_PEER_ICON } from "../handoff/linkedSyncWire.ts";
import { ownershipRejection } from "../orchestration-v2/ProjectCommands.ts";
import { PERSONAL_SEAT_LEFT_MESSAGE, PERSONAL_SEAT_REMOVED_MESSAGE } from "./LinkedPeerRoute.ts";
import {
  computeLeftPeerPatch,
  computePersonalRemovalPatch,
  computePersonalSettingsPatch,
  parseSettingsStamp,
  personalPeerAllowed,
  personalPeerSyncDeps,
  unlinkedPersonalIdentity,
} from "./PersonalPeerSync.ts";

const seat = (name: string): LogicalProjectMember => {
  const projectId = ProjectId.make(`proj-personal-${name}`);
  return {
    environmentId: EnvironmentId.make(`env-${name}`),
    projectId,
    coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
  };
};
const [selfSeat, peerSeat, thirdSeat] = [seat("a"), seat("b"), seat("c")];
const SELF = selfSeat.environmentId;

const identityOf = (members: ReadonlyArray<LogicalProjectMember>): LogicalProject => ({
  id: "logical:personal",
  title: "Percy",
  coordinatorId: selfSeat.coordinatorThreadId,
  members,
});

const makeProject = (settings: Partial<ProjectWorkspaceSettings> = {}): Project => ({
  id: selfSeat.projectId,
  title: "Percy",
  workspaceRoot: "/tmp/personal-a",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  faviconPath: null,
  projectIcon: { kind: "lucide", name: "concierge-bell", color: "violet" },
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    kind: "personal",
    revision: 7,
    instructions: "Keep replies short.",
    ...settings,
  },
});

const linked = (
  members: ReadonlyArray<LogicalProjectMember>,
  binding?: ProjectCoordinatorBinding,
) =>
  makeProject({
    logicalProject: identityOf(members),
    ...(binding === undefined ? {} : { coordinatorBinding: binding }),
  });

const peerSettings = (overrides: Partial<LinkedPersonalSettings> = {}): LinkedPersonalSettings => ({
  updatedAt: "2026-11-22T11:00:00.000Z",
  title: "Percy",
  instructions: "Keep replies short.",
  icon: { kind: "lucide", name: "concierge-bell", color: "violet" },
  repositoryUrls: [],
  ...overrides,
});

describe("shared-settings stamps", () => {
  it("reads only ISO date-times", () => {
    assert.strictEqual(
      parseSettingsStamp("2026-11-22T10:00:00.000Z"),
      Date.parse("2026-11-22T10:00:00.000Z"),
    );
    for (const bad of ["z", "", "2026", "tomorrow", "9999-99-99T99:99", null, undefined])
      assert.strictEqual(parseSettingsStamp(bad), null);
  });

  it("never lets a peer stamp that is not ISO win, though it sorts after every real one", () => {
    const project = makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });
    assert.strictEqual(
      computePersonalSettingsPatch(project, peerSettings({ updatedAt: "z", title: "Other" })),
      null,
    );
    assert.strictEqual(
      computePersonalSettingsPatch(makeProject(), peerSettings({ updatedAt: "z", title: "Other" })),
      null,
    );
  });

  it("compares times, not spellings: the same instant changes nothing", () => {
    const project = makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });
    // As strings "...00Z" sorts after "...00.000Z"; as times they are equal.
    assert.strictEqual(
      computePersonalSettingsPatch(
        project,
        peerSettings({ updatedAt: "2026-11-22T10:00:00Z", title: "Other" }),
      ),
      null,
    );
    // An earlier time written with an offset sorts after as a string, and still loses.
    assert.strictEqual(
      computePersonalSettingsPatch(
        project,
        peerSettings({ updatedAt: "2026-11-22T11:30:00+02:00", title: "Other" }),
      ),
      null,
    );
  });

  it("takes a valid peer stamp over a local one that is not ISO", () => {
    const project = makeProject({ sharedSettingsUpdatedAt: "garbage" });
    assert.deepStrictEqual(
      computePersonalSettingsPatch(project, peerSettings({ title: "Jarvis" })),
      {
        stamp: "2026-11-22T11:00:00.000Z",
        title: "Jarvis",
      },
    );
  });
});

describe("peer icons over the wire", () => {
  const decode = Schema.decodeUnknownSync(LinkedPersonalSettings);
  const encode = Schema.encodeSync(LinkedPersonalSettings);
  const stamped = () => makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });

  it("decodes a newer kind as unknown, and the seat keeps its icon", () => {
    const decoded = decode({ ...peerSettings(), icon: { kind: "hologram", shape: "owl" } });
    assert.strictEqual(decoded.icon, UNKNOWN_PEER_ICON);
    assert.deepStrictEqual(computePersonalSettingsPatch(stamped(), decoded), {
      stamp: "2026-11-22T11:00:00.000Z",
    });
  });

  it("still clears the icon for a literal null", () => {
    const decoded = decode({ ...peerSettings(), icon: null });
    assert.isNull(decoded.icon);
    assert.deepStrictEqual(computePersonalSettingsPatch(stamped(), decoded), {
      stamp: "2026-11-22T11:00:00.000Z",
      projectIcon: null,
    });
  });

  it("reads known kinds and legacy monograms", () => {
    assert.deepStrictEqual(
      decode({ ...peerSettings(), icon: { kind: "emoji", emoji: "🦉" } }).icon,
      {
        kind: "emoji",
        emoji: "🦉",
      },
    );
    assert.deepStrictEqual(
      decode({
        ...peerSettings(),
        icon: { kind: "lucide", name: "folder", color: "blue", monogramText: "PA" },
      }).icon,
      { kind: "monogram", text: "PA", color: "blue" },
    );
  });

  it("sends the icon itself, as before", () => {
    const settings = peerSettings();
    assert.deepStrictEqual(encode(settings).icon, settings.icon);
    assert.isNull(encode(peerSettings({ icon: null })).icon);
  });
});

describe("computePersonalRemovalPatch, round 2", () => {
  const REMOVED_AT = "2026-11-20T09:00:00.000Z";
  const removal = (member: LogicalProjectMember, extra: Record<string, unknown> = {}) => ({
    environmentId: member.environmentId,
    projectId: member.projectId,
    removedAt: REMOVED_AT,
    ...extra,
  });
  const relinked = (member: LogicalProjectMember, linkedAt: string) => ({
    environmentId: member.environmentId,
    projectId: member.projectId,
    linkedAt,
  });

  it("copies the peer's removal entry as it is, link id and generation included", () => {
    const entry = removal(thirdSeat, { linkId: "op-1", generation: 2 });
    const patch = computePersonalRemovalPatch(linked([selfSeat, peerSeat, thirdSeat]), SELF, {
      epoch: 0,
      state: "active",
      removedMembers: [entry],
    });
    assert.strictEqual(patch?.kind, "remove");
    if (patch?.kind !== "remove") return;
    assert.deepStrictEqual(patch.coordinatorBinding.removedMembers, [entry]);
  });

  it("never writes removedAt: undefined for an undated peer removal", () => {
    const entry = { environmentId: thirdSeat.environmentId, projectId: thirdSeat.projectId };
    const patch = computePersonalRemovalPatch(linked([selfSeat, peerSeat, thirdSeat]), SELF, {
      epoch: 0,
      state: "active",
      removedMembers: [entry],
    });
    if (patch?.kind !== "remove") throw new Error("expected a remove patch");
    const [written] = patch.coordinatorBinding.removedMembers!;
    assert.deepStrictEqual(written, entry);
    assert.isFalse(Object.hasOwn(written!, "removedAt"));
  });

  it("ignores a removal of this seat older than its own later link", () => {
    const project = linked([selfSeat, peerSeat], {
      epoch: 0,
      state: "active",
      relinkedMembers: [relinked(selfSeat, "2026-11-21T09:00:00.000Z")],
    });
    assert.isNull(
      computePersonalRemovalPatch(project, SELF, {
        epoch: 0,
        state: "active",
        removedMembers: [removal(selfSeat)],
      }),
    );
  });

  it("ignores a removal of a third seat that this seat linked again later", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat], {
      epoch: 0,
      state: "active",
      relinkedMembers: [relinked(thirdSeat, "2026-11-21T09:00:00.000Z")],
    });
    assert.isNull(
      computePersonalRemovalPatch(project, SELF, {
        epoch: 0,
        state: "active",
        removedMembers: [removal(thirdSeat)],
      }),
    );
  });

  it("still unlinks for a removal newer than the last link", () => {
    const project = linked([selfSeat, peerSeat], {
      epoch: 0,
      state: "active",
      relinkedMembers: [relinked(selfSeat, "2026-11-19T09:00:00.000Z")],
    });
    assert.deepStrictEqual(
      computePersonalRemovalPatch(project, SELF, {
        epoch: 0,
        state: "active",
        removedMembers: [removal(selfSeat)],
      }),
      { kind: "unlink-self" },
    );
  });

  it("ignores a removal that names another link of the listed seat", () => {
    const project = linked([selfSeat, peerSeat, { ...thirdSeat, linkId: "op-2" }]);
    assert.isNull(
      computePersonalRemovalPatch(project, SELF, {
        epoch: 0,
        state: "active",
        removedMembers: [removal(thirdSeat, { linkId: "op-1" })],
      }),
    );
  });
});

describe("a seat that left (C1)", () => {
  const NOW = Date.parse("2026-11-23T12:00:00.000Z");

  it("drops only the seat that left, dated now, when two others remain", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    const patch = computeLeftPeerPatch(project, SELF, peerSeat, NOW);
    assert.deepStrictEqual(patch, {
      kind: "remove",
      logicalProject: identityOf([selfSeat, thirdSeat]),
      coordinatorBinding: {
        epoch: 0,
        state: "active",
        removedMembers: [
          {
            environmentId: peerSeat.environmentId,
            projectId: peerSeat.projectId,
            removedAt: "2026-11-23T12:00:00.000Z",
          },
        ],
      },
    });
    if (patch?.kind !== "remove") return;
    assert.isUndefined(
      ownershipRejection(project.id, project.workspaceSettings!, {
        mode: "remove-member",
        expectedRevision: 7,
        logicalProject: patch.logicalProject,
        coordinatorBinding: patch.coordinatorBinding,
      }),
    );
  });

  it("unlinks itself only when it would be left alone", () => {
    assert.deepStrictEqual(
      computeLeftPeerPatch(linked([selfSeat, peerSeat]), SELF, peerSeat, NOW),
      {
        kind: "unlink-self",
      },
    );
  });

  it("does nothing for a seat it does not list, or for itself", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    assert.isNull(computeLeftPeerPatch(project, SELF, seat("z"), NOW));
    assert.isNull(computeLeftPeerPatch(project, SELF, selfSeat, NOW));
    assert.isNull(computeLeftPeerPatch(makeProject(), SELF, peerSeat, NOW));
  });

  it("remembers the link it leaves in formerLinks, newest last, at most eight", () => {
    const older = Array.from({ length: 8 }, (_, index) => ({
      logicalProjectId: `logical:old-${index}`,
      members: [selfSeat],
      leftAt: "2026-11-01T00:00:00.000Z",
    }));
    const project = linked([selfSeat, peerSeat], {
      epoch: 2,
      state: "active",
      formerLinks: older,
    });
    const fresh = Effect.runSync(
      unlinkedPersonalIdentity(project, SELF, "2026-11-23T12:00:00.000Z"),
    );
    assert.isNotNull(fresh);
    const former = fresh!.coordinatorBinding.formerLinks!;
    assert.strictEqual(former.length, 8);
    assert.strictEqual(former[0]!.logicalProjectId, "logical:old-1");
    assert.deepStrictEqual(former.at(-1), {
      logicalProjectId: "logical:personal",
      members: [selfSeat, peerSeat],
      leftAt: "2026-11-23T12:00:00.000Z",
    });
    assert.deepStrictEqual(fresh!.logicalProject.members, [selfSeat]);
    assert.isUndefined(
      ownershipRejection(project.id, project.workspaceSettings!, {
        mode: "unlink",
        expectedRevision: 7,
        ...fresh!,
      }),
    );
  });
});

/** The hooks against a recording `projects.update`. */
const hooks = (input: {
  readonly project: Project;
  readonly refuse?: (update: ProjectUpdateInput) => boolean;
}) => {
  const updates: ProjectUpdateInput[] = [];
  const deps = personalPeerSyncDeps(
    {
      update: (update) =>
        input.refuse?.(update) === true
          ? Effect.fail(new Error("refused") as never)
          : Effect.sync(() => {
              updates.push(update);
              return input.project;
            }),
    },
    { getEnvironmentId: Effect.succeed(SELF) },
  );
  return { deps, updates };
};

describe("personalPeerSyncDeps", () => {
  it.effect("on a LEFT answer drops only that seat while two others remain", () =>
    Effect.gen(function* () {
      const { deps, updates } = hooks({ project: linked([selfSeat, peerSeat, thirdSeat]) });
      const reaction = yield* deps.personalPeerFenced(
        linked([selfSeat, peerSeat, thirdSeat]),
        peerSeat,
        PERSONAL_SEAT_LEFT_MESSAGE,
      );
      assert.strictEqual(reaction, "dropped");
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0]!.ownership?.mode, "remove-member");
      assert.deepStrictEqual(
        updates[0]!.ownership?.logicalProject.members.map(
          (m: LogicalProjectMember) => m.environmentId,
        ),
        [selfSeat.environmentId, thirdSeat.environmentId],
      );
    }),
  );

  it.effect("on a LEFT answer from the last other seat unlinks with a formerLinks entry", () =>
    Effect.gen(function* () {
      const project = linked([selfSeat, peerSeat]);
      const { deps, updates } = hooks({ project });
      assert.strictEqual(
        yield* deps.personalPeerFenced(project, peerSeat, PERSONAL_SEAT_LEFT_MESSAGE),
        "unlinked",
      );
      assert.strictEqual(updates[0]!.ownership?.mode, "unlink");
      assert.strictEqual(
        updates[0]!.ownership?.coordinatorBinding.formerLinks?.at(-1)?.logicalProjectId,
        "logical:personal",
      );
    }),
  );

  it.effect("on a REMOVED answer unlinks itself, whatever is left; other messages do nothing", () =>
    Effect.gen(function* () {
      const project = linked([selfSeat, peerSeat, thirdSeat]);
      const { deps, updates } = hooks({ project });
      assert.isNull(yield* deps.personalPeerFenced(project, peerSeat, "Something else."));
      assert.strictEqual(updates.length, 0);
      assert.strictEqual(
        yield* deps.personalPeerFenced(project, peerSeat, PERSONAL_SEAT_REMOVED_MESSAGE),
        "unlinked",
      );
      assert.strictEqual(updates[0]!.ownership?.mode, "unlink");
    }),
  );

  it.effect("applies each setting alone when the bundled write is refused", () =>
    Effect.gen(function* () {
      // Peer stamps more than ten minutes ahead of the clock are ignored: set it to their day.
      yield* TestClock.setTime(Date.parse("2026-11-23T12:30:00.000Z"));
      const project = makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });
      // The new name is taken on this machine: every write carrying it is refused.
      const { deps, updates } = hooks({
        project,
        refuse: (update) => update.title !== undefined,
      });
      yield* deps.syncPersonalSettings({
        project,
        peerSettings: peerSettings({ title: "Taken", instructions: "Answer in Russian." }),
      });
      assert.strictEqual(updates.length, 1);
      assert.isUndefined(updates[0]!.title);
      assert.strictEqual(updates[0]!.workspaceSettings?.instructions, "Answer in Russian.");
      assert.strictEqual(updates[0]!.sharedSettingsStamp, "2026-11-22T11:00:00.000Z");
    }),
  );

  it.effect("writes the other settings together, under the peer's stamp, in one update", () =>
    Effect.gen(function* () {
      // Peer stamps more than ten minutes ahead of the clock are ignored: set it to their day.
      yield* TestClock.setTime(Date.parse("2026-11-23T12:30:00.000Z"));
      const project = makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });
      const { deps, updates } = hooks({ project, refuse: (update) => update.title !== undefined });
      const icon = { kind: "emoji", emoji: "🦉" } as const;
      yield* deps.syncPersonalSettings({
        project,
        peerSettings: peerSettings({ title: "Taken", icon, instructions: "Answer in Russian." }),
      });
      // A second write under the same stamp would be refused as not newer, so one write.
      assert.strictEqual(updates.length, 1);
      assert.isUndefined(updates[0]!.title);
      assert.deepStrictEqual(updates[0]!.projectIcon, icon);
      assert.strictEqual(updates[0]!.workspaceSettings?.instructions, "Answer in Russian.");
    }),
  );

  it.effect("writes nothing when every setting is refused", () =>
    Effect.gen(function* () {
      // Peer stamps more than ten minutes ahead of the clock are ignored: set it to their day.
      yield* TestClock.setTime(Date.parse("2026-11-23T12:30:00.000Z"));
      const project = makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });
      const { deps, updates } = hooks({ project, refuse: () => true });
      yield* deps.syncPersonalSettings({
        project,
        peerSettings: peerSettings({ title: "Taken", instructions: "Answer in Russian." }),
      });
      assert.strictEqual(updates.length, 0);
    }),
  );

  it.effect("writes every setting in one update when it is accepted", () =>
    Effect.gen(function* () {
      // Peer stamps more than ten minutes ahead of the clock are ignored: set it to their day.
      yield* TestClock.setTime(Date.parse("2026-11-23T12:30:00.000Z"));
      const project = makeProject({ sharedSettingsUpdatedAt: "2026-11-22T10:00:00.000Z" });
      const { deps, updates } = hooks({ project });
      yield* deps.syncPersonalSettings({
        project,
        peerSettings: peerSettings({ title: "Jarvis", instructions: "Answer in Russian." }),
      });
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0]!.title, "Jarvis");
      assert.strictEqual(updates[0]!.workspaceSettings?.instructions, "Answer in Russian.");
    }),
  );
});

describe("personalPeerAllowed", () => {
  const PEER = peerSeat.environmentId;
  const grantsWith = (
    record: Record<string, unknown> | undefined,
    managers: ReadonlyArray<string> = [PEER],
    overrides: {
      readonly [K in keyof WorkGrants.WorkGrantsShape]?: WorkGrants.WorkGrantsShape[K] | undefined;
    } = {},
  ) =>
    ({
      enabled: true,
      peekPolicy: () => Effect.succeed(record),
      managers: Effect.succeed(new Set(managers)),
      ...overrides,
    }) as unknown as WorkGrants.WorkGrantsShape;
  const record = (overrides: Record<string, unknown> = {}) => ({
    coordinatorEnvironmentId: PEER,
    owner: "self",
    legacy: false,
    revokedAt: null,
    projects: { kind: "none" },
    accounts: { kind: "all" },
    ...overrides,
  });

  it.effect("allows only an active, non-legacy, own grant held here", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* personalPeerAllowed(grantsWith(record()), PEER));
      assert.isFalse(yield* personalPeerAllowed(grantsWith(record(), []), PEER));
      assert.isFalse(yield* personalPeerAllowed(grantsWith(record({ legacy: true })), PEER));
      assert.isFalse(
        yield* personalPeerAllowed(
          grantsWith(record({ revokedAt: "2026-11-01T00:00:00.000Z" })),
          PEER,
        ),
      );
      assert.isFalse(yield* personalPeerAllowed(grantsWith(undefined), PEER));
    }),
  );

  it.effect("refuses when grants are off, cannot be peeked, or cannot be read", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* personalPeerAllowed(grantsWith(record(), [PEER], { enabled: false }), PEER),
      );
      assert.isFalse(
        yield* personalPeerAllowed(grantsWith(record(), [PEER], { peekPolicy: undefined }), PEER),
      );
      assert.isFalse(
        yield* personalPeerAllowed(
          grantsWith(record(), [PEER], { managers: Effect.fail(new Error("sessions") as never) }),
          PEER,
        ),
      );
    }),
  );
});
