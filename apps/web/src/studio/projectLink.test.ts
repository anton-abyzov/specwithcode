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
  linkCopyAsWorkers,
  linkedCopies,
  linkMachineProblem,
  linkMachineState,
  noteMergeComplete,
  noteMergeRows,
  noteWrites,
  unlinkNoteWrites,
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
    // Keep both writes a second, named note, guarded by that note's own revision.
    expect(noteWrites(rows, { "plan.md": "both" }, "M4", kept)).toContainEqual({
      name: "plan-m4.md",
      content: "joining plan",
      expectedRevision: 7,
    });
  });

  it("gives an unlinking copy the kept notes without replacing its own", () => {
    expect(unlinkNoteWrites(kept, joining, "M3")).toEqual([
      { name: "plan-m3.md", content: "kept plan", expectedRevision: null },
      { name: "plan-m4.md", content: "older copy", expectedRevision: null },
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
