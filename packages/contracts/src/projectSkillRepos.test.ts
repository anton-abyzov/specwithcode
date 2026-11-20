import { describe, expect, it } from "vite-plus/test";

import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  compareSkillSourceVersions,
  formatSkillSourceVersion,
  parseSkillRepoRef,
  skillRepoRefusalMessage,
} from "./projectSkillRepos.ts";
import { WS_METHODS } from "./rpc.ts";

describe("skill repo reference", () => {
  it("reads owner/repo from what a person types or pastes", () => {
    for (const text of [
      "anton-abyzov/vskill",
      " anton-abyzov/vskill ",
      "https://github.com/anton-abyzov/vskill",
      "https://github.com/anton-abyzov/vskill.git",
      "https://github.com/anton-abyzov/vskill/",
      "https://github.com/anton-abyzov/vskill/tree/main/plugins",
      "github.com/anton-abyzov/vskill",
      "git@github.com:anton-abyzov/vskill.git",
    ])
      expect(parseSkillRepoRef(text), text).toBe("anton-abyzov/vskill");
  });

  it("refuses another host, a flag or anything that is not one repo", () => {
    for (const text of [
      "",
      "vskill",
      "https://gitlab.com/owner/repo",
      "https://github.com.evil.example/owner/repo",
      "-o/--flag",
      "owner/repo name",
      "owner/repo;rm",
      "../../etc/passwd",
      "a/b/c",
      "x".repeat(400),
    ])
      expect(parseSkillRepoRef(text), text).toBeNull();
  });

  it("names the machine to sign in on", () => {
    expect(skillRepoRefusalMessage("needs-sign-in", "acme/private", "M4")).toBe(
      "Sign in to GitHub on M4 to read acme/private",
    );
  });
});

describe("skill source versions", () => {
  const copy = (version: string | null, contentHash: string | null, commit = "a".repeat(40)) => ({
    version,
    commit,
    contentHash,
  });

  it("shows the version with the short source commit", () => {
    expect(formatSkillSourceVersion(copy("1.2.0", null, "3f9c2ab0000"))).toBe("1.2.0 · 3f9c2ab");
    expect(formatSkillSourceVersion(copy(null, null, "3f9c2ab0000"))).toBe("3f9c2ab");
    expect(formatSkillSourceVersion({ version: "1.2.0", commit: null })).toBe("1.2.0");
    expect(formatSkillSourceVersion(null)).toBe("");
  });

  it("counts the same version with other content as different", () => {
    expect(compareSkillSourceVersions(copy("1.0.0", "h1"), copy("1.0.0", "h2"))).toBe("changed");
    expect(compareSkillSourceVersions(copy("1.0.0", "h1"), copy("1.1.0", "h2"))).toBe("update");
  });

  it("is current when only the repo's commit moved", () => {
    expect(
      compareSkillSourceVersions(copy("1.0.0", "h1"), copy("1.0.0", "h1", "b".repeat(40))),
    ).toBe("current");
  });

  it("does not guess without a source or a hash", () => {
    expect(compareSkillSourceVersions(copy("1.0.0", "h1"), null)).toBe("unknown");
    expect(compareSkillSourceVersions(copy("1.0.0", null), copy("1.0.0", "h2"))).toBe("unknown");
    expect(compareSkillSourceVersions(copy("1.0.0", null), copy("1.1.0", "h2"))).toBe("update");
  });
});

describe("skill repos, search and update scopes", () => {
  const projectId = "project";

  it("reads with read access and asks for more to change this machine", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillRepos, { projectId, operation: "read" }),
    ).toEqual([AuthOrchestrationReadScope]);
    for (const operation of ["connect", "disconnect"])
      expect(
        clientRpcRequiredScopes(WS_METHODS.projectsSkillRepos, { projectId, operation }),
      ).toEqual([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsSearch, { projectId, operation: "search" }),
    ).toEqual([AuthOrchestrationReadScope, AuthFilesystemReadScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsSearch, {
        projectId,
        operation: "open-note",
      }),
    ).toEqual([AuthFilesystemReadScope, AuthTerminalOperateScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsUpdate, { projectId, operation: "status" }),
    ).toEqual([AuthOrchestrationReadScope]);
    for (const operation of ["update", "install"])
      expect(
        clientRpcRequiredScopes(WS_METHODS.projectsSkillsUpdate, { projectId, operation }),
      ).toEqual([AuthFilesystemWriteScope, AuthTerminalOperateScope]);
  });

  it("takes the widest set for an ask it cannot read", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsUpdate, undefined)).toEqual([
      AuthFilesystemWriteScope,
      AuthTerminalOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillRepos, { operation: "x" })).toEqual([
      AuthOrchestrationReadScope,
      AuthSettingsWriteScope,
    ]);
  });
});
