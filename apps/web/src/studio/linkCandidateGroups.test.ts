import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));

const { bestLinkCopy, linkCandidateGroups, linkedMainEnvironmentId } =
  await import("./linkCandidateGroups");
const { fingerprintSummary, rankCandidates } = await import("./projectLink");
type LinkCandidate = import("./projectLink").LinkCandidate;

const project = (environmentId: string, id: string, remote: string | null, title = "EasyChamp") =>
  ({
    environmentId,
    id,
    title,
    workspaceRoot: `/${environmentId}/${id}`,
    repositoryIdentity: remote
      ? {
          canonicalKey: remote,
          rootPath: `/${environmentId}/${id}`,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: remote },
        }
      : null,
    workspaceSettings: { kind: "code" },
  }) as unknown as EnvironmentProject;
const candidate = (
  item: EnvironmentProject,
  rootMatches: boolean | null,
  shared: number | null = null,
  score: number | null = rootMatches === null ? null : rootMatches ? 0.9 : 0.1,
): LinkCandidate => ({ project: item, rootMatches, shared, score, summary: null });
const names = (list: ReadonlyArray<LinkCandidate>) =>
  list.map((item) => `${item.project.id}@${item.project.environmentId}`);

const REMOTE = "github.com/team/easychamp";
const here = project("m4", "here", REMOTE);

describe("linkCandidateGroups", () => {
  it("lists same-root copies and folds every other project away, in the given order", () => {
    const ranked = [
      candidate(project("m1", "copy", REMOTE), true, 34),
      candidate(project("m3", "copy", REMOTE), true, 34),
      // Read and found different: never a copy, even with the same remote.
      candidate(project("m5", "fork", REMOTE), false, 0),
      // Never read: another repository, a folder with no remote, the same name alone.
      candidate(project("m1", "sketchmate", "github.com/team/sketchmate", "sketchmate"), null),
      candidate(project("m3", "ol", null, "ol"), null),
      candidate(project("m5", "renamed", null), null),
    ];
    const groups = linkCandidateGroups({ ranked, project: here, namedKey: null });
    expect(names(groups.copies)).toEqual(["copy@m1", "copy@m3"]);
    expect(names(groups.others)).toEqual(["fork@m5", "sketchmate@m1", "ol@m3", "renamed@m5"]);
  });

  it("keeps an unread copy of the same repository listed, at the same place only", () => {
    const offline = project("linux", "copy", "GitHub.com/Team/EasyChamp");
    const elsewhere = {
      ...project("linux", "api", REMOTE),
      workspaceRoot: "/linux/api/apps/api",
    } as EnvironmentProject;
    const groups = linkCandidateGroups({
      ranked: [candidate(offline, null), candidate(elsewhere, null)],
      project: here,
      namedKey: null,
    });
    expect(names(groups.copies)).toEqual(["copy@linux"]);
    expect(names(groups.others)).toEqual(["api@linux"]);
  });

  it("always lists the copy the caller named", () => {
    const named = project("m3", "added", null, "Something else");
    const groups = linkCandidateGroups({
      ranked: [candidate(named, false, 0)],
      project: here,
      namedKey: "m3:added",
    });
    expect(names(groups.copies)).toEqual(["added@m3"]);
    expect(groups.others).toEqual([]);
  });

  it("lists nothing as a copy when this project has no remote and nothing was read", () => {
    const local = project("m4", "here", null);
    const groups = linkCandidateGroups({
      ranked: [candidate(project("m3", "same-name", null), null)],
      project: local,
      namedKey: null,
    });
    expect(groups.copies).toEqual([]);
    expect(names(groups.others)).toEqual(["same-name@m3"]);
  });
});

describe("bestLinkCopy", () => {
  const anywhere = () => true;

  it("picks the most matching repositories, not the highest score", () => {
    const copies = [
      // Fewer repositories overall scores higher, with fewer matches.
      candidate(project("m1", "copy", REMOTE), true, 12, 0.95),
      candidate(project("m3", "copy", REMOTE), true, 34, 0.9),
    ];
    expect(bestLinkCopy(copies, anywhere)?.project.environmentId).toBe("m3");
  });

  it("keeps the list's order on a tie", () => {
    const copies = rankCandidates([
      candidate(project("m3", "copy", REMOTE), true, 34, 0.9),
      candidate(project("m1", "copy", REMOTE), true, 34, 0.9),
    ]);
    expect(names(copies)).toEqual(["copy@m1", "copy@m3"]);
    expect(bestLinkCopy(copies, anywhere)?.project.environmentId).toBe("m1");
  });

  it("never picks a copy on a machine that cannot link, however well it matches", () => {
    const copies = [
      candidate(project("linux", "copy", REMOTE), true, 38),
      candidate(project("m1", "copy", REMOTE), true, 30),
    ];
    const canLink = (environmentId: string) => environmentId !== "linux";
    expect(bestLinkCopy(copies, canLink)?.project.environmentId).toBe("m1");
    expect(bestLinkCopy(copies.slice(0, 1), canLink)).toBeNull();
  });

  it("never picks a copy that was not read or does not match at the root", () => {
    const copies = [
      candidate(project("m1", "unread", REMOTE), null),
      candidate(project("m3", "named", REMOTE), false, 20),
    ];
    expect(bestLinkCopy(copies, anywhere)).toBeNull();
    expect(bestLinkCopy([], anywhere)).toBeNull();
  });

  it("reads the count the summary names", () => {
    const entry = (path: string, originKey: string) => ({ path, originKey, worktrees: 0 });
    const umbrella = {
      root: "repository" as const,
      repositories: [entry("", "github.com/t/root"), entry("api", "github.com/t/api")],
      skippedLinks: 0,
      truncated: false,
    };
    const result = fingerprintSummary(
      { ...umbrella, repositories: umbrella.repositories.slice(0, 1) },
      umbrella,
    );
    expect(result.summary).toBe("Same root repository; 1 of 2 repositories match, 1 missing here.");
    expect(result.shared).toBe(1);
  });
});

describe("linkedMainEnvironmentId", () => {
  const member = (environmentId: string, projectId: string) => ({
    environmentId,
    projectId,
    coordinatorThreadId: `project-coordinator:${projectId}`,
  });
  const logical = {
    id: "logical:1",
    title: "EasyChamp",
    coordinatorId: "coordinator:logical:1",
    members: [member("m4", "here"), member("m5", "copy")],
  };
  const linked = (
    environmentId: string,
    id: string,
    state: "active" | "transferred",
    epoch = 1,
    successor?: ReturnType<typeof member>,
  ) =>
    ({
      ...project(environmentId, id, REMOTE),
      workspaceSettings: {
        kind: "code",
        logicalProject: logical,
        coordinatorBinding: { epoch, state, ...(successor ? { successor } : {}) },
      },
    }) as unknown as EnvironmentProject;

  it("names no Main for a project that is not linked with another copy", () => {
    expect(linkedMainEnvironmentId(here, [here, project("m3", "copy", REMOTE)])).toBeNull();
    const alone = {
      ...here,
      workspaceSettings: {
        kind: "code",
        logicalProject: { ...logical, members: [member("m4", "here")] },
      },
    } as unknown as EnvironmentProject;
    expect(linkedMainEnvironmentId(alone, [alone])).toBeNull();
  });

  it("names the machine that leads, from this copy or from the other one", () => {
    const main = linked("m4", "here", "active");
    const copy = linked("m5", "copy", "transferred", 1, member("m4", "here"));
    expect(linkedMainEnvironmentId(main, [main, copy])).toBe("m4");
    expect(linkedMainEnvironmentId(copy, [main, copy])).toBe("m4");
    // Main is out of sight: the copy's recorded successor still names it.
    expect(linkedMainEnvironmentId(copy, [copy])).toBe("m4");
    // The dialog's own project is counted even when the list has not caught up with it.
    expect(linkedMainEnvironmentId(main, [copy])).toBe("m4");
  });

  it("never names a machine record that was replaced", () => {
    const stale = linked("m4", "here", "active", 3);
    const current = linked("m5", "copy", "active", 2);
    expect(linkedMainEnvironmentId(current, [stale, current])).toBe("m4");
    expect(linkedMainEnvironmentId(current, [stale, current], new Set(["m4"]))).toBe("m5");
  });
});
