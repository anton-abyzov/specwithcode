import {
  EnvironmentId,
  LogicalProject,
  type Project,
  type LogicalProjectMember,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  isLogicalProjectBinding,
  logicalProjectBindingMatch,
} from "../fleet/remoteWorkerMatching.ts";
import * as ProjectLink from "./ProjectLink.ts";
import {
  checkout,
  legacyPair,
  link,
  machine,
  operationId,
  removeCheckouts,
  unlinkId,
  withoutRoot,
} from "./ProjectLink.testkit.ts";

afterEach(removeCheckouts);

describe("ProjectLink", () => {
  it("adopts an identity for a legacy kept copy, then links both ways so remote workers bind", async () => {
    const pair = legacyPair();
    const { prepared, accepted, committed } = await link(pair);
    expect(prepared.adopted).toBe(true);
    expect(prepared.logicalProject.id).toMatch(/^logical:[0-9a-f-]{36}$/);
    expect(prepared.logicalProject.members).toEqual([pair.kept]);
    expect(prepared.coordinatorBinding).toEqual({ epoch: 0, state: "active" });
    const kept = pair.m4.projects.get(pair.kept.projectId)!;
    const joined = pair.m3.projects.get(pair.joining.projectId)!;
    // The kept binding never changes; the joined copy keeps its own coordinator beside it.
    expect(kept.workspaceSettings?.coordinatorBinding).toEqual({ epoch: 0, state: "active" });
    expect(joined.workspaceSettings?.coordinatorBinding).toEqual({
      epoch: 0,
      state: "active",
      operationId,
      routineOwner: false,
    });
    expect(committed.logicalProject.members).toEqual([pair.kept, pair.joining]);
    expect(accepted.logicalProject.members).toEqual([pair.kept, pair.joining]);
    // The kept copy records which folder on which machine each member maps to.
    expect(
      kept.workspaceSettings!.logicalProject!.members.map((member) => [
        member.environmentId,
        member.workspaceRoot,
      ]),
    ).toEqual([
      ["m4", kept.workspaceRoot],
      ["m3", joined.workspaceRoot],
    ]);
    expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member"]);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
    // Project ids never change; the remote worker path now admits the M3 copy from the M4.
    const logical = kept.workspaceSettings!.logicalProject!;
    const selected = logicalProjectBindingMatch({ logical, environmentId: pair.m3.environmentId });
    expect(selected).toMatchObject({ match: "configured", projectId: pair.joining.projectId });
    expect(isLogicalProjectBinding(joined, logical, pair.joining)).toBe(true);
    expect(
      isLogicalProjectBinding(kept, joined.workspaceSettings!.logicalProject!, pair.kept),
    ).toBe(true);
  });

  it("keeps an existing identity and epoch, and replays every step of a retried link", async () => {
    const pair = legacyPair();
    const identity = {
      id: "logical:existing",
      title: "EasyChamp",
      coordinatorId: "coordinator:logical:existing",
      members: [pair.kept],
    };
    pair.m4.projects.set(pair.kept.projectId, {
      ...pair.m4.projects.get(pair.kept.projectId)!,
      workspaceSettings: {
        ...pair.m4.projects.get(pair.kept.projectId)!.workspaceSettings!,
        logicalProject: identity,
        coordinatorBinding: { epoch: 3, state: "active", operationId: "old-handoff" },
      },
    });
    const first = await link(pair);
    expect(first.prepared.adopted).toBe(false);
    expect(first.prepared.logicalProject.id).toBe("logical:existing");
    const again = await link(pair);
    expect(again.accepted.replayed).toBe(true);
    expect(again.committed.replayed).toBe(true);
    expect(
      pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings!.coordinatorBinding,
    ).toMatchObject({
      epoch: 3,
      state: "active",
    });
    expect(pair.m4.ownershipModes).toEqual(["link-member"]);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
  });

  const linkWithIcons = async (
    keptIcon: Pick<Project, "projectIcon" | "faviconPath">,
    joiningIcon: (
      workspaceRoot: string,
    ) => Pick<Project, "projectIcon" | "faviconPath"> = () => ({}),
  ) => {
    const pair = legacyPair();
    pair.m4.projects.set(pair.kept.projectId, {
      ...pair.m4.projects.get(pair.kept.projectId)!,
      ...keptIcon,
    });
    pair.m3.projects.set(pair.joining.projectId, {
      ...pair.m3.projects.get(pair.joining.projectId)!,
      ...joiningIcon(pair.m3.projects.get(pair.joining.projectId)!.workspaceRoot),
    });
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
        ...(prepared.sharedIcon ? { sharedIcon: prepared.sharedIcon } : {}),
      }),
    );
    return { prepared, joined: pair.m3.projects.get(pair.joining.projectId)! };
  };
  const dna = { kind: "lucide", name: "dna", color: "yellow" } as const;

  it("gives a joining copy with no icon the icon the kept copy saved", async () => {
    const { joined } = await linkWithIcons({ projectIcon: dna });
    expect(joined.projectIcon).toEqual(dna);
    expect(joined.faviconPath ?? null).toBeNull();
  });

  it("keeps the icon a joining copy already saved", async () => {
    const own = { kind: "lucide", name: "rocket", color: "blue" } as const;
    const { joined } = await linkWithIcons({ projectIcon: dna }, () => ({ projectIcon: own }));
    expect(joined.projectIcon).toEqual(own);
  });

  it("replaces an automatic favicon on the joining copy with the saved icon", async () => {
    const { joined } = await linkWithIcons({ projectIcon: dna }, (root) => ({
      faviconPath: `${root}/public/favicon.svg`,
    }));
    expect(joined.projectIcon).toEqual(dna);
  });

  it("links without an icon when the saved icon path is not an image", async () => {
    const { prepared, joined } = await linkWithIcons({ faviconPath: "assets/logo" });
    expect(prepared.sharedIcon).toBeUndefined();
    expect(joined.faviconPath ?? null).toBeNull();
  });

  it("refuses an absolute icon path sent to the joining copy", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
        sharedIcon: { projectIcon: null, faviconPath: "/home/anton/.ssh/shot.png" },
      }),
    );
    expect(pair.m3.projects.get(pair.joining.projectId)!.faviconPath ?? null).toBeNull();
  });

  it("does not hand a joining copy an icon file only the kept machine has", async () => {
    const { prepared } = await linkWithIcons({ faviconPath: "/Users/anton/Pictures/icon.png" });
    expect(prepared.sharedIcon).toBeUndefined();
    const relative = await linkWithIcons({ faviconPath: "assets/brand.svg" });
    expect(relative.joined.faviconPath).toBe("assets/brand.svg");
  });

  it("leaves no state that blocks sending when the kept machine drops before commit", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      }),
    );
    // Half linked: the kept copy still coordinates alone and the joined copy defers to it.
    const kept = pair.m4.projects.get(pair.kept.projectId)!;
    expect(kept.workspaceSettings?.coordinatorBinding?.state).toBe("active");
    expect(
      logicalProjectBindingMatch({
        logical: kept.workspaceSettings!.logicalProject!,
        environmentId: pair.m3.environmentId,
      }).match,
    ).toBe("none");
    // Recovery is the same commit, later.
    const finished = await pair.m4.run((service) =>
      service.commit({
        operationId,
        projectId: pair.kept.projectId,
        joining: pair.joining,
        notes: [],
      }),
    );
    expect(finished.logicalProject.members).toHaveLength(2);
  });

  it("refuses with the fix named: shared copies, handoffs, busy coordinators, other repositories", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    const accept = (
      target: ReturnType<typeof machine>,
      projectId: ProjectId,
      fingerprint = prepared.fingerprint,
    ) =>
      target.run((service) =>
        service.accept({
          operationId,
          projectId,
          kept: prepared.kept,
          logicalProject: prepared.logicalProject,
          coordinatorBinding: prepared.coordinatorBinding,
          keptFingerprint: fingerprint,
        }),
      );
    const other = pair.m3.member("other-copy");
    pair.m3.add("shared", checkout("git@github.com:anton/sw-easychamp.git"), {
      logicalProject: {
        id: "logical:elsewhere",
        title: "EasyChamp",
        coordinatorId: "coordinator:logical:elsewhere",
        members: [pair.m3.member("shared"), other],
      },
      coordinatorBinding: { epoch: 0, state: "active" },
    });
    expect((await pair.m3.fails(accept(pair.m3, ProjectId.make("shared")))).code).toBe(
      "already_shared",
    );
    pair.m3.add("handing-off", checkout("git@github.com:anton/sw-easychamp.git"), {
      coordinatorBinding: { epoch: 0, state: "transferring", operationId: "handoff" },
    });
    expect((await pair.m3.fails(accept(pair.m3, ProjectId.make("handing-off")))).code).toBe(
      "handoff_in_progress",
    );
    pair.m3.busy.add("project-coordinator:easychamp-m3");
    expect((await pair.m3.fails(accept(pair.m3, pair.joining.projectId))).code).toBe(
      "coordinator_busy",
    );
    pair.m3.busy.clear();
    pair.m3.add("olysense", checkout("git@github.com:anton/olysense.git"));
    const mismatch = await pair.m3.fails(accept(pair.m3, ProjectId.make("olysense")));
    expect(mismatch.code).toBe("repository_mismatch");
    expect(mismatch.message).toContain("github.com/anton/olysense");
    expect(mismatch.message).toContain("github.com/anton/sw-easychamp");
    // Nothing above changed a project.
    expect(pair.m3.ownershipModes).toEqual([]);
    // Two copies on one machine are not a cross-machine link.
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) =>
            service.prepare({
              operationId,
              projectId: pair.kept.projectId,
              joining: pair.m4.member("x"),
            }),
          ),
        )
      ).code,
    ).toBe("same_machine");
  });

  it("never previews or links a personal assistant, and returns none of its notes", async () => {
    const pair = legacyPair();
    const household = pair.m3.add(
      "example-household",
      checkout("https://github.com/example/example-household.git"),
      { kind: "personal" },
    );
    pair.m3.notes(household.id).set("groceries.md", { content: "Private list", revision: 1 });
    const refused = await pair.m3.fails(
      pair.m3.run((service) => service.preview({ projectId: household.id })),
    );
    expect(refused.code).toBe("not_code_project");
    expect(JSON.stringify(refused)).not.toContain("Private list");
    // Neither side of a link takes it.
    const asKept = await pair.m3.fails(
      pair.m3.run((service) =>
        service.prepare({ operationId, projectId: household.id, joining: pair.kept }),
      ),
    );
    expect(asKept.code).toBe("not_code_project");
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    const asJoining = await pair.m3.fails(
      pair.m3.run((service) =>
        service.accept({
          operationId,
          projectId: household.id,
          kept: prepared.kept,
          logicalProject: prepared.logicalProject,
          coordinatorBinding: prepared.coordinatorBinding,
          keptFingerprint: prepared.fingerprint,
        }),
      ),
    );
    expect(asJoining.code).toBe("not_code_project");
    expect(pair.m3.projects.get(household.id)?.workspaceSettings?.logicalProject).toBeFalsy();
  });

  it("previews notes and roles, and writes only chosen notes after checking their revisions", async () => {
    const pair = legacyPair();
    pair.m4.notes(pair.kept.projectId).set("decisions.md", { content: "M4 decision", revision: 2 });
    pair.m3
      .notes(pair.joining.projectId)
      .set("decisions.md", { content: "M3 decision", revision: 1 });
    pair.m3.notes(pair.joining.projectId).set("only-m3.md", { content: "M3 only", revision: 1 });
    const preview = await pair.m3.run((service) =>
      service.preview({ projectId: pair.joining.projectId }),
    );
    expect(preview).toMatchObject({
      member: pair.joining,
      keepRefusal: null,
      joinRefusal: null,
      lastCoordinatorActivityAt: "2026-10-18T09:00:00.000Z",
      notesTruncated: false,
    });
    expect(preview.notes.map((note) => note.name).sort()).toEqual(["decisions.md", "only-m3.md"]);
    expect(preview.fingerprint.repositories[0]?.originKey).toBe("github.com/anton/sw-easychamp");
    const { prepared } = await link(pair);
    const commit = (notes: Parameters<ProjectLink.ProjectLink["Service"]["commit"]>[0]["notes"]) =>
      pair.m4.run((service) =>
        service.commit({
          operationId,
          projectId: prepared.kept.projectId,
          joining: pair.joining,
          notes,
        }),
      );
    // A preview taken before another edit is refused, and nothing is written.
    expect(
      (
        await pair.m4.fails(
          commit([
            { name: "only-m3.md", content: "M3 only", expectedRevision: null },
            { name: "decisions.md", content: "M3 decision", expectedRevision: 1 },
          ]),
        )
      ).code,
    ).toBe("notes_changed");
    expect(pair.m4.notes(pair.kept.projectId).has("only-m3.md")).toBe(false);
    const written = await commit([
      { name: "only-m3.md", content: "M3 only", expectedRevision: null },
      { name: "decisions-macbook-pro-m3.md", content: "M3 decision", expectedRevision: null },
    ]);
    expect(written.notesWritten).toBe(2);
    expect(pair.m4.notes(pair.kept.projectId).get("decisions.md")?.content).toBe("M4 decision");
    // The member keeps its own notes as they were.
    expect(pair.m3.notes(pair.joining.projectId).get("decisions.md")?.content).toBe("M3 decision");
    // A retry writes nothing twice.
    expect(
      (
        await commit([
          { name: "only-m3.md", content: "M3 only", expectedRevision: null },
          { name: "decisions-macbook-pro-m3.md", content: "M3 decision", expectedRevision: null },
        ])
      ).notesWritten,
    ).toBe(0);
  });

  it("refuses a kept-both write onto a note that holds other text, writing nothing", async () => {
    const pair = legacyPair();
    const kept = pair.m4.notes(pair.kept.projectId);
    kept.set("plan-m4.md", { content: "KEEP THIS TOO", revision: 7 });
    const { prepared } = await link(pair);
    const commit = (notes: Parameters<ProjectLink.ProjectLink["Service"]["commit"]>[0]["notes"]) =>
      pair.m4.run((service) =>
        service.commit({
          operationId,
          projectId: prepared.kept.projectId,
          joining: pair.joining,
          notes,
        }),
      );
    // Even with plan-m4.md's current revision, a kept-both copy may not replace it.
    const refused = await pair.m4.fails(
      commit([
        { name: "new.md", content: "new", expectedRevision: null },
        { name: "plan-m4.md", content: "JOINING PLAN", expectedRevision: 7, createOnly: true },
      ]),
    );
    expect(refused.code).toBe("notes_changed");
    expect(kept.get("plan-m4.md")).toEqual({ content: "KEEP THIS TOO", revision: 7 });
    expect(kept.has("new.md")).toBe(false);
    // A create-only copy whose name already holds that text is not written twice.
    kept.set("plan-m4-2.md", { content: "JOINING PLAN", revision: 1 });
    const written = await commit([
      { name: "plan-m4-2.md", content: "JOINING PLAN", expectedRevision: null, createOnly: true },
    ]);
    expect(written.notesWritten).toBe(0);
    expect(kept.get("plan-m4-2.md")?.revision).toBe(1);
  });

  it("unlinks a member to a fresh active coordinator and drops it from the kept copy", async () => {
    const pair = legacyPair();
    pair.m3.notes(pair.joining.projectId).set("decisions.md", { content: "M3", revision: 1 });
    const { prepared } = await link(pair);
    const unlinked = await pair.m3.run((service) =>
      service.unlink({
        side: "member",
        operationId: unlinkId,
        projectId: pair.joining.projectId,
        notes: [
          { name: "kept-notes.md", content: "From M4", expectedRevision: null },
          { name: "decisions-macbook-m4max.md", content: "M4", expectedRevision: null },
        ],
      }),
    );
    expect(unlinked.logicalProject.id).not.toBe(prepared.logicalProject.id);
    expect(unlinked.logicalProject.members).toEqual([pair.joining]);
    expect(unlinked.coordinatorBinding).toEqual({
      epoch: 0,
      state: "active",
      operationId: unlinkId,
    });
    expect(unlinked.notesWritten).toBe(2);
    expect(pair.m3.notes(pair.joining.projectId).get("decisions.md")?.content).toBe("M3");
    const replay = await pair.m3.run((service) =>
      service.unlink({
        side: "member",
        operationId: unlinkId,
        projectId: pair.joining.projectId,
        notes: [],
      }),
    );
    expect(replay.replayed).toBe(true);
    const removed = await pair.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: unlinkId,
        projectId: pair.kept.projectId,
        member: pair.joining,
      }),
    );
    expect(removed.logicalProject.members).toEqual([pair.kept]);
    // It remembers whom it unlinked, so another copy's older list never brings the member back.
    expect(removed.coordinatorBinding).toEqual({
      epoch: 0,
      state: "active",
      removedMembers: [
        { environmentId: pair.joining.environmentId, projectId: pair.joining.projectId },
      ],
    });
    expect(
      (
        await pair.m4.run((service) =>
          service.unlink({
            side: "coordinator",
            operationId: unlinkId,
            projectId: pair.kept.projectId,
            member: pair.joining,
          }),
        )
      ).replayed,
    ).toBe(true);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member", "unlink"]);
    expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member", "remove-member"]);
    // The kept coordinator cannot unlink itself, and an unlinked copy cannot unlink again.
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) =>
            service.unlink({
              side: "member",
              operationId,
              projectId: pair.kept.projectId,
              notes: [],
            }),
          ),
        )
      ).code,
    ).toBe("not_linked");
  });

  it("matches, backfills and unlinks members recorded before folders, keyed by machine and project", async () => {
    const pair = legacyPair();
    const m2: LogicalProjectMember = {
      environmentId: EnvironmentId.make("m2"),
      projectId: ProjectId.make("easychamp-m2"),
      coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m2"),
    };
    // Stored by an older server: no member records its folder.
    const identity = Schema.decodeUnknownSync(LogicalProject)({
      id: "logical:legacy",
      title: "EasyChamp",
      coordinatorId: "coordinator:logical:legacy",
      members: [withoutRoot(pair.kept), m2],
    });
    expect(identity.members.some((member) => "workspaceRoot" in member)).toBe(false);
    const project = pair.m4.projects.get(pair.kept.projectId)!;
    pair.m4.projects.set(pair.kept.projectId, {
      ...project,
      workspaceSettings: { ...project.workspaceSettings!, logicalProject: identity },
    });
    const { prepared, accepted, committed } = await link(pair);
    // The kept server fills its own folder in; the joining server fills in its own.
    expect(prepared.kept).toEqual(pair.kept);
    expect(prepared.logicalProject.members).toEqual([pair.kept, m2]);
    expect(accepted.member).toEqual(pair.joining);
    expect(accepted.logicalProject.members).toEqual([pair.kept, m2, pair.joining]);
    expect(committed.logicalProject.members).toEqual([pair.kept, m2, pair.joining]);
    const stored = () =>
      pair.m4.projects.get(pair.kept.projectId)!.workspaceSettings!.logicalProject!.members;
    expect(stored()).toEqual([pair.kept, m2, pair.joining]);
    // Retries that carry no folders still match the rooted entries.
    const retried = await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: withoutRoot(pair.kept),
        logicalProject: identity,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      }),
    );
    expect(retried.replayed).toBe(true);
    const recommitted = await pair.m4.run((service) =>
      service.commit({
        operationId,
        projectId: pair.kept.projectId,
        joining: withoutRoot(pair.joining),
        notes: [],
      }),
    );
    expect(recommitted.replayed).toBe(true);
    expect(stored()).toEqual([pair.kept, m2, pair.joining]);
    // Unlinking matches by machine and project whether or not either side has a folder.
    const removed = await pair.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: unlinkId,
        projectId: pair.kept.projectId,
        member: withoutRoot(pair.joining),
      }),
    );
    expect(removed.logicalProject.members).toEqual([pair.kept, m2]);
    const removedLegacy = await pair.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: "33333333-3333-4333-8333-333333333333",
        projectId: pair.kept.projectId,
        member: { ...m2, workspaceRoot: "/Users/anton/elsewhere" },
      }),
    );
    expect(removedLegacy.logicalProject.members).toEqual([pair.kept]);
    expect(stored()).toEqual([pair.kept]);
    expect(pair.m4.ownershipModes).toEqual(["link-member", "remove-member", "remove-member"]);
  });

  it("fingerprints a project or a folder, never both", async () => {
    const pair = legacyPair();
    const root = pair.m4.projects.get(pair.kept.projectId)!.workspaceRoot;
    const byProject = await pair.m4.run((service) =>
      service.fingerprint({ projectId: pair.kept.projectId }),
    );
    const byFolder = await pair.m4.run((service) => service.fingerprint({ workspaceRoot: root }));
    expect(byFolder).toEqual(byProject);
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) =>
            service.fingerprint({ projectId: pair.kept.projectId, workspaceRoot: root }),
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) => service.fingerprint({ workspaceRoot: "relative" })),
        )
      ).code,
    ).toBe("invalid");
  });

  it("recomputes a digest only when a note, goal or instructions change", async () => {
    const pair = legacyPair();
    await link(pair);
    const notes = pair.m4.notes(pair.kept.projectId);
    notes.set("decisions.md", { content: "Ship 2.0", revision: 3 });
    const digest = () =>
      pair.m4
        .run((service) => service.digest({ projectId: pair.kept.projectId }))
        .then((result) => result.digest);
    const first = await digest();
    expect(await digest()).toBe(first);

    notes.set("decisions.md", { content: "Ship 3.0", revision: 4 });
    const second = await digest();
    expect(second).not.toBe(first);

    const kept = pair.m4.projects.get(pair.kept.projectId)!;
    pair.m4.projects.set(pair.kept.projectId, {
      ...kept,
      workspaceSettings: { ...kept.workspaceSettings!, goal: "A new goal" },
    });
    expect(await digest()).not.toBe(second);
  });

  describe("a coordinator on each machine", () => {
    const startId = "44444444-4444-4444-8444-444444444444";
    it("is a no-op on an active coordinator and refuses copies that are not linked members", async () => {
      const pair = legacyPair();
      await link(pair);
      const kept = await pair.m4.run((service) =>
        service.startCoordinator({ operationId: startId, projectId: pair.kept.projectId }),
      );
      expect(kept).toMatchObject({ replayed: true, coordinatorBinding: { state: "active" } });
      expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member"]);
      pair.m3.add("standalone", checkout("https://github.com/anton/other.git"));
      expect(
        (
          await pair.m3.fails(
            pair.m3.run((service) =>
              service.startCoordinator({
                operationId: startId,
                projectId: ProjectId.make("standalone"),
              }),
            ),
          )
        ).code,
      ).toBe("not_member");
      const joined = pair.m3.projects.get(pair.joining.projectId)!;
      pair.m3.projects.set(pair.joining.projectId, {
        ...joined,
        workspaceSettings: {
          ...joined.workspaceSettings!,
          coordinatorBinding: { epoch: 0, state: "transferring", operationId: startId },
        },
      });
      expect(
        (
          await pair.m3.fails(
            pair.m3.run((service) =>
              service.startCoordinator({ operationId: startId, projectId: pair.joining.projectId }),
            ),
          )
        ).code,
      ).toBe("handoff_in_progress");
    });
  });
});
