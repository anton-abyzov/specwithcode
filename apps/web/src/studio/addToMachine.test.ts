// @vitest-environment jsdom
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  FolderCopyStatus,
  ProjectId,
  RepositoryIdentity,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  addToMachineJobKey,
  alternateFolder,
  clearAddToMachineJob,
  cloneUrlFor,
  cloneUrlsFor,
  defaultDestinationFolder,
  destinationPlan,
  listAddToMachineJobs,
  readAddToMachineJob,
  runOnMachineGroups,
  writeAddToMachineJob,
  type AddToMachineJob,
} from "./addToMachine";
import { addCopySelection, keepMineDecisions, withoutDivergedTakeTheirs } from "./addToMachineCopy";

const env = (id: string) => id as EnvironmentId;
const pid = (id: string) => id as ProjectId;

function identity(remoteUrl: string, canonicalKey: string, origin?: string): RepositoryIdentity {
  return {
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    ...(origin ? { origin: { canonicalKey: origin } } : {}),
  } as RepositoryIdentity;
}

function project(
  environmentId: string,
  id: string,
  extra: Partial<Record<string, unknown>> = {},
): EnvironmentProject {
  return {
    environmentId: env(environmentId),
    id: pid(id),
    title: id,
    workspaceRoot: `/Users/me/${id}`,
    repositoryIdentity: null,
    workspaceSettings: null,
    ...extra,
  } as unknown as EnvironmentProject;
}

describe("cloneUrlsFor", () => {
  it("offers both forms for a GitHub SSH remote and prefers SSH", () => {
    const urls = cloneUrlsFor(identity("git@github.com:acme/app.git", "github.com/acme/app"));
    expect(urls).toEqual({
      ssh: "git@github.com:acme/app.git",
      https: "https://github.com/acme/app.git",
      raw: "git@github.com:acme/app.git",
      preferred: "ssh",
    });
    expect(cloneUrlFor(urls, "https")).toBe("https://github.com/acme/app.git");
  });

  it("prefers HTTPS for an HTTPS remote", () => {
    const urls = cloneUrlsFor(identity("https://github.com/acme/app", "github.com/acme/app"));
    expect(urls.preferred).toBe("https");
    expect(cloneUrlFor(urls, urls.preferred)).toBe("https://github.com/acme/app.git");
  });

  it("clones a fork from its own remote, not the upstream", () => {
    const urls = cloneUrlsFor(
      identity("git@github.com:me/app.git", "github.com/acme/app", "github.com/me/app"),
    );
    expect(urls.ssh).toBe("git@github.com:me/app.git");
    expect(urls.https).toBe("https://github.com/me/app.git");
  });

  it("clones a fork's own URL and protocol when it is not on a forge host", () => {
    const urls = cloneUrlsFor({
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "https://github.com/acme/app.git",
      },
      origin: { canonicalKey: "local/srv/git/app", remoteUrl: "/srv/git/app.git" },
    } as RepositoryIdentity);
    expect(urls.ssh).toBeNull();
    expect(urls.raw).toBe("/srv/git/app.git");
    expect(urls.preferred).toBeNull();
    expect(cloneUrlFor(urls, "https")).toBe("/srv/git/app.git");
  });

  it("prefers the fork's protocol over the upstream's", () => {
    const urls = cloneUrlsFor({
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "https://github.com/acme/app.git",
      },
      origin: { canonicalKey: "github.com/me/app", remoteUrl: "git@github.com:me/app.git" },
    } as RepositoryIdentity);
    expect(urls.preferred).toBe("ssh");
    expect(cloneUrlFor(urls, urls.preferred)).toBe("git@github.com:me/app.git");
  });

  it("uses a local path as is", () => {
    const urls = cloneUrlsFor(identity("/srv/git/app.git", "local/srv/git/app"));
    expect(urls.ssh).toBeNull();
    expect(urls.https).toBeNull();
    expect(urls.preferred).toBeNull();
    expect(cloneUrlFor(urls, "https")).toBe("/srv/git/app.git");
  });
});

describe("defaultDestinationFolder", () => {
  it.each([
    ["/Users/x/a/b", "~/a/b"],
    ["/home/x/a", "~/a"],
    ["C:\\Users\\x\\a", "~/a"],
    ["/opt/a", "~/a"],
    ["/Users/x/a/", "~/a"],
  ])("maps %s to %s", (source, expected) => {
    expect(defaultDestinationFolder(source)).toBe(expected);
  });
});

describe("alternateFolder", () => {
  it("adds or bumps a number", () => {
    expect(alternateFolder("~/a")).toBe("~/a-2");
    expect(alternateFolder("~/a-2")).toBe("~/a-3");
    expect(alternateFolder("/Users/x/a/")).toBe("/Users/x/a-2");
  });
});

describe("destinationPlan", () => {
  const at = (state: string, sameRepository = false) =>
    destinationPlan({ path: "/Users/x/a", state, sameRepository } as Parameters<
      typeof destinationPlan
    >[0]);

  it("clones into a missing or empty folder", () => {
    expect(at("missing")).toEqual({ kind: "clone" });
    expect(at("empty")).toEqual({ kind: "clone" });
  });

  it("consolidates only a checkout of the same repository", () => {
    expect(at("repository", true)).toEqual({ kind: "consolidate" });
  });

  it.each(["repository", "not-repository", "unreadable"])(
    "refuses %s with a numbered suggestion",
    (state) => {
      const plan = at(state, false);
      expect(plan.kind).toBe("refuse");
      if (plan.kind === "refuse") {
        expect(plan.reason).not.toBe("");
        expect(plan.suggestion).toBe("/Users/x/a-2");
      }
    },
  );
});

describe("runOnMachineGroups", () => {
  const repo = identity("git@github.com:acme/app.git", "github.com/acme/app");
  const active = project("here", "p1", { repositoryIdentity: repo });
  const logicalKey = (entry: EnvironmentProject) =>
    entry.id === "p1" || entry.id === "p2" ? "logical:app" : `own:${entry.id}`;

  it("groups members by logical key and unlinked copies by repository", () => {
    const groups = runOnMachineGroups({
      active,
      environmentIds: [env("here"), env("member"), env("copy"), env("empty")],
      projects: [
        active,
        project("member", "p2"),
        project("copy", "p3", {
          repositoryIdentity: identity("https://GitHub.com/Acme/App", "GitHub.com/Acme/App"),
        }),
      ],
      logicalKey,
    });
    expect(groups.withProject.map((entry) => entry.environmentId)).toEqual(["here", "member"]);
    expect(groups.addable).toEqual([
      { environmentId: "copy", copy: expect.objectContaining({ id: "p3" }) },
      { environmentId: "empty", copy: null },
    ]);
  });

  it("offers no other machine for a personal assistant: it never runs on or copies to one", () => {
    const aide = project("here", "aide", { workspaceSettings: { kind: "personal" } });
    const groups = runOnMachineGroups({
      active: aide,
      environmentIds: [env("here"), env("anna"), env("empty")],
      projects: [aide, project("anna", "aide-anna", { workspaceSettings: { kind: "personal" } })],
      logicalKey: () => "own:aide",
    });
    expect(groups.withProject.map((entry) => entry.environmentId)).toEqual(["here"]);
    expect(groups.addable).toEqual([]);
  });

  it("skips archived and personal copies but always lists the active machine", () => {
    const groups = runOnMachineGroups({
      active: project("here", "p1", {
        repositoryIdentity: repo,
        workspaceSettings: { archived: true },
      }),
      environmentIds: [env("here"), env("a"), env("b")],
      projects: [
        project("a", "p2", { workspaceSettings: { archived: true } }),
        project("b", "p4", { repositoryIdentity: repo, workspaceSettings: { kind: "personal" } }),
      ],
      logicalKey,
    });
    expect(groups.withProject.map((entry) => entry.environmentId)).toEqual(["here"]);
    expect(groups.addable).toEqual([
      { environmentId: "a", copy: null },
      { environmentId: "b", copy: null },
    ]);
  });
});

describe("add-to-machine job store", () => {
  afterEach(() => localStorage.clear());

  const job: AddToMachineJob = {
    version: 1,
    source: { environmentId: env("here"), projectId: pid("p1"), workspaceRoot: "/Users/x/a" },
    destination: { environmentId: env("there"), projectId: pid("p9"), workspaceRoot: "/home/x/a" },
    copyIgnored: true,
    secrets: [".env"],
    createdAt: "2025-01-01T00:00:00.000Z",
  };

  it("round-trips a job", () => {
    writeAddToMachineJob(job);
    expect(readAddToMachineJob(env("there"), pid("p9"))).toEqual(job);
    expect(listAddToMachineJobs()).toEqual([job]);
    clearAddToMachineJob(env("there"), pid("p9"));
    expect(listAddToMachineJobs()).toEqual([]);
  });

  it("ignores garbage under the job key", () => {
    localStorage.setItem(addToMachineJobKey(env("there"), pid("bad")), "{not json");
    localStorage.setItem(addToMachineJobKey(env("there"), pid("old")), '{"version":0}');
    localStorage.setItem("unrelated", JSON.stringify(job));
    expect(readAddToMachineJob(env("there"), pid("bad"))).toBeNull();
    expect(listAddToMachineJobs()).toEqual([]);
  });
});

describe("copy helpers", () => {
  it("selects the repository after a clone and the whole folder when consolidating", () => {
    expect(addCopySelection("clone", false)).toEqual(["repository"]);
    expect(addCopySelection("clone", true)).toEqual(["repository", "ignoredData"]);
    expect(addCopySelection("consolidate", false)).toEqual(["repository", "tracked", "untracked"]);
  });

  const row = (extra: Record<string, unknown>) => ({
    id: "r1",
    kind: "repository",
    status: "diverged",
    choices: ["keep-mine", "take-theirs", "keep-both"],
    decision: "take-theirs",
    needsDecision: true,
    conflicts: [],
    moreConflicts: 0,
    ...extra,
  });

  it("never offers take theirs on a diverged repository (D-02)", () => {
    const status = { rows: [row({})] } as unknown as FolderCopyStatus;
    const [only] = withoutDivergedTakeTheirs(status).rows;
    expect(only?.choices).toEqual(["keep-mine", "keep-both"]);
    expect(only?.decision).toBeNull();
  });

  it("keeps what the destination has for open questions", () => {
    const status = {
      rows: [
        row({ kind: "ignoredData", status: "conflict" }),
        row({ id: "r2", needsDecision: false }),
      ],
    } as unknown as FolderCopyStatus;
    expect(keepMineDecisions(status)).toEqual({ r1: "keep-mine" });
  });
});
