// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  discoverProjectRepositories,
  forgetProjectRepositories,
  foundRepositoryLines,
  readSpecweaveRepositories,
  resolveFolderRepository,
  validRepositoryNames,
} from "./ProjectRepositoryDiscovery.ts";

let root = "";
const at = (...parts: string[]) => NodePath.join(root, ...parts);
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
/** A real clone with one commit on `branch`, and optionally an origin. */
const clone = async (relative: string, options: { origin?: string; branch?: string } = {}) => {
  const folder = at(...relative.split("/"));
  await NodeFSP.mkdir(folder, { recursive: true });
  git(folder, "init", "-q", "-b", options.branch ?? "main");
  await NodeFSP.writeFile(NodePath.join(folder, "README.md"), "fixture\n");
  git(folder, "add", "README.md");
  git(folder, "commit", "-q", "-m", "fixture");
  if (options.origin !== undefined) git(folder, "remote", "add", "origin", options.origin);
  return folder;
};
const specweave = (config: unknown) =>
  NodeFSP.mkdir(at(".specweave"), { recursive: true }).then(() =>
    NodeFSP.writeFile(
      at(".specweave/config.json"),
      typeof config === "string" ? config : JSON.stringify(config),
    ),
  );
const discover = (saved: Parameters<typeof discoverProjectRepositories>[0]["saved"] = []) =>
  discoverProjectRepositories({ projectId: "p", workspaceRoot: root, saved, refresh: true });

beforeEach(async () => {
  root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-repository-discovery-")),
  );
  forgetProjectRepositories();
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("discoverProjectRepositories", () => {
  it("lists every clone in the folder with its origin, branch and SpecWeave tag", async () => {
    await NodeFSP.mkdir(at(".git"));
    const api = await clone("repositories/acme/api", {
      origin: "https://github.com/Acme/Api.git",
      branch: "feature/x",
    });
    await clone("repositories/acme/web", { origin: "git@github.com:acme/web.git" });
    await clone("repositories/acme/local");
    // No branch checked out, and one linked worktree.
    git(api, "worktree", "add", "-q", "-b", "thread", at("..", `${NodePath.basename(root)}-wt`));
    git(api, "checkout", "-q", "--detach");
    await specweave({
      workspace: {
        repos: [
          { id: "api", path: "repositories/acme/api" },
          {
            id: "docs",
            path: "repositories/acme/docs",
            sync: { github: { owner: "acme", repo: "docs" } },
          },
        ],
      },
    });
    const result = await discover();
    expect(result).toMatchObject({ rootIsRepository: true, separateClones: true, foundMore: 0 });
    expect(result?.found).toEqual([
      {
        relativePath: "repositories/acme/api",
        path: api,
        name: "api",
        origin: "acme/api",
        branch: null,
        defaultBranch: null,
        inSpecweave: true,
        state: "available",
        noRemote: false,
        threadWorktrees: 1,
      },
      expect.objectContaining({
        relativePath: "repositories/acme/local",
        origin: null,
        noRemote: true,
        branch: "main",
        inSpecweave: false,
      }),
      expect.objectContaining({ relativePath: "repositories/acme/web", origin: "acme/web" }),
      // SpecWeave lists it and nothing is there: it can be cloned.
      {
        relativePath: "repositories/acme/docs",
        path: at("repositories/acme/docs"),
        name: "docs",
        origin: "acme/docs",
        branch: null,
        defaultBranch: null,
        inSpecweave: true,
        state: "absent",
        noRemote: false,
        threadWorktrees: 0,
      },
    ]);
    expect(foundRepositoryLines(result)).toBe(
      [
        "- api: repositories/acme/api (acme/api, no branch checked out)",
        "- local: repositories/acme/local (no remote, on main)",
        "- web: repositories/acme/web (acme/web, on main)",
      ].join("\n"),
    );
    expect(validRepositoryNames(result)).toBe(
      " Repositories in the project folder, by path: ., repositories/acme/api, repositories/acme/local, repositories/acme/web.",
    );
    await NodeFSP.rm(at("..", `${NodePath.basename(root)}-wt`), { recursive: true, force: true });
  });

  it("joins saved entries by real path and names the ones no longer needed", async () => {
    const api = await clone("repositories/acme/api", { origin: "https://github.com/acme/api" });
    await clone("repositories/acme/web", { origin: "https://github.com/acme/web" });
    const result = await discover([
      // Saved under another URL, but its folder is a found clone.
      { id: "old-api", url: "https://github.com/acme/api-renamed", localPath: api },
      // Never cloned, and a clone of the repository is in the folder.
      { id: "web", url: "git@github.com:acme/web.git", localPath: null },
      // Never cloned and not in the folder: it can be cloned.
      { id: "tool", url: "https://github.com/acme/tool", localPath: null },
      // Its folder is gone.
      { id: "gone", url: "https://github.com/acme/gone", localPath: at("elsewhere/gone") },
    ]);
    expect(result?.redundantEntries).toEqual([
      { repositoryId: "old-api", reason: "found_clone" },
      { repositoryId: "web", reason: "no_folder" },
    ]);
    expect(result?.found.map((row) => [row.relativePath, row.state, row.repositoryId])).toEqual([
      ["repositories/acme/api", "available", "old-api"],
      ["repositories/acme/web", "available", undefined],
      [".studio-repositories/tool", "absent", "tool"],
      ["elsewhere/gone", "missing", "gone"],
    ]);
  });

  it("keeps a managed checkout that exists and never lists a link twice", async () => {
    const api = await clone("repositories/acme/api");
    await clone(".studio-repositories/managed", { origin: "https://github.com/acme/managed" });
    await NodeFSP.symlink(api, at("repositories/acme/api-link"), "dir");
    const result = await discover([
      { id: "managed", url: "https://github.com/acme/managed", localPath: null },
    ]);
    expect(result?.found.map((row) => [row.relativePath, row.state])).toEqual([
      ["repositories/acme/api", "available"],
      [".studio-repositories/managed", "available"],
    ]);
    expect(result?.skippedLinks).toEqual([
      { path: "repositories/acme/api-link", target: "repositories/acme/api" },
    ]);
    expect(result?.redundantEntries).toEqual([]);
  });

  it("reads one repository with no clones inside, and a folder with none", async () => {
    await NodeFSP.mkdir(at("single/.git"), { recursive: true });
    await NodeFSP.mkdir(at("plain"), { recursive: true });
    expect(
      await discoverProjectRepositories({ projectId: "s", workspaceRoot: at("single") }),
    ).toMatchObject({ kind: "single", rootIsRepository: true, separateClones: false, found: [] });
    expect(
      await discoverProjectRepositories({ projectId: "n", workspaceRoot: at("plain") }),
    ).toMatchObject({ kind: "plain", rootIsRepository: false, found: [] });
    expect(
      await discoverProjectRepositories({ projectId: "m", workspaceRoot: at("missing") }),
    ).toBeNull();
  });

  it("shares one walk for 60 seconds and reads again on demand", async () => {
    await clone("repositories/acme/api");
    const read = (options: { refresh?: boolean; now: number }) =>
      discoverProjectRepositories({ projectId: "cache", workspaceRoot: root, ...options });
    expect((await read({ now: 0 }))?.found).toHaveLength(1);
    await clone("repositories/acme/web");
    expect((await read({ now: 59_000 }))?.found).toHaveLength(1);
    expect((await read({ now: 59_500, refresh: true }))?.found).toHaveLength(2);
    await clone("repositories/acme/tool");
    expect((await read({ now: 59_500 + 60_000 }))?.found).toHaveLength(3);
  });
});

describe("readSpecweaveRepositories", () => {
  it("reads workspace.repos, else umbrella.childRepos, and treats anything else as empty", async () => {
    expect(await readSpecweaveRepositories(root)).toEqual([]);
    await specweave("{ not json");
    expect(await readSpecweaveRepositories(root)).toEqual([]);
    await specweave({ workspace: { name: "x" }, umbrella: null });
    expect(await readSpecweaveRepositories(root)).toEqual([]);
    await specweave({ workspace: { repos: "nope" }, umbrella: { childRepos: [{ path: "a/b" }] } });
    expect(await readSpecweaveRepositories(root)).toEqual([{ path: "a/b", origin: null }]);
    await specweave({
      workspace: { repos: [{ id: "x", path: "r/x" }, { id: "bad" }, 7] },
      umbrella: { childRepos: [{ path: "ignored" }] },
    });
    expect(await readSpecweaveRepositories(root)).toEqual([{ path: "r/x", origin: null }]);
  });
});

describe("resolveFolderRepository", () => {
  it("accepts a clone's relative path and '.', and nothing else", async () => {
    await NodeFSP.mkdir(at(".git"));
    const api = await clone("repositories/acme/api");
    await NodeFSP.mkdir(NodePath.join(api, "src"));
    await NodeFSP.symlink(api, at("repositories/acme/link"), "dir");
    expect(await resolveFolderRepository(root, "repositories/acme/api")).toEqual({
      path: api,
      relativePath: "repositories/acme/api",
    });
    expect(await resolveFolderRepository(root, ".")).toEqual({ path: root, relativePath: "." });
    // A link is the clone it leads to, not a second repository.
    expect(await resolveFolderRepository(root, "repositories/acme/link")).toEqual({
      path: api,
      relativePath: "repositories/acme/api",
    });
    // A folder inside a checkout, a missing folder, a path that leaves the folder, an absolute path.
    for (const name of ["repositories/acme/api/src", "repositories/acme", "nope", "../x", api, ""])
      expect(await resolveFolderRepository(root, name)).toBeNull();
  });
});
