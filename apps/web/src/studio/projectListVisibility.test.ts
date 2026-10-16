import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedMemberKeys,
  archiveWorkspacePatch,
  isArchivedGroup,
  isScratchGroup,
  membersToToggle,
  partitionProjectGroups,
  projectPickerGroups,
  projectPickerMembers,
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

describe("project pickers", () => {
  const pickerGroups = [atlas, hostScratch, remoteScratch, samples, shared];

  it("offers no archived project and no machine's No project folder", () => {
    expect(projectPickerGroups(pickerGroups, scratchRootFor).map((g) => g.projectKey)).toEqual([
      "atlas",
      "shared",
    ]);
  });

  it("keeps the selected group listed even when it is archived", () => {
    expect(
      projectPickerGroups(pickerGroups, scratchRootFor, "remote:samples").map((g) => g.projectKey),
    ).toEqual(["atlas", "remote:samples", "shared"]);
  });

  it("filters one row per machine the same way", () => {
    const members = pickerGroups.flatMap((g) => g.memberProjects);
    expect(projectPickerMembers(members, scratchRootFor).map((m) => m.id)).toEqual(["a1", "h2"]);
  });

  it("keeps the selected member, matching machine and id", () => {
    const members = pickerGroups.flatMap((g) => g.memberProjects);
    const pick = (environmentId: string, id: string) =>
      projectPickerMembers(members, scratchRootFor, {
        environmentId: environmentId as EnvironmentId,
        id: id as ProjectId,
      }).map((m) => m.id);
    expect(pick("remote", "r1")).toEqual(["a1", "r1", "h2"]);
    expect(pick("host", "r1")).toEqual(["a1", "h2"]);
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
