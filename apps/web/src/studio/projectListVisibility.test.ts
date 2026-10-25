import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedMemberKeys,
  archiveWorkspacePatch,
  ineligibleProjectLabel,
  ineligibleSelectedGroup,
  ineligibleSelectedMember,
  isArchivedGroup,
  isAutomatedGroup,
  isOrdinaryProjectChoice,
  membersToMark,
  originWorkspacePatch,
  isScratchGroup,
  membersToToggle,
  partitionProjectGroups,
  projectChoiceIneligibleReason,
  projectPickerGroups,
  projectPickerMembers,
  type ProjectListMember,
  type ProjectPickerPurpose,
} from "./projectListVisibility";

const SCRATCH: Record<string, string> = {
  host: "/home/user/.studio/scratch",
  remote: "/srv/studio/scratch",
};
const scratchRootFor = (environmentId: EnvironmentId) => SCRATCH[environmentId] ?? null;

function member(
  environmentId: string,
  id: string,
  workspaceRoot: string,
  settings?: {
    archived?: boolean;
    revision?: number;
    origin?: "user" | "automated";
    kind?: "code" | "personal";
  },
): ProjectListMember {
  return {
    environmentId: environmentId as EnvironmentId,
    id: id as ProjectId,
    workspaceRoot,
    ...(settings ? { workspaceSettings: settings } : {}),
  };
}
const group = (projectKey: string, ...memberProjects: ProjectListMember[]) => ({
  projectKey,
  memberProjects,
});

const atlas = group("atlas", member("host", "a1", "/work/atlas"));
const hostScratch = group("host:scratch", member("host", "s1", "/home/user/.studio/scratch"));
const remoteScratch = group("remote:scratch", member("remote", "s2", "/srv/studio/scratch"));
const samples = group(
  "remote:samples",
  member("remote", "r1", "/srv/samples", { archived: true, revision: 3 }),
);
const shared = group(
  "shared",
  member("host", "h1", "/work/shared", { archived: true, revision: 1 }),
  member("remote", "h2", "/srv/shared", { archived: false, revision: 4 }),
);

describe("project list visibility", () => {
  it("never lists a machine's scratch project, whatever machine it is on", () => {
    expect(isScratchGroup(hostScratch, scratchRootFor)).toBe(true);
    expect(isScratchGroup(remoteScratch, scratchRootFor)).toBe(true);
    expect(isScratchGroup(atlas, scratchRootFor)).toBe(false);
    const { listed, archived } = partitionProjectGroups(
      [atlas, hostScratch, remoteScratch],
      scratchRootFor,
    );
    expect(listed.map((entry) => entry.projectKey)).toEqual(["atlas"]);
    expect(archived).toEqual([]);
  });

  it("keeps a folder named scratch elsewhere, and a machine that reports no scratch root", () => {
    const lookalike = group("lookalike", member("host", "x", "/work/scratch"));
    const unknown = group("unknown", member("other", "y", "/home/user/.studio/scratch"));
    // A project on the data folder that holds scratch is not scratch itself.
    const parent = group("parent", member("host", "z", "/home/user/.studio"));
    const { listed, automated } = partitionProjectGroups(
      [lookalike, unknown, parent],
      scratchRootFor,
    );
    // Still rows: a folder named scratch reads as a check's project, not as "No project".
    expect(listed.map((entry) => entry.projectKey)).toEqual(["parent"]);
    expect(automated.map((entry) => entry.projectKey)).toEqual(["lookalike", "unknown"]);
  });

  it("moves a project archived on every machine to the archived list", () => {
    expect(isArchivedGroup(samples, scratchRootFor)).toBe(true);
    // Still open for work on one machine: it stays in the main list.
    expect(isArchivedGroup(shared, scratchRootFor)).toBe(false);
    const { listed, archived } = partitionProjectGroups([atlas, samples, shared], scratchRootFor);
    expect(listed.map((entry) => entry.projectKey)).toEqual(["atlas", "shared"]);
    expect(archived.map((entry) => entry.projectKey)).toEqual(["remote:samples"]);
  });

  it("keeps the open project's row even when it is archived", () => {
    const { listed, archived } = partitionProjectGroups(
      [atlas, samples],
      scratchRootFor,
      "remote:samples",
    );
    expect(listed.map((entry) => entry.projectKey)).toEqual(["atlas", "remote:samples"]);
    expect(archived).toEqual([]);
  });

  it("keeps an archived project with threads waiting on the person in the main list", () => {
    const quiet = group(
      "remote:quiet",
      member("remote", "q1", "/srv/quiet", { archived: true, revision: 1 }),
    );
    const { listed, archived } = partitionProjectGroups(
      [atlas, samples, quiet],
      scratchRootFor,
      null,
      (projectKey) => projectKey === "remote:samples",
    );
    expect(listed.map((entry) => entry.projectKey)).toEqual(["atlas", "remote:samples"]);
    expect(archived.map((entry) => entry.projectKey)).toEqual(["remote:quiet"]);
  });

  it("archives with the revision the project was read at, defaulting to the first", () => {
    expect(archiveWorkspacePatch(samples.memberProjects[0]!, false)).toEqual({
      expectedRevision: 3,
      archived: false,
    });
    expect(archiveWorkspacePatch(atlas.memberProjects[0]!, true)).toEqual({
      expectedRevision: 0,
      archived: true,
    });
  });

  it("changes only the members not already in the asked state, never a scratch project", () => {
    expect(membersToToggle(shared, true, scratchRootFor).map((entry) => entry.id)).toEqual(["h2"]);
    expect(membersToToggle(shared, false, scratchRootFor).map((entry) => entry.id)).toEqual(["h1"]);
    expect(membersToToggle(hostScratch, true, scratchRootFor)).toEqual([]);
  });
});

describe("project pickers", () => {
  const check = group("check", member("host", "c1", "/Users/x/.specwithcode/m4/scratch/run/ws"));
  const flagged = group("flagged", member("host", "f1", "/work/flagged", { origin: "automated" }));
  const archivedCheck = group("old-check", member("host", "o1", "/tmp/old", { archived: true }));
  const aide = group(
    "aide",
    member("host", "p1", "/Users/x/.specwithcode/m4/projects/aide", {
      kind: "personal",
    }),
  );
  const typed = group("typed", member("host", "t1", "/work/typed", { kind: "code" }));
  const pickerGroups = [
    atlas,
    hostScratch,
    remoteScratch,
    samples,
    shared,
    check,
    flagged,
    archivedCheck,
    aide,
    typed,
  ];
  const members = pickerGroups.flatMap((g) => g.memberProjects);
  const select = (environmentId: string, id: string) => ({
    environmentId: environmentId as EnvironmentId,
    id: id as ProjectId,
  });

  it("offers only the person's own projects: no archived, automated or No project row", () => {
    expect(projectPickerGroups(pickerGroups, scratchRootFor).map((g) => g.projectKey)).toEqual([
      "atlas",
      "shared",
      "aide",
      "typed",
    ]);
    expect(projectPickerMembers(members, scratchRootFor).map((m) => m.id)).toEqual([
      "a1",
      "h2",
      "p1",
      "t1",
    ]);
  });

  it("rejects mixed groups when no one checkout satisfies the whole eligibility rule", () => {
    const mixed = group(
      "mixed",
      member("host", "old", "/work/old", { archived: true }),
      member("remote", "auto", "/work/auto", { origin: "automated" }),
    );
    expect(projectPickerGroups([mixed], scratchRootFor)).toEqual([]);
    expect(ineligibleSelectedGroup([mixed], "mixed", scratchRootFor)?.reason).toBe("archived");
    const wrongKinds = group(
      "kinds",
      member("host", "personal", "/work/a", { kind: "personal" }),
      member("remote", "old-code", "/work/code", { kind: "code", archived: true }),
    );
    expect(projectPickerGroups([wrongKinds], scratchRootFor, { purpose: "code" })).toEqual([]);
    expect(projectPickerGroups([wrongKinds], scratchRootFor)).toEqual([wrongKinds]);
  });

  it("never offers an archived or automated selection; describes it apart instead", () => {
    const describeGroup = (key: string | null) => {
      const selection = ineligibleSelectedGroup(pickerGroups, key, scratchRootFor);
      return selection && [selection.project.projectKey, selection.reason];
    };
    expect(describeGroup("remote:samples")).toEqual(["remote:samples", "archived"]);
    expect(describeGroup("check")).toEqual(["check", "automated"]);
    expect(describeGroup("flagged")).toEqual(["flagged", "automated"]);
    // An archived automated project reads as archived, as the sidebar files it.
    expect(describeGroup("old-check")).toEqual(["old-check", "archived"]);
    expect(describeGroup("host:scratch")).toEqual(["host:scratch", "scratch"]);
    expect(describeGroup("atlas")).toBeNull();
    expect(describeGroup("gone")).toBeNull();
    expect(describeGroup(null)).toBeNull();

    const describeMember = (environmentId: string, id: string) =>
      ineligibleSelectedMember(members, select(environmentId, id), scratchRootFor)?.reason ?? null;
    expect(describeMember("remote", "r1")).toBe("archived");
    expect(describeMember("host", "c1")).toBe("automated");
    expect(describeMember("host", "s1")).toBe("scratch");
    // Machine and id both have to match.
    expect(describeMember("host", "r1")).toBeNull();
    expect(describeMember("host", "a1")).toBeNull();
    expect(ineligibleSelectedMember(members, null, scratchRootFor)).toBeNull();
  });

  it("says why a current selection cannot be chosen", () => {
    expect(ineligibleProjectLabel("archived")).toBe("Archived project, not available here");
    expect(ineligibleProjectLabel("automated")).toBe("Automated project, not available here");
    expect(ineligibleProjectLabel("scratch")).toBe("No project, not available here");
    expect(ineligibleProjectLabel("not-code")).toBe("Not a code project, not available here");
  });

  it("keeps personal assistants for work and design, and only code projects for code", () => {
    const offered = (purpose: ProjectPickerPurpose) =>
      projectPickerMembers(members, scratchRootFor, { purpose }).map((m) => m.id);
    expect(offered("work")).toEqual(["a1", "h2", "p1", "t1"]);
    expect(offered("design")).toEqual(["a1", "h2", "p1", "t1"]);
    // A project saved before kinds existed is a code project.
    expect(offered("code")).toEqual(["a1", "h2", "t1"]);
    expect(
      projectPickerGroups(pickerGroups, scratchRootFor, { purpose: "code" }).map(
        (g) => g.projectKey,
      ),
    ).toEqual(["atlas", "shared", "typed"]);
    expect(ineligibleSelectedMember(members, select("host", "p1"), scratchRootFor, "code")).toEqual(
      { project: aide.memberProjects[0], reason: "not-code" },
    );
    expect(ineligibleSelectedGroup(pickerGroups, "aide", scratchRootFor, "code")?.reason).toBe(
      "not-code",
    );
    expect(ineligibleSelectedGroup(pickerGroups, "aide", scratchRootFor, "design")).toBeNull();
  });

  it("lists automated projects after the person's own only when a management list asks", () => {
    expect(
      projectPickerGroups(pickerGroups, scratchRootFor, { includeAutomated: true }).map(
        (g) => g.projectKey,
      ),
    ).toEqual(["atlas", "shared", "aide", "typed", "check", "flagged"]);
    expect(
      projectPickerMembers(members, scratchRootFor, { includeAutomated: true }).map((m) => m.id),
    ).toEqual(["a1", "h2", "p1", "t1", "c1", "f1"]);
  });

  // Part B of the 1041 dropdown audit: every ordinary project choice and the helper it uses.
  const AUDITED_PICKERS: ReadonlyArray<
    readonly [string, ProjectPickerPurpose, "member" | "group"]
  > = [
    ["New design / New slides Save in", "design", "member"],
    ["Design from code project", "code", "member"],
    ["Design gallery project filter", "design", "member"],
    ["Design system Save in", "design", "member"],
    ["Scan from code project", "code", "member"],
    ["Design system Copy into", "design", "member"],
    ["Command palette projects", "work", "member"],
    ["Chats sidebar project scope", "work", "group"],
    ["Overview draft project", "work", "member"],
    ["Move thread to project", "work", "member"],
    ["Telegram channel project", "work", "member"],
    ["Routine project", "work", "member"],
    ["Settings scope project", "work", "group"],
    ["Pull requests project filter", "work", "member"],
    ["New chat hero project", "work", "member"],
    ["Draft machine destination project", "work", "member"],
    ["ACP sessions and providers project", "work", "member"],
  ];

  it.each(AUDITED_PICKERS)("%s: own projects only, a stale selection apart", (_, purpose, rows) => {
    const own = ["a1", "h2", ...(purpose === "code" ? [] : ["p1"]), "t1"];
    if (rows === "group") {
      const offered = projectPickerGroups(pickerGroups, scratchRootFor, { purpose });
      expect(offered.flatMap((g) => g.memberProjects).map((m) => m.id)).toEqual(
        // A group stays while one machine's copy is open for work.
        ["a1", "h1", "h2", ...own.slice(2)],
      );
      for (const key of ["remote:samples", "check", "flagged"]) {
        expect(offered.some((g) => g.projectKey === key)).toBe(false);
        expect(ineligibleSelectedGroup(pickerGroups, key, scratchRootFor, purpose)).not.toBeNull();
      }
      return;
    }
    const offered = projectPickerMembers(members, scratchRootFor, { purpose });
    expect(offered.map((m) => m.id)).toEqual(own);
    expect(offered.every((m) => isOrdinaryProjectChoice(m, scratchRootFor, purpose))).toBe(true);
    for (const [environmentId, id, reason] of [
      ["remote", "r1", "archived"],
      ["host", "c1", "automated"],
      ["host", "f1", "automated"],
      ["host", "s1", "scratch"],
    ] as const) {
      expect(offered.some((m) => m.id === id)).toBe(false);
      expect(
        ineligibleSelectedMember(members, select(environmentId, id), scratchRootFor, purpose)
          ?.reason,
      ).toBe(reason);
      expect(
        projectChoiceIneligibleReason(
          members.find((m) => m.id === id)!,
          scratchRootFor,
          purpose,
        ),
      ).toBe(reason);
    }
  });
});

describe("archivedMemberKeys", () => {
  it("names every checkout of an archived project and nothing else", () => {
    const member = (environmentId: string, id: string, archived?: boolean): ProjectListMember =>
      ({
        environmentId,
        id,
        workspaceRoot: `/w/${id}`,
        workspaceSettings: archived === undefined ? null : { archived },
      }) as unknown as ProjectListMember;
    const keys = archivedMemberKeys(
      [
        { projectKey: "old", memberProjects: [member("m1", "a", true), member("m4", "b", true)] },
        { projectKey: "mixed", memberProjects: [member("m1", "c", true), member("m4", "d")] },
        { projectKey: "live", memberProjects: [member("m1", "e")] },
      ],
      () => null,
    );
    expect([...keys].sort()).toEqual(["m1:a", "m4:b"]);
  });
});

describe("automated projects", () => {
  const check = group(
    "check",
    member("host", "c1", "/Users/x/.specwithcode/m4/scratch/run-shell/workspace", {
      revision: 1,
    }),
  );
  const flagged = group("flagged", member("host", "f1", "/work/flagged", { origin: "automated" }));
  const kept = group("kept", member("host", "k1", "/work/scratch/kept", { origin: "user" }));
  // One machine's copy is the person's own, so the project stays in the main list.
  const mixed = group(
    "mixed",
    member("host", "m1", "/work/mixed"),
    member("remote", "m2", "/tmp/mixed-copy"),
  );

  it("lists projects checks made apart from the person's own", () => {
    const { listed, automated, archived } = partitionProjectGroups(
      [atlas, check, flagged, kept, mixed, samples, hostScratch],
      scratchRootFor,
    );
    expect(listed.map((g) => g.projectKey)).toEqual(["atlas", "kept", "mixed"]);
    expect(automated.map((g) => g.projectKey)).toEqual(["check", "flagged"]);
    expect(archived.map((g) => g.projectKey)).toEqual(["remote:samples"]);
    expect(isAutomatedGroup(hostScratch, scratchRootFor)).toBe(false);
  });

  it("keeps an archived automated project under Archived", () => {
    const archivedCheck = group("old-check", member("host", "o1", "/tmp/old", { archived: true }));
    const { automated, archived } = partitionProjectGroups([archivedCheck], scratchRootFor);
    expect(automated).toEqual([]);
    expect(archived.map((g) => g.projectKey)).toEqual(["old-check"]);
  });

  it("offers no automated project in pickers, while one copy that is the person's keeps it", () => {
    expect(
      projectPickerGroups([check, atlas, kept, mixed], scratchRootFor).map((g) => g.projectKey),
    ).toEqual(["atlas", "kept", "mixed"]);
    expect(
      projectPickerMembers(
        [check, atlas, kept, mixed].flatMap((g) => g.memberProjects),
        scratchRootFor,
      ).map((m) => m.id),
    ).toEqual(["a1", "k1", "m1"]);
  });

  it("moves every machine's copy with its revision, skipping copies already there", () => {
    expect(membersToMark(check, "user", scratchRootFor).map((m) => m.id)).toEqual(["c1"]);
    expect(originWorkspacePatch(check.memberProjects[0]!, "user")).toEqual({
      expectedRevision: 1,
      origin: "user",
    });
    expect(membersToMark(kept, "user", scratchRootFor)).toEqual([]);
    expect(membersToMark(mixed, "automated", scratchRootFor).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });
});
