import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectEnvironmentReadInput,
  ProjectEnvironmentReadResult,
  ProjectEnvironmentSettings,
  projectRepositoryIdentity,
} from "./projectEnvironment.ts";
import { WorktreeMcpAddRepositoryResult } from "./worktreeMcp.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectWorkspaceSettings,
} from "./projectWorkspace.ts";

describe("project environment", () => {
  it("requires orchestration operate access for the import mutation", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectsEnvironmentImport, {})).toEqual([
      "orchestration:operate",
    ]);
  });
  it("decodes legacy settings without assigning a provider or repository", () => {
    const {
      kind: _kind,
      environment: _environment,
      ...legacy
    } = DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    expect(Schema.decodeUnknownSync(ProjectWorkspaceSettings)(legacy)).toEqual(
      DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    );
  });
  it("matches transport aliases, GitHub casing and default ports while preserving other hosts' case", () => {
    expect(projectRepositoryIdentity("https://github.com/Org/Repo.git")).toBe(
      "github.com/org/repo",
    );
    expect(projectRepositoryIdentity("git@github.com:Org/Repo.git")).toBe("github.com/org/repo");
    expect(projectRepositoryIdentity("ssh://git@github.com:22/Org/Repo")).toBe(
      "github.com/org/repo",
    );
    expect(projectRepositoryIdentity("https://GitHub.com:443/Org/Repo.GIT")).toBe(
      "github.com/org/repo",
    );
    expect(projectRepositoryIdentity("ssh://git@GitHub.com:2222/Org/Repo.GIT")).toBe(
      "github.com:2222/org/repo",
    );
    expect(projectRepositoryIdentity("ssh://git@git.example:2222/Org/Repo.GIT")).toBe(
      "git.example:2222/Org/Repo",
    );
  });
  it.each([
    "https://user:secret@github.com/org/repo",
    "https://user@github.com/org/repo",
    "https://github.com/org/repo?token=secret",
    "https://github.com/org/repo#branch",
    "file:///tmp/repo",
    "/tmp/repo",
    "--upload-pack=evil",
    "git@github.com:org/../repo",
    "https://github.com/org/%2e%2e/repo",
    "https://github.com/org/a%2fb",
    "ssh://root@host/org/repo",
    "https://github.com/org/repo\n",
    "https://github.com/org/-repo",
  ])("rejects unsafe URL %s", (value) => {
    expect(projectRepositoryIdentity(value)).toBeNull();
  });
  it("rejects duplicate identities and IDs", () => {
    const decode = Schema.decodeUnknownSync(ProjectEnvironmentSettings);
    const a = { id: "a", url: "https://github.com/org/repo", localPath: null };
    expect(() =>
      decode({
        additionalFolders: [],
        repositories: [a, { ...a, id: "b", url: "git@github.com:org/repo.git" }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        additionalFolders: [],
        repositories: [a, { ...a, url: "https://github.com/org/other" }],
      }),
    ).toThrow();
  });
  it("reads found repositories only when the server sends them", () => {
    const base = { revision: 1, workspaceRoot: "/work", additionalFolders: [], repositories: [] };
    const decode = Schema.decodeUnknownSync(ProjectEnvironmentReadResult);
    expect(decode(base).found).toBeUndefined();
    const found = {
      relativePath: "repositories/acme/api",
      path: "/work/repositories/acme/api",
      name: "api",
      origin: "acme/api",
      branch: null,
      defaultBranch: "main",
      inSpecweave: true,
      state: "available",
      noRemote: false,
      threadWorktrees: 2,
    };
    const result = decode({
      ...base,
      found: [found],
      foundMore: 3,
      skippedLinks: ["repositories/link"],
      redundantEntries: [{ repositoryId: "old", reason: "found_clone" }],
    });
    expect(result.found).toEqual([found]);
    expect(result.foundMore).toBe(3);
    expect(() => decode({ ...base, found: [{ ...found, state: "unknown" }] })).toThrow();
    expect(
      Schema.decodeUnknownSync(ProjectEnvironmentReadInput)({ projectId: "p", discover: true }),
    ).toEqual({ projectId: "p", discover: true });
  });
  it("names the base branch and dependency state on an added repository", () => {
    const decode = Schema.decodeUnknownSync(WorktreeMcpAddRepositoryResult);
    const legacy = { worktreePath: "/t", repositoryPath: "/t/api", branch: "b", members: [] };
    expect(decode(legacy)).toEqual(legacy);
    expect(
      decode({
        ...legacy,
        baseRef: "origin/main",
        dependencies: "not_installed",
        alreadyMember: true,
      }).dependencies,
    ).toBe("not_installed");
  });
  it("retains two distinct existing checkouts of the same origin", () => {
    const repositories = [
      { id: "main", url: "https://github.com/org/repo", localPath: "/work/main" },
      { id: "review", url: "git@github.com:org/repo.git", localPath: "/work/review" },
    ];
    expect(
      Schema.decodeUnknownSync(ProjectEnvironmentSettings)({ additionalFolders: [], repositories })
        .repositories,
    ).toEqual(repositories);
  });
});
