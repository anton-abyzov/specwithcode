import type { VcsStatusRemoteResult, VcsStatusResult } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  formatGeneratedBranchName,
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseOriginUrlFromGitConfig,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:StudioTools/Studio.git")).toBe(
      "github.com/studiotools/studio",
    );
    expect(normalizeGitRemoteUrl("https://github.com/StudioTools/Studio.git")).toBe(
      "github.com/studiotools/studio",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/StudioTools/Studio")).toBe(
      "github.com/studiotools/studio",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:StudioTools/platform/Studio.git")).toBe(
      "gitlab.com/studiotools/platform/studio",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/StudioTools/platform/Studio.git")).toBe(
      "gitlab.com/studiotools/platform/studio",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });

  it("normalizes SCP-like remotes with non-git SSH users", () => {
    expect(normalizeGitRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(
      "gitlab.example.com/group/project",
    );
    expect(normalizeGitRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(
      "bitbucket.org/workspace/repo",
    );
  });

  it("gives an Azure DevOps repository the same key over SSH as over HTTPS", () => {
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/StudioTools/Platform/Studio")).toBe(
      "dev.azure.com/studiotools/platform/_git/studio",
    );
    expect(normalizeGitRemoteUrl("ssh://git@ssh.dev.azure.com:22/v3/StudioTools/Platform/Studio")).toBe(
      "dev.azure.com/studiotools/platform/_git/studio",
    );
    expect(
      normalizeGitRemoteUrl("https://StudioTools@dev.azure.com/StudioTools/Platform/_git/Studio"),
    ).toBe("dev.azure.com/studiotools/platform/_git/studio");
  });

  it("puts the organization back in the host on the name dev.azure.com replaced", () => {
    expect(
      normalizeGitRemoteUrl("StudioTools@vs-ssh.visualstudio.com:v3/StudioTools/Platform/Studio"),
    ).toBe("studiotools.visualstudio.com/platform/_git/studio");
    expect(normalizeGitRemoteUrl("https://StudioTools.visualstudio.com/Platform/_git/Studio")).toBe(
      "studiotools.visualstudio.com/platform/_git/studio",
    );
  });

  it("leaves an Azure SSH host it cannot read as the path it was given", () => {
    // Not `v3`, and not four segments: rewriting either would invent a repository that the web
    // spelling has no name for, so the remote stands as it arrived.
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v4/StudioTools/Platform/Studio")).toBe(
      "ssh.dev.azure.com/v4/studiotools/platform/studio",
    );
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/StudioTools/Studio")).toBe(
      "ssh.dev.azure.com/v3/studiotools/studio",
    );
  });
});

describe("parseOriginUrlFromGitConfig", () => {
  it("reads the origin url and ignores other remotes", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "upstream"]',
      "\turl = https://github.com/other/repo.git",
      '[remote "origin"]',
      "\turl = git@github.com:anton-abyzov/specwithcode.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("git@github.com:anton-abyzov/specwithcode.git");
  });

  it("strips inline comments and quotes from the url value", () => {
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/repo.git # mirror\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"]\n\turl = "git@github.com:acme/repo.git"\n'),
    ).toBe("git@github.com:acme/repo.git");
  });

  it("accepts legacy dotted headers, header comments, and line continuations", () => {
    expect(parseOriginUrlFromGitConfig("[remote.origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    // Git folds the dotted form to lowercase but keeps quoted names as written.
    expect(parseOriginUrlFromGitConfig("[remote.Origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "Origin"]\n\turl = git@github.com:x/y.git\n[remote "origin"]\n\turl = git@github.com:a/b.git\n',
      ),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"] # primary\n\turl = git@github.com:a/b.git\n'),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/\\\n\t\trepo.git\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
  });

  it("falls back to the first remote when there is no origin", () => {
    const config = [
      '[remote "upstream"]',
      "\turl = https://github.com/acme/repo.git",
      '[remote "fork"]',
      "\turl = https://github.com/me/repo.git",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("https://github.com/acme/repo.git");
  });

  it("returns null when there is no remote section", () => {
    expect(parseOriginUrlFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
    expect(parseOriginUrlFromGitConfig("")).toBeNull();
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:StudioTools/SpecWeaveStudio.git"),
    ).toBe("StudioTools/SpecWeaveStudio");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/StudioTools/SpecWeaveStudio.git"),
    ).toBe("StudioTools/SpecWeaveStudio");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://github.com/StudioTools/SpecWeaveStudio.git"),
    ).toBe("StudioTools/SpecWeaveStudio");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("normalizes a UUID-shaped random callback to the canonical 8-hex form", () => {
    expect(buildTemporaryWorktreeBranchName(() => "f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      `${WORKTREE_BRANCH_PREFIX}/f4ae4e0e`,
    );
  });

  it("matches legacy studio temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch("studio/deadbeef")).toBe(true);
    expect(isTemporaryWorktreeBranch("studio-deadbeef")).toBe(true);
    expect(isTemporaryWorktreeBranch("studio/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(true);
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12`),
    ).toBe(false);
  });

  it("rejects UUID-shaped refs that are not RFC 4122 v4", () => {
    // version nibble is not 4
    expect(isTemporaryWorktreeBranch("studio/f4ae4e0e-f971-1d48-b4f2-9cf0aa54ab12")).toBe(false);
    // variant nibble is not [89ab]
    expect(isTemporaryWorktreeBranch("studio/f4ae4e0e-f971-4d48-c4f2-9cf0aa54ab12")).toBe(false);
  });

  it("matches the flat fallback used when a plain specweave-studio branch exists", () => {
    const flat = flattenTemporaryWorktreeBranchName(`${WORKTREE_BRANCH_PREFIX}/deadbeef`);
    expect(flat).toBe(`${WORKTREE_BRANCH_PREFIX}-deadbeef`);
    expect(isTemporaryWorktreeBranch(flat)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}-deadbeef-extra`)).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}-feature`)).toBe(false);
    expect(flattenTemporaryWorktreeBranchName("studio/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      "studio-f4ae4e0e",
    );
    expect(flattenTemporaryWorktreeBranchName("studio-deadbeef")).toBe("studio-deadbeef");
    expect(flattenTemporaryWorktreeBranchName("studio/deadbeef")).toBe("studio-deadbeef");
  });

  it.each([
    ["specweave-studio/deadbeef", "specweave-studio-deadbeef"],
    ["specweave-studio-deadbeef", "specweave-studio-deadbeef"],
    [" SPECWEAVE-STUDIO/DEADBEEF ", "specweave-studio-deadbeef"],
    ["studio/deadbeef", "studio-deadbeef"],
    ["studio-deadbeef", "studio-deadbeef"],
    [" STUDIO/DEADBEEF ", "studio-deadbeef"],
    ["studio/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12", "studio-f4ae4e0e"],
  ])("preserves the complete temporary namespace and token in %s", (input, expected) => {
    expect(isTemporaryWorktreeBranch(input)).toBe(true);
    expect(flattenTemporaryWorktreeBranchName(input)).toBe(expected);
    expect(isTemporaryWorktreeBranch(expected)).toBe(true);
    expect(flattenTemporaryWorktreeBranchName(expected)).toBe(expected);
  });

  it.each([
    "specweave-studio/abcdefg0",
    "specweave-studio/deadbeef-extra",
    "specweave-studio/deadbee",
    "specweave-studio/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12",
    "studio/f4ae4e0e-f971-1d48-b4f2-9cf0aa54ab12",
    "studio/f4ae4e0e-f971-4d48-c4f2-9cf0aa54ab12",
    "studio/deadbeef/child",
    "other-studio/deadbeef",
    "my-feature",
  ])("does not recognize or rewrite a malformed temporary ref %s", (input) => {
    expect(isTemporaryWorktreeBranch(input)).toBe(false);
    expect(flattenTemporaryWorktreeBranchName(input)).toBe(input);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});

describe("formatGeneratedBranchName", () => {
  it.each(["studio", "studio/"])("joins static prefix %s with one slash", (prefix) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe("studio/add-search");
  });
  it("supports an empty prefix and preserves user prefix casing", () => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix: "", instructions: "" }),
    ).toBe("add-search");
    expect(
      formatGeneratedBranchName("Add Search", {
        mode: "static",
        prefix: "Team/Alice/",
        instructions: "",
      }),
    ).toBe("Team/Alice/add-search");
  });
  it.each([
    ["release..candidate", "release-candidate/add-search"],
    [" Team / Jules.lock/", "Team/Jules-lock/add-search"],
    ["-team//feature@{new}", "team/feature-new/add-search"],
    [" /?. / ", "add-search"],
  ])("normalizes invalid static prefix %s", (prefix, expected) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe(expected);
  });
  it("uses the model's semantic prefix without the stored static prefix", () => {
    expect(
      formatGeneratedBranchName("feat/Add Search", {
        mode: "semantic",
        prefix: "studio",
        instructions: "",
      }),
    ).toBe("feat/add-search");
  });
  it("preserves the full custom name, including case, dots and length", () => {
    const branch = `Alice/ABC-123/release.v2-${"x".repeat(70)}`;
    expect(
      formatGeneratedBranchName(` ${branch} `, {
        mode: "custom",
        prefix: "ignored",
        instructions: "",
      }),
    ).toBe(branch);
  });
});
