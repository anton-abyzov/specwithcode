import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, RepositoryFingerprint } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  cloneSourceOf,
  findFolderCopies,
  folderCopyMatches,
  folderCopyTargets,
  folderPath,
  mapLimited,
  settleWithin,
  type FolderCopyMachine,
} from "./folderLinkSuggestion";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
}));

const id = (value: string) => value as EnvironmentId;
const folder = {
  environmentId: id("m3"),
  workspaceRoot: "/Users/a/sw-easychamp",
  title: "sw-easychamp",
};
const machines: FolderCopyMachine[] = [
  { environmentId: id("m3"), label: "MacBook Pro", connected: true, supportsLink: true },
  { environmentId: id("m4"), label: "M4MAX", connected: true, supportsLink: true },
  { environmentId: id("old"), label: "Old Mac", connected: true, supportsLink: undefined },
  { environmentId: id("off"), label: "Away", connected: false, supportsLink: true },
];

function project(
  environmentId: string,
  projectId: string,
  overrides: Partial<EnvironmentProject> & { readonly origin?: string } = {},
): EnvironmentProject {
  const { origin, ...rest } = overrides;
  return {
    environmentId: id(environmentId),
    id: projectId,
    title: projectId,
    workspaceRoot: `/Users/a/${projectId}`,
    repositoryIdentity: origin
      ? {
          canonicalKey: origin,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${origin}` },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...rest,
  } as EnvironmentProject;
}

const repo = (path: string, originKey: string | null) => ({ path, originKey, worktrees: 0 });
const fingerprint = (
  root: "repository" | "folder",
  repositories: RepositoryFingerprint["repositories"],
): RepositoryFingerprint => ({ root, repositories, skippedLinks: 0, truncated: false });

const umbrella = fingerprint("repository", [
  repo("", "github.com/team/sw-easychamp"),
  repo("repositories/ec-api", "github.com/team/ec-api"),
]);
const full = fingerprint("repository", [
  repo("", "github.com/team/sw-easychamp"),
  repo("repositories/ec-api", "github.com/team/ec-api"),
  repo("repositories/ec-ui", "github.com/team/ec-ui"),
  repo("repositories/local", null),
]);

describe("folderCopyTargets", () => {
  it("picks code projects on linkable machines that track a folder repository or share its name", () => {
    const projects = [
      project("m4", "sw-easychamp"),
      project("m4", "api", { origin: "github.com/team/ec-api" }),
      project("m4", "unrelated", { origin: "github.com/team/other" }),
      project("m4", "assistant", {
        title: "sw-easychamp",
        workspaceSettings: { kind: "personal" } as EnvironmentProject["workspaceSettings"],
      }),
      project("m4", "archived", {
        title: "sw-easychamp",
        workspaceSettings: { archived: true } as EnvironmentProject["workspaceSettings"],
      }),
      project("m3", "here", { origin: "github.com/team/ec-api" }),
      project("old", "sw-easychamp"),
      project("off", "sw-easychamp"),
    ];
    const targets = folderCopyTargets({ folder, fingerprint: umbrella, machines, projects });
    expect(targets.map((item) => item.id)).toEqual(["api", "sw-easychamp"]);
  });

  it("caps each machine, most recently updated first within a tier", () => {
    const projects = Array.from({ length: 9 }, (_, index) =>
      project("m4", `copy-${index}`, {
        origin: "github.com/team/sw-easychamp",
        updatedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const targets = folderCopyTargets({
      folder,
      fingerprint: umbrella,
      machines,
      projects,
      limit: 3,
    });
    expect(targets.map((item) => item.id)).toEqual(["copy-8", "copy-7", "copy-6"]);
  });
});

describe("folderCopyMatches", () => {
  it("keeps root matches only, ranks them, and lists what is missing here with clone sources", () => {
    const best = project("m4", "sw-easychamp");
    const other = project("m4", "fork");
    const matches = folderCopyMatches({
      folder,
      fingerprint: umbrella,
      copies: [
        { project: other, fingerprint: fingerprint("repository", [repo("", "github.com/x/fork")]) },
        { project: best, fingerprint: full },
      ],
      machineLabel: () => "M4MAX",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.candidate.project).toBe(best);
    expect(matches[0]!.machine).toBe("M4MAX");
    expect(matches[0]!.candidate.summary).toBe(
      "Same root repository; 2 of 4 repositories match, 2 missing here.",
    );
    expect(matches[0]!.missing).toEqual([
      {
        path: "repositories/ec-ui",
        originKey: "github.com/team/ec-ui",
        destination: "/Users/a/sw-easychamp/repositories/ec-ui",
        clone: { provider: "github", repository: "team/ec-ui" },
      },
      {
        path: "repositories/local",
        originKey: null,
        destination: "/Users/a/sw-easychamp/repositories/local",
        clone: null,
      },
    ]);
  });

  it("treats a folder with a subset of the repositories as a copy", () => {
    const here = fingerprint("folder", [repo("ec-api", "github.com/team/ec-api")]);
    const there = fingerprint("folder", [
      repo("ec-api", "github.com/team/ec-api"),
      repo("ec-ui", "github.com/team/ec-ui"),
    ]);
    const matches = folderCopyMatches({
      folder,
      fingerprint: here,
      copies: [{ project: project("m4", "umbrella"), fingerprint: there }],
      machineLabel: () => "M4MAX",
    });
    expect(matches.map((match) => match.missing.map((entry) => entry.path))).toEqual([["ec-ui"]]);
  });
});

describe("clone helpers", () => {
  it("clones through the provider lookup on known hosts and HTTPS elsewhere", () => {
    expect(cloneSourceOf("github.com/team/repo")).toEqual({
      provider: "github",
      repository: "team/repo",
    });
    expect(cloneSourceOf("gitlab.com/group/sub/repo")).toEqual({
      provider: "gitlab",
      repository: "group/sub/repo",
    });
    expect(cloneSourceOf("git.example.com/team/repo")).toEqual({
      remoteUrl: "https://git.example.com/team/repo.git",
    });
    expect(cloneSourceOf("file:///srv/repo")).toBeNull();
    expect(cloneSourceOf(null)).toBeNull();
  });

  it("joins paths in the folder's separator", () => {
    expect(folderPath("/a/b/", "c/d")).toBe("/a/b/c/d");
    expect(folderPath("C:\\work\\proj", "c/d")).toBe("C:\\work\\proj\\c\\d");
  });
});

describe("findFolderCopies", () => {
  it("does nothing without a linkable machine", async () => {
    const read = vi.fn();
    const result = await findFolderCopies({
      folder,
      machines: machines.filter((machine) => machine.environmentId !== "m4"),
      projects: [project("old", "sw-easychamp")],
      read,
    });
    expect(result).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("skips an empty or unreadable folder without asking other machines", async () => {
    const read = vi.fn(async () => fingerprint("folder", []));
    const result = await findFolderCopies({
      folder,
      machines,
      projects: [project("m4", "sw-easychamp")],
      read,
    });
    expect(result).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaves out a machine that fails and still returns the others", async () => {
    const projects = [
      project("m4", "sw-easychamp"),
      project("m4", "broken", { origin: "github.com/team/sw-easychamp" }),
    ];
    const read = vi.fn(async (environmentId: EnvironmentId, input: object) => {
      if ("workspaceRoot" in input) return umbrella;
      if ((input as { projectId: string }).projectId === "broken") throw new Error("offline");
      return full;
    });
    const result = await findFolderCopies({ folder, machines, projects, read });
    expect(result.map((match) => match.candidate.project.id)).toEqual(["sw-easychamp"]);
    expect(read).toHaveBeenCalledWith(id("m3"), { workspaceRoot: folder.workspaceRoot });
    expect(read).toHaveBeenCalledWith(id("m4"), { projectId: "broken" });
  });
});

describe("bounded work", () => {
  it("never runs more than the limit at once and keeps input order", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimited([1, 2, 3, 4, 5], 2, async (value) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5 - value));
      running--;
      return value * 10;
    });
    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it("settles a slow or failed call as null", async () => {
    vi.useFakeTimers();
    const slow = settleWithin(new Promise(() => undefined), 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(slow).resolves.toBeNull();
    vi.useRealTimers();
    await expect(settleWithin(Promise.reject(new Error("no")), 1_000)).resolves.toBeNull();
    await expect(settleWithin(Promise.resolve(3), 1_000)).resolves.toBe(3);
  });
});
