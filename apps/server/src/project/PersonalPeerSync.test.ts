/**
 * What a linked personal assistant seat takes from a peer beside memory (1448
 * AC-05, AC-07, AC-10): the newest shared settings, and the members another
 * seat removed, written so the real `remove-member` ownership rules accept it.
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
  type ProjectRepository,
  type ProjectWorkspaceSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import { LinkedPersonalSettings } from "../handoff/linkedSyncWire.ts";
import { ownershipRejection } from "../orchestration-v2/ProjectCommands.ts";
import { computePersonalRemovalPatch, computePersonalSettingsPatch } from "./PersonalPeerSync.ts";

const seat = (name: string): LogicalProjectMember => {
  const projectId = ProjectId.make(`proj-personal-${name}`);
  return {
    environmentId: EnvironmentId.make(`env-${name}`),
    projectId,
    coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
  };
};

/** This seat, a peer, a third seat, and a machine that was never listed. */
const selfSeat = seat("a");
const peerSeat = seat("b");
const thirdSeat = seat("c");
const strangerSeat = seat("d");
/** A seat this machine already removed earlier. */
const formerSeat = seat("x");

const REMOVED_AT = "2026-11-20T09:00:00.000Z";
const RELINKED_AT = "2026-11-21T09:00:00.000Z";

const identityOf = (members: ReadonlyArray<LogicalProjectMember>): LogicalProject => ({
  id: "logical:personal",
  title: "Percy",
  coordinatorId: selfSeat.coordinatorThreadId,
  members,
});

const repo = (id: string, url: string, localPath: string | null = null): ProjectRepository =>
  ({ id, url, localPath }) as ProjectRepository;

const makeProject = (
  settings: Partial<ProjectWorkspaceSettings> = {},
  overrides: Partial<Project> = {},
): Project => ({
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
  ...overrides,
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    kind: "personal",
    revision: 7,
    instructions: "Keep replies short.",
    ...settings,
  },
});

const LOCAL_STAMP = "2026-11-22T10:00:00.000Z";
const NEWER_STAMP = "2026-11-22T11:00:00.000Z";
const OLDER_STAMP = "2026-11-22T09:00:00.000Z";

const peerSettings = (overrides: Partial<LinkedPersonalSettings> = {}): LinkedPersonalSettings => ({
  updatedAt: NEWER_STAMP,
  title: "Percy",
  instructions: "Keep replies short.",
  icon: { kind: "lucide", name: "concierge-bell", color: "violet" },
  repositoryUrls: [],
  ...overrides,
});

describe("computePersonalSettingsPatch", () => {
  const stamped = () => makeProject({ sharedSettingsUpdatedAt: LOCAL_STAMP });

  it("ignores a peer that never stamped its shared settings", () => {
    assert.strictEqual(
      computePersonalSettingsPatch(stamped(), peerSettings({ updatedAt: null, title: "Other" })),
      null,
    );
    assert.strictEqual(
      computePersonalSettingsPatch(makeProject(), peerSettings({ updatedAt: null })),
      null,
    );
  });

  it("ignores an equal or older stamp, whatever the peer's settings say", () => {
    for (const updatedAt of [LOCAL_STAMP, OLDER_STAMP]) {
      assert.strictEqual(
        computePersonalSettingsPatch(
          stamped(),
          peerSettings({ updatedAt, title: "Other", instructions: "Other rules." }),
        ),
        null,
      );
    }
  });

  it("ignores a stamp far ahead of this machine's clock", () => {
    const now = Date.parse(LOCAL_STAMP);
    const ahead = new Date(now + 60 * 60 * 1000).toISOString();
    assert.strictEqual(
      computePersonalSettingsPatch(makeProject(), peerSettings({ updatedAt: ahead }), now),
      null,
    );
    const slightlyAhead = new Date(now + 60 * 1000).toISOString();
    assert.notStrictEqual(
      computePersonalSettingsPatch(makeProject(), peerSettings({ updatedAt: slightlyAhead }), now),
      null,
    );
  });

  it("takes a stamped peer's settings when this seat has no stamp yet", () => {
    const patch = computePersonalSettingsPatch(makeProject(), peerSettings({ title: "Jarvis" }));
    assert.deepStrictEqual(patch, { stamp: NEWER_STAMP, title: "Jarvis" });
  });

  it("returns only the stamp when a newer peer has the same settings", () => {
    const patch = computePersonalSettingsPatch(stamped(), peerSettings());
    assert.deepStrictEqual(patch, { stamp: NEWER_STAMP });
    assert.deepStrictEqual(Object.keys(patch!), ["stamp"]);
  });

  it("takes each newer shared setting that differs, and only those", () => {
    const icon = { kind: "emoji", emoji: "🦉" } as const;
    const patch = computePersonalSettingsPatch(
      stamped(),
      peerSettings({ title: "Jarvis", instructions: "Answer in Russian.", icon }),
    );
    assert.deepStrictEqual(patch, {
      stamp: NEWER_STAMP,
      title: "Jarvis",
      instructions: "Answer in Russian.",
      projectIcon: icon,
    });

    const titleOnly = computePersonalSettingsPatch(stamped(), peerSettings({ title: "Jarvis" }));
    assert.deepStrictEqual(Object.keys(titleOnly!).toSorted(), ["stamp", "title"]);
  });

  it("clears the icon when the newer peer cleared it", () => {
    const patch = computePersonalSettingsPatch(stamped(), peerSettings({ icon: null }));
    assert.deepStrictEqual(patch, { stamp: NEWER_STAMP, projectIcon: null });
  });

  it("keeps the icon when it is the same and the local icon was never set", () => {
    const unset = makeProject({ sharedSettingsUpdatedAt: LOCAL_STAMP }, { projectIcon: null });
    const patch = computePersonalSettingsPatch(unset, peerSettings({ icon: null }));
    assert.deepStrictEqual(patch, { stamp: NEWER_STAMP });
  });

  it("ignores an icon kind this version does not know", () => {
    const future = { kind: "hologram", shape: "owl" } as unknown as LinkedPersonalSettings["icon"];
    const patch = computePersonalSettingsPatch(stamped(), peerSettings({ icon: future }));
    assert.deepStrictEqual(patch, { stamp: NEWER_STAMP });
    assert.isFalse(Object.hasOwn(patch!, "projectIcon"));
  });

  // A newer peer's icon kind decodes as UNKNOWN_PEER_ICON, never as a cleared icon.
  it("ignores an unknown icon kind that arrived over the wire", () => {
    const decoded = Schema.decodeUnknownSync(LinkedPersonalSettings)({
      ...peerSettings(),
      icon: { kind: "hologram", shape: "owl" },
    });
    const patch = computePersonalSettingsPatch(stamped(), decoded);
    assert.isFalse(Object.hasOwn(patch!, "projectIcon"));
  });

  describe("repository URLs", () => {
    const KEPT = "https://github.com/acme/notes.git";
    const DROPPED = "https://github.com/acme/old.git";
    const ADDED = "https://github.com/acme/new.git";
    const withRepos = (repositories: ReadonlyArray<ProjectRepository>) =>
      makeProject({
        sharedSettingsUpdatedAt: LOCAL_STAMP,
        environment: { additionalFolders: [], repositories },
      });

    it("replaces the list, keeps this seat's own folder, and drops a removed repository", () => {
      const keptLocal = repo("repo-local-notes", KEPT, "/tmp/checkouts/notes");
      const project = withRepos([keptLocal, repo("repo-local-old", DROPPED, "/tmp/checkouts/old")]);
      const patch = computePersonalSettingsPatch(
        project,
        peerSettings({
          repositoryUrls: [
            { id: "repo-peer-notes", url: KEPT },
            { id: "repo-peer-new", url: ADDED },
          ],
        }),
      );
      assert.deepStrictEqual(patch?.repositories, [
        keptLocal,
        { id: "repo-peer-new", url: ADDED, localPath: null },
      ]);
      // The matching entry is this seat's own, local id and folder included.
      assert.strictEqual(patch?.repositories?.[0], keptLocal);
    });

    it("matches a repository by identity, not by spelling", () => {
      const keptLocal = repo("repo-local-notes", KEPT, "/tmp/checkouts/notes");
      const patch = computePersonalSettingsPatch(
        withRepos([keptLocal]),
        peerSettings({
          repositoryUrls: [{ id: "repo-peer-notes", url: "git@github.com:acme/notes.git" }],
        }),
      );
      assert.isUndefined(patch?.repositories);
    });

    it("removes every repository when the peer removed them all", () => {
      const patch = computePersonalSettingsPatch(
        withRepos([repo("repo-local-old", DROPPED, "/tmp/checkouts/old")]),
        peerSettings({ repositoryUrls: [] }),
      );
      assert.deepStrictEqual(patch?.repositories, []);
    });

    it("skips blank and duplicate peer URLs", () => {
      const patch = computePersonalSettingsPatch(
        withRepos([]),
        peerSettings({
          repositoryUrls: [
            { id: "repo-peer-blank", url: "   " },
            { id: "repo-peer-new", url: ` ${ADDED} ` },
            { id: "repo-peer-new-again", url: ADDED },
          ],
        }),
      );
      assert.deepStrictEqual(patch?.repositories, [
        { id: "repo-peer-new", url: ADDED, localPath: null },
      ]);
    });

    it("leaves the list out when it is the same, in the same order", () => {
      const repositories = [
        repo("repo-local-notes", KEPT, "/tmp/checkouts/notes"),
        repo("repo-local-new", ADDED),
      ];
      const patch = computePersonalSettingsPatch(
        withRepos(repositories),
        peerSettings({
          repositoryUrls: [
            { id: "repo-peer-notes", url: KEPT },
            { id: "repo-peer-new", url: ADDED },
          ],
        }),
      );
      assert.deepStrictEqual(patch, { stamp: NEWER_STAMP });
    });

    it("takes the peer's order when it differs", () => {
      const notes = repo("repo-local-notes", KEPT, "/tmp/checkouts/notes");
      const added = repo("repo-local-new", ADDED);
      const patch = computePersonalSettingsPatch(
        withRepos([notes, added]),
        peerSettings({
          repositoryUrls: [
            { id: "repo-peer-new", url: ADDED },
            { id: "repo-peer-notes", url: KEPT },
          ],
        }),
      );
      assert.deepStrictEqual(patch?.repositories, [added, notes]);
    });
  });
});

describe("computePersonalRemovalPatch", () => {
  const removal = (member: LogicalProjectMember, removedAt = REMOVED_AT) => ({
    environmentId: member.environmentId,
    projectId: member.projectId,
    removedAt,
  });
  const peerRemoving = (...members: ReadonlyArray<LogicalProjectMember>) =>
    ({
      epoch: 0,
      state: "active",
      removedMembers: members.map((member) => removal(member)),
    }) satisfies ProjectCoordinatorBinding;
  const linked = (
    members: ReadonlyArray<LogicalProjectMember>,
    binding?: ProjectCoordinatorBinding,
  ) =>
    makeProject({
      logicalProject: identityOf(members),
      ...(binding === undefined ? {} : { coordinatorBinding: binding }),
    });
  const ownBinding: ProjectCoordinatorBinding = {
    epoch: 3,
    state: "active",
    routineOwner: true,
    removedMembers: [removal(formerSeat, "2026-11-10T09:00:00.000Z")],
  };

  it("does nothing without an identity, a peer binding or a removal", () => {
    const self = selfSeat.environmentId;
    assert.strictEqual(
      computePersonalRemovalPatch(makeProject(), self, peerRemoving(selfSeat)),
      null,
    );
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    assert.strictEqual(computePersonalRemovalPatch(project, self, null), null);
    assert.strictEqual(computePersonalRemovalPatch(project, self, peerRemoving()), null);
    assert.strictEqual(
      computePersonalRemovalPatch(project, self, { epoch: 0, state: "active" }),
      null,
    );
  });

  it("does nothing when this seat is not listed in its own identity", () => {
    const project = linked([peerSeat, thirdSeat]);
    assert.strictEqual(
      computePersonalRemovalPatch(project, selfSeat.environmentId, peerRemoving(thirdSeat)),
      null,
    );
  });

  it("does nothing when the peer removed only machines this seat does not list", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    assert.strictEqual(
      computePersonalRemovalPatch(project, selfSeat.environmentId, peerRemoving(strangerSeat)),
      null,
    );
  });

  it("matches this seat by machine and project, not by project id alone", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    const sameProjectElsewhere = { ...selfSeat, environmentId: EnvironmentId.make("env-z") };
    assert.strictEqual(
      computePersonalRemovalPatch(
        project,
        selfSeat.environmentId,
        peerRemoving(sameProjectElsewhere),
      ),
      null,
    );
  });

  it("unlinks itself when a peer removed this seat", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    assert.deepStrictEqual(
      computePersonalRemovalPatch(project, selfSeat.environmentId, peerRemoving(selfSeat)),
      { kind: "unlink-self" },
    );
  });

  it("unlinks itself when no other seat would be left", () => {
    const project = linked([selfSeat, thirdSeat]);
    assert.deepStrictEqual(
      computePersonalRemovalPatch(project, selfSeat.environmentId, peerRemoving(thirdSeat)),
      { kind: "unlink-self" },
    );
  });

  it("drops a third seat the peer removed and remembers only that one", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat], ownBinding);
    const patch = computePersonalRemovalPatch(
      project,
      selfSeat.environmentId,
      peerRemoving(thirdSeat, strangerSeat),
    );
    assert.deepStrictEqual(patch, {
      kind: "remove",
      logicalProject: identityOf([selfSeat, peerSeat]),
      coordinatorBinding: {
        ...ownBinding,
        removedMembers: [...ownBinding.removedMembers!, removal(thirdSeat)],
      },
    });
  });

  it("starts from a legacy active binding when this seat has none", () => {
    const project = linked([selfSeat, peerSeat, thirdSeat]);
    const patch = computePersonalRemovalPatch(
      project,
      selfSeat.environmentId,
      peerRemoving(thirdSeat),
    );
    assert.deepStrictEqual(patch, {
      kind: "remove",
      logicalProject: identityOf([selfSeat, peerSeat]),
      coordinatorBinding: { epoch: 0, state: "active", removedMembers: [removal(thirdSeat)] },
    });
  });

  describe("against the real remove-member rules", () => {
    const apply = (project: Project, patch: ReturnType<typeof computePersonalRemovalPatch>) => {
      assert.strictEqual(patch?.kind, "remove");
      if (patch?.kind !== "remove") throw new Error("expected a remove patch");
      return (binding: ProjectCoordinatorBinding = patch.coordinatorBinding) =>
        ownershipRejection(project.id, project.workspaceSettings!, {
          mode: "remove-member",
          expectedRevision: project.workspaceSettings!.revision,
          logicalProject: patch.logicalProject,
          coordinatorBinding: binding,
        });
    };

    it("accepts the patch for a seat with its own binding and earlier removals", () => {
      const project = linked([selfSeat, peerSeat, thirdSeat], ownBinding);
      const reject = apply(
        project,
        computePersonalRemovalPatch(
          project,
          selfSeat.environmentId,
          peerRemoving(thirdSeat, strangerSeat),
        ),
      );
      assert.isUndefined(reject());
    });

    it("accepts the patch for a seat without a binding", () => {
      const project = linked([selfSeat, peerSeat, thirdSeat]);
      const reject = apply(
        project,
        computePersonalRemovalPatch(project, selfSeat.environmentId, peerRemoving(thirdSeat)),
      );
      assert.isUndefined(reject());
    });

    it("would refuse the patch if it also remembered a machine it did not drop", () => {
      const project = linked([selfSeat, peerSeat, thirdSeat], ownBinding);
      const patch = computePersonalRemovalPatch(
        project,
        selfSeat.environmentId,
        peerRemoving(thirdSeat, strangerSeat),
      );
      const reject = apply(project, patch);
      if (patch?.kind !== "remove") throw new Error("expected a remove patch");
      assert.strictEqual(
        reject({
          ...patch.coordinatorBinding,
          removedMembers: [...patch.coordinatorBinding.removedMembers!, removal(strangerSeat)],
        }),
        "Only the active coordinator can remove members, and its binding stays as it is.",
      );
    });
  });

  // An unlink older than a link named in `relinkedMembers` "no longer removes
  // that member anywhere" (packages/contracts/src/logicalProject.ts).
  it("keeps a seat that was linked again after the peer removed it", () => {
    const project = linked([selfSeat, peerSeat]);
    const peerBinding: ProjectCoordinatorBinding = {
      ...peerRemoving(selfSeat),
      relinkedMembers: [
        {
          environmentId: selfSeat.environmentId,
          projectId: selfSeat.projectId,
          linkedAt: RELINKED_AT,
        },
      ],
    };
    assert.strictEqual(
      computePersonalRemovalPatch(project, selfSeat.environmentId, peerBinding),
      null,
    );
  });
});
