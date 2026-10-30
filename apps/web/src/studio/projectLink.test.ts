import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));

const {
  defaultKeptSide,
  departedMembers,
  linkCandidates,
  linkCopyAsWorkers,
  highestEpoch,
  linkedCopies,
  linkMachineProblem,
  linkMachineState,
  noteMergeComplete,
  noteMergeRows,
  noteWrites,
  pendingSupersedes,
  replicaMembers,
  takeoverAvailability,
  unlinkNoteWrites,
  unlinkUndoneCopy,
} = await import("./projectLink");
const { copyRolesSummary } = await import("./projectDomain");

const member = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const identity = (id: string, members: ReturnType<typeof member>[]) => ({
  id,
  title: "EasyChamp",
  coordinatorId: `coordinator:${id}`,
  members,
});
const copy = (
  environmentId: string,
  id: string,
  logicalProject: ReturnType<typeof identity> | undefined,
  state?: "active" | "transferred" | "transferring",
  environmentLabel?: string,
) =>
  ({
    environmentId,
    id,
    title: "EasyChamp",
    workspaceRoot: `/${environmentId}/EasyChamp`,
    environmentLabel,
    workspaceSettings: {
      kind: "code",
      ...(logicalProject ? { logicalProject } : {}),
      ...(state ? { coordinatorBinding: { epoch: 2, state } } : {}),
    },
  }) as unknown as EnvironmentProject & { environmentLabel?: string };
const note = (name: string, content: string, revision = 1) => ({ name, content, revision });

describe("machine readiness", () => {
  it("names the one fix for each machine that cannot link", () => {
    const state = (connected: boolean, supportsLink: boolean | undefined, canWrite: boolean) =>
      linkMachineState({ connected, supportsLink, canWrite });
    expect(state(true, true, true)).toBe("ready");
    expect(linkMachineProblem(state(false, true, true), "M3")).toBe("Connect M3 first.");
    // A 1.0.55 server reports no capability at all.
    expect(linkMachineProblem(state(true, undefined, true), "M3")).toBe(
      "Update SpecWithCode on M3 to link projects.",
    );
    expect(linkMachineProblem(state(true, true, false), "M3")).toContain("needs permission");
  });
});

describe("kept side", () => {
  it("defaults to the most recent coordinator, unless that copy cannot keep it", () => {
    const side = (
      lastCoordinatorActivityAt: string | null,
      keepRefusal: null | "paused" = null,
    ) => ({
      lastCoordinatorActivityAt,
      keepRefusal,
    });
    expect(defaultKeptSide(side("2026-10-18T00:00:00Z"), side("2026-10-19T00:00:00Z"))).toBe(
      "there",
    );
    expect(defaultKeptSide(side("2026-10-19T00:00:00Z"), side(null))).toBe("here");
    expect(defaultKeptSide(side(null), side(null))).toBe("here");
    expect(
      defaultKeptSide(side("2026-10-18T00:00:00Z"), side("2026-10-19T00:00:00Z", "paused")),
    ).toBe("here");
  });
});

describe("notes", () => {
  const kept = [
    note("plan.md", "kept plan", 3),
    note("plan-m4.md", "older copy", 7),
    note("a.md", "same"),
  ];
  const joining = [note("plan.md", "joining plan"), note("a.md", "same"), note("new.md", "new")];

  it("copies notes the kept copy lacks and overwrites nothing without a choice", () => {
    const rows = noteMergeRows(kept, joining);
    expect(rows.map((row) => [row.name, row.kind])).toEqual([
      ["a.md", "same"],
      ["new.md", "copy"],
      ["plan-m4.md", "kept-only"],
      ["plan.md", "conflict"],
    ]);
    expect(noteMergeComplete(rows, {})).toBe(false);
    expect(noteWrites(rows, { "plan.md": "kept" }, "M4", kept)).toEqual([
      { name: "new.md", content: "new", expectedRevision: null },
    ]);
    expect(noteWrites(rows, { "plan.md": "joining" }, "M4", kept)).toContainEqual({
      name: "plan.md",
      content: "joining plan",
      expectedRevision: 3,
    });
    // Keep both writes a second, named note beside the kept one it never replaces.
    expect(noteWrites(rows, { "plan.md": "both" }, "M4", kept)).toEqual([
      { name: "new.md", content: "new", expectedRevision: null },
      { name: "plan-m4-2.md", content: "joining plan", expectedRevision: null, createOnly: true },
    ]);
  });

  it("never lands a kept-both copy on a note the user chose to keep", () => {
    const keptNotes = [note("plan.md", "KEEP ORIGINAL", 3), note("plan-m4.md", "KEEP THIS TOO", 7)];
    const joiningNotes = [
      note("plan.md", "JOINING PLAN", 1),
      note("plan-m4.md", "OTHER GENERATED NOTE", 2),
    ];
    const rows = noteMergeRows(keptNotes, joiningNotes);
    const writes = noteWrites(rows, { "plan.md": "both", "plan-m4.md": "kept" }, "M4", keptNotes);
    expect(writes).toEqual([
      { name: "plan-m4-2.md", content: "JOINING PLAN", expectedRevision: null, createOnly: true },
    ]);
    // Taking the joining text for plan-m4.md still overwrites it on purpose.
    expect(
      noteWrites(rows, { "plan.md": "both", "plan-m4.md": "joining" }, "M4", keptNotes),
    ).toEqual([
      { name: "plan-m4.md", content: "OTHER GENERATED NOTE", expectedRevision: 7 },
      { name: "plan-m4-2.md", content: "JOINING PLAN", expectedRevision: null, createOnly: true },
    ]);
  });

  it("gives competing kept-both copies and copied notes their own names", () => {
    const keptNotes = [note("plan.md", "kept plan", 3), note("plan-m4.md", "kept copy", 4)];
    const joiningNotes = [
      note("plan.md", "joining plan"),
      note("plan-m4.md", "joining copy"),
      // Copied as is; its name is reserved before any kept-both copy is named.
      note("plan-m4-2.md", "copied note"),
    ];
    const rows = noteMergeRows(keptNotes, joiningNotes);
    const writes = noteWrites(rows, { "plan.md": "both", "plan-m4.md": "both" }, "M4", keptNotes);
    expect(writes).toEqual([
      { name: "plan-m4-2.md", content: "copied note", expectedRevision: null },
      { name: "plan-m4-m4.md", content: "joining copy", expectedRevision: null, createOnly: true },
      { name: "plan-m4-3.md", content: "joining plan", expectedRevision: null, createOnly: true },
    ]);
    expect(new Set(writes.map((write) => write.name)).size).toBe(writes.length);
  });

  it("gives two kept-both copies that trim to one name different names", () => {
    const [a, b] = [`${"n".repeat(124)}a.md`, `${"n".repeat(124)}b.md`];
    const keptNotes = [note(a, "kept a"), note(b, "kept b")];
    const rows = noteMergeRows(keptNotes, [note(a, "joining a"), note(b, "joining b")]);
    const writes = noteWrites(rows, { [a]: "both", [b]: "both" }, "M4", keptNotes);
    expect(writes.map((write) => [write.name, write.content])).toEqual([
      [`${"n".repeat(124)}.md`, "joining a"],
      [`${"n".repeat(122)}-2.md`, "joining b"],
    ]);
  });

  it("names a retried kept-both copy as its first attempt did", () => {
    const keptNotes = [note("plan.md", "KEEP ORIGINAL", 3), note("plan-m4.md", "KEEP THIS TOO", 7)];
    const joiningNotes = [note("plan.md", "JOINING PLAN", 1)];
    const choices = { "plan.md": "both" } as const;
    const [first] = noteWrites(noteMergeRows(keptNotes, joiningNotes), choices, "M4", keptNotes);
    expect(first?.name).toBe("plan-m4-2.md");
    // The first commit wrote it; a retry previews it and targets the same name.
    const landed = [...keptNotes, note("plan-m4-2.md", "JOINING PLAN", 1)];
    expect(noteWrites(noteMergeRows(landed, joiningNotes), choices, "M4", landed)).toEqual([first]);
  });

  it("gives an unlinking copy the kept notes without replacing its own", () => {
    expect(unlinkNoteWrites(kept, joining, "M3")).toEqual([
      { name: "plan-m4.md", content: "older copy", expectedRevision: null },
      { name: "plan-m3.md", content: "kept plan", expectedRevision: null, createOnly: true },
    ]);
    // Its own note under the kept-both name stays; the copy takes the next name.
    const member = [note("plan.md", "member plan", 2), note("plan-m4.md", "member copy", 5)];
    expect(unlinkNoteWrites([note("plan.md", "COORDINATOR", 1)], member, "M4")).toEqual([
      { name: "plan-m4-2.md", content: "COORDINATOR", expectedRevision: null, createOnly: true },
    ]);
  });
});

describe("copies of a shared project", () => {
  const shared = identity("logical:1", [member("m3", "kept"), member("m4", "joined")]);
  const kept = copy("m3", "kept", shared, "active", "Anton's M3");
  const joined = copy("m4", "joined", shared, "transferred", "Anton's M4");

  it("labels each machine's copy with its role", () => {
    expect(linkedCopies([kept, joined], kept).map((item) => [item.role, item.unfinished])).toEqual([
      ["coordinator", false],
      ["workers", false],
    ]);
    expect(copyRolesSummary([kept, joined])).toBe("M3: coordinator · M4: runs workers");
    expect(copyRolesSummary([kept])).toBeNull();
  });

  it("labels every machine that runs its own coordinator", () => {
    expect(linkedCopies([kept, joined], kept, [joined]).map((item) => item.role)).toEqual([
      "coordinator",
      "coordinator",
    ]);
  });

  it("finds a joined copy the coordinator does not list yet", () => {
    const lonely = copy("m3", "kept", identity("logical:1", [member("m3", "kept")]), "active");
    expect(linkedCopies([lonely, joined], lonely)[1]).toMatchObject({
      role: "workers",
      unfinished: true,
    });
  });

  it("finds copies that unlinked while the coordinator was away", () => {
    const left = copy("m4", "joined", identity("logical:2", [member("m4", "joined")]), "active");
    expect(departedMembers(kept, [kept, left]).map((item) => item.id)).toEqual(["joined"]);
    expect(departedMembers(kept, [kept, joined])).toEqual([]);
  });
});

describe("linkCopyAsWorkers", () => {
  const fingerprint = (originKey: string) => ({
    root: "repository" as const,
    repositories: [{ path: "", originKey, worktrees: 0 }],
    skippedLinks: 0,
    truncated: false,
  });
  const preview = (
    environmentId: string,
    projectId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    member: member(environmentId, projectId),
    title: "EasyChamp",
    workspaceRoot: `/p/${projectId}`,
    logicalProject: null,
    coordinatorBinding: null,
    fingerprint: fingerprint("github.com/team/easychamp"),
    goal: "",
    instructions: "",
    notes: [] as Array<{ name: string; content: string; revision: number }>,
    notesTruncated: false,
    lastCoordinatorActivityAt: null,
    keepRefusal: null,
    joinRefusal: null,
    ...overrides,
  });
  const ok = <A>(value: A) => Promise.resolve({ _tag: "Success" as const, value });
  const commands = (previews: Record<string, ReturnType<typeof preview>>, calls: string[]) => ({
    preview: vi.fn(({ environmentId }: { environmentId: string }) => ok(previews[environmentId]!)),
    prepare: vi.fn(
      ({ environmentId, input }: { environmentId: string; input: { joining: unknown } }) => {
        calls.push(`prepare@${environmentId}`);
        expect(input.joining).toEqual(member("m3", "copy"));
        return ok({
          operationId: "op",
          kept: member("m4", "source"),
          logicalProject: identity("logical:1", [member("m4", "source")]),
          coordinatorBinding: { epoch: 0, state: "active" as const, operationId: "op" },
          fingerprint: fingerprint("github.com/team/easychamp"),
          adopted: true,
        });
      },
    ),
    accept: vi.fn(({ environmentId }: { environmentId: string }) => {
      calls.push(`accept@${environmentId}`);
      return ok({ member: member("m3", "copy") });
    }),
    commit: vi.fn(
      ({ environmentId, input }: { environmentId: string; input: { notes: unknown[] } }) => {
        calls.push(`commit@${environmentId}:${input.notes.length}`);
        return ok({
          operationId: "op",
          logicalProject: identity("logical:1", []),
          notesWritten: 0,
          replayed: false,
        });
      },
    ),
  });
  const input = {
    kept: { environmentId: "m4", projectId: "source" },
    joining: { environmentId: "m3", projectId: "copy" },
    keptLabel: "M4",
    joiningLabel: "M3",
    newOperationId: () => "8d3c6f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  } as never;

  it("links a fresh copy as a worker member, the coordinator staying on the source", async () => {
    const calls: string[] = [];
    const outcome = await linkCopyAsWorkers(
      commands({ m4: preview("m4", "source"), m3: preview("m3", "copy") }, calls) as never,
      input,
    );
    expect(outcome).toEqual({ status: "linked" });
    expect(calls).toEqual(["prepare@m4", "accept@m3", "commit@m4:0"]);
  });

  it("links a copy of a repository that has no origin by its checked-out commit", async () => {
    const local = (head: string) => ({
      root: "repository" as const,
      repositories: [{ path: "", originKey: null, worktrees: 0, head }],
      skippedLinks: 0,
      truncated: false,
    });
    const head = "a".repeat(40);
    const calls: string[] = [];
    const outcome = await linkCopyAsWorkers(
      commands(
        {
          m4: preview("m4", "source", { fingerprint: local(head) }),
          m3: preview("m3", "copy", { fingerprint: local(head) }),
        },
        calls,
      ) as never,
      input,
    );
    expect(outcome).toEqual({ status: "linked" });
    const different = await linkCopyAsWorkers(
      commands(
        {
          m4: preview("m4", "source", { fingerprint: local(head) }),
          m3: preview("m3", "copy", { fingerprint: local("b".repeat(40)) }),
        },
        [],
      ) as never,
      input,
    );
    expect(different.status === "review" && different.reason).toMatch(/does not match/);
  });

  it("leaves notes that differ, a refusal or another repository to the link review", async () => {
    const note = (content: string) => ({ name: "plan.md", content, revision: 1 });
    for (const [joining, reason] of [
      [preview("m3", "copy", { notes: [note("theirs")] }), /notes differ on M3/],
      [preview("m3", "copy", { joinRefusal: "already_shared" }), /already shared/],
      [
        preview("m3", "copy", { fingerprint: fingerprint("github.com/team/other") }),
        /does not match/,
      ],
    ] as const) {
      const calls: string[] = [];
      const outcome = await linkCopyAsWorkers(
        commands(
          { m4: preview("m4", "source", { notes: [note("mine")] }), m3: joining },
          calls,
        ) as never,
        input,
      );
      expect(outcome.status).toBe("review");
      expect(outcome.status === "review" && outcome.reason).toMatch(reason);
      expect(calls).toEqual([]);
    }
  });
});

describe("coordinator takeover", () => {
  const shared = identity("logical:1", [member("m3", "kept"), member("m4", "joined")]);
  const withBinding = (
    project: EnvironmentProject,
    binding: Record<string, unknown>,
  ): EnvironmentProject =>
    ({
      ...project,
      workspaceSettings: { ...project.workspaceSettings, coordinatorBinding: binding },
    }) as EnvironmentProject;

  it("waits 10 minutes after the coordinator was last seen, and never while it is connected", () => {
    const now = 1_000_000_000;
    expect(
      takeoverAvailability({ coordinatorConnected: true, unreachableSince: now - 3_600_000, now }),
    ).toEqual({ available: false, waitMs: 600_000 });
    expect(
      takeoverAvailability({ coordinatorConnected: false, unreachableSince: now - 240_000, now }),
    ).toEqual({ available: false, waitMs: 360_000 });
    expect(
      takeoverAvailability({ coordinatorConnected: false, unreachableSince: now - 600_000, now }),
    ).toEqual({ available: true, waitMs: 0 });
    expect(
      takeoverAvailability({ coordinatorConnected: false, unreachableSince: null, now }).available,
    ).toBe(false);
  });

  it("finds the coordinator that must give way and the members that keep replicas", () => {
    const kept = copy("m3", "kept", shared, "active");
    const joined = copy("m4", "joined", shared, "transferred");
    expect(highestEpoch([kept, joined])).toBe(2);
    expect(replicaMembers(kept, [kept, joined])).toEqual([joined]);
    expect(pendingSupersedes([kept, joined])).toEqual([]);

    const tookOver = withBinding(joined, {
      epoch: 3,
      state: "active",
      operationId: "op-1",
      predecessor: member("m3", "kept"),
      takenOverAt: "2026-10-19T12:10:00.000Z",
    });
    expect(pendingSupersedes([kept, tookOver])).toEqual([{ successor: tookOver, previous: kept }]);
    // Once the old owner gave way, nothing is pending; a newer owner never gives way to an older one.
    const gaveWay = withBinding(kept, {
      epoch: 3,
      state: "transferred",
      successor: member("m4", "joined"),
    });
    expect(pendingSupersedes([gaveWay, tookOver])).toEqual([]);
    expect(pendingSupersedes([withBinding(kept, { epoch: 4, state: "active" }), tookOver])).toEqual(
      [],
    );
    expect(replicaMembers(tookOver, [gaveWay, tookOver])).toEqual([gaveWay]);
  });
});

describe("unlinkUndoneCopy", () => {
  it("has the copy leave first, then the kept project drop it, without copying notes", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const ok = <A>(value: A) => Promise.resolve({ _tag: "Success" as const, value });
    const record = (name: string) => (args: { environmentId: string; input: unknown }) => {
      calls.push([name, args.environmentId, args.input]);
      return ok(name === "preview" ? { member: member("minis", "copy") } : {});
    };
    await unlinkUndoneCopy({ preview: record("preview"), unlink: record("unlink") } as never, {
      kept: { environmentId: "m4" as never, projectId: "kept" as never },
      joining: { environmentId: "minis" as never, projectId: "copy" as never },
      newOperationId: () => "op-undo",
    });
    expect(calls).toEqual([
      ["preview", "minis", { projectId: "copy" }],
      ["unlink", "minis", { side: "member", operationId: "op-undo", projectId: "copy", notes: [] }],
      [
        "unlink",
        "m4",
        {
          side: "coordinator",
          operationId: "op-undo",
          projectId: "kept",
          member: member("minis", "copy"),
        },
      ],
    ]);
  });

  it("stops before the kept side when the copy cannot leave", async () => {
    const unlink = vi.fn(() =>
      Promise.resolve({ _tag: "Failure" as const, cause: new Error("offline") }),
    );
    await expect(
      unlinkUndoneCopy(
        {
          preview: () =>
            Promise.resolve({
              _tag: "Success" as const,
              value: { member: member("minis", "copy") },
            }),
          unlink,
        } as never,
        {
          kept: { environmentId: "m4" as never, projectId: "kept" as never },
          joining: { environmentId: "minis" as never, projectId: "copy" as never },
          newOperationId: () => "op-undo",
        },
      ),
    ).rejects.toThrow("offline");
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});

describe("linkCandidates", () => {
  const here = copy("m4", "here", identity("shared", []));
  const project = (environmentId: string, id: string, settings: Record<string, unknown> = {}) =>
    ({
      ...copy(environmentId, id, undefined),
      workspaceSettings: { kind: "code", ...settings },
    }) as unknown as EnvironmentProject;
  const scratch = {
    ...project("m3", "scratch"),
    workspaceRoot: "/m3/.specweave-studio/scratch",
  } as EnvironmentProject;
  const scratchRootFor = (environmentId: string | null) =>
    environmentId === "m3" ? "/m3/.specweave-studio/scratch" : null;
  const ids = (projects: ReadonlyArray<EnvironmentProject>) =>
    projects.map((item) => `${item.environmentId}:${item.id}`);
  const linked = copy("m1", "joined", identity("shared", []));
  const projects = [
    copy("m4", "local", undefined),
    project("m3", "own"),
    scratch,
    project("m3", "archived", { archived: true }),
    project("m3", "automated", { origin: "automated" }),
    project("m3", "design", { kind: "design" }),
    linked,
  ];

  it("offers only the person's own code projects on other machines", () => {
    expect(ids(linkCandidates(projects, here, scratchRootFor as never, null))).toEqual(["m3:own"]);
  });

  it("keeps the named copy even when it is already linked, archived or automated", () => {
    const offered = (environmentId: string, projectId: string) =>
      ids(
        linkCandidates(
          projects,
          here,
          scratchRootFor as never,
          {
            environmentId,
            projectId,
          } as never,
        ),
      );
    expect(offered("m1", "joined")).toEqual(["m3:own", "m1:joined"]);
    expect(offered("m3", "archived")).toEqual(["m3:own", "m3:archived"]);
    expect(offered("m3", "automated")).toEqual(["m3:own", "m3:automated"]);
  });
});
