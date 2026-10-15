import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archiveWorkspacePatch,
  isArchivedGroup,
  isScratchGroup,
  membersToToggle,
  partitionProjectGroups,
  pinProjectsFirst,
  togglePinnedProject,
  type ProjectListMember,
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
  settings?: { archived?: boolean; revision?: number },
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
    expect(
      partitionProjectGroups([lookalike, unknown, parent], scratchRootFor).listed.map(
        (entry) => entry.projectKey,
      ),
    ).toEqual(["lookalike", "unknown", "parent"]);
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

describe("pinned projects", () => {
  const groups = ["a", "b", "c", "d"].map((projectKey) => ({ projectKey }));

  it("lists pinned projects first in pin order, then the rest in input order", () => {
    expect(pinProjectsFirst(groups, ["c", "a"]).map((group) => group.projectKey)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("ignores pins for projects that are not listed", () => {
    expect(pinProjectsFirst(groups, ["gone", "d"]).map((group) => group.projectKey)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("pins at the end and unpins in place", () => {
    expect(togglePinnedProject(["a"], "c")).toEqual(["a", "c"]);
    expect(togglePinnedProject(["a", "c", "b"], "c")).toEqual(["a", "b"]);
  });
});
