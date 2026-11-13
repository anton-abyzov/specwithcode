// @effect-diagnostics nodeBuiltinImport:off - disposable real Git repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { git, write } from "./folderFixture.testkit.ts";
import { scanFolder } from "./manifest.ts";
import { preparePortableGit } from "./portableGit.ts";
import {
  isUncarriedGitPath,
  parseNullConfigList,
  rewriteCopiedGitConfigs,
  safeGitConfigEntries,
  safeRemoteUrl,
} from "./safeGitConfig.ts";
import { summarize, TRACKED_SECRET_SOURCE } from "./sourceSummary.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-safe-git-config-")),
  );
  roots.push(root);
  return root;
}

const UNSAFE = [
  ["core.hooksPath", "/tmp/evil-hooks"],
  ["core.fsmonitor", "evil-fsmonitor"],
  ["core.sshCommand", "ssh -o ProxyCommand=evil"],
  ["core.pager", "evil"],
  ["core.worktree", "/Users/someone/elsewhere"],
  ["credential.helper", "!echo password=stolen"],
  ["filter.lfs.smudge", "evil-smudge %f"],
  ["filter.lfs.process", "evil-process"],
  ["diff.evil.textconv", "evil"],
  ["alias.st", "!evil"],
  ["include.path", "/tmp/evil.config"],
  ["url.ext::sh -c evil.insteadOf", "https://github.com/"],
  ["http.extraHeader", "Authorization: Bearer secret"],
  ["remote.mirror.receivepack", "evil"],
  ["remote.mirror.uploadpack", "evil"],
  ["submodule.lib.update", "!evil"],
] as const;

describe("safeRemoteUrl", () => {
  it.each([
    ["https://user:token@github.com/org/repo.git", "https://github.com/org/repo.git"],
    ["https://token@github.com/org/repo.git", "https://github.com/org/repo.git"],
    ["ssh://git:pw@host.example/repo.git", "ssh://git@host.example/repo.git"],
    ["git@github.com:org/repo.git", "git@github.com:org/repo.git"],
    ["git://host.example/repo.git", "git://host.example/repo.git"],
  ])("keeps %s as %s", (raw, expected) => {
    expect(safeRemoteUrl(raw)).toBe(expected);
  });

  it.each([
    "ext::sh -c touch% /tmp/pwned",
    "fd::17",
    "file:///Users/me/repo",
    "/Users/me/repo",
    "../sibling",
    "C:\\repo",
    "",
  ])("drops %s", (raw) => {
    expect(safeRemoteUrl(raw)).toBeNull();
  });
});

describe("safeGitConfigEntries", () => {
  it("keeps plain settings and drops every command, helper, alias and include", () => {
    const kept = safeGitConfigEntries([
      ["core.repositoryformatversion", "0"],
      ["core.bare", "false"],
      ["remote.origin.url", "https://u:t@example.invalid/r.git"],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["branch.main.remote", "origin"],
      ["branch.main.merge", "refs/heads/main"],
      ["submodule.lib.url", "https://example.invalid/lib.git"],
      ["submodule.lib.update", "rebase"],
      ["core.worktree", "../../../lib"],
      ...UNSAFE,
    ]);
    expect(kept).toEqual([
      ["core.repositoryformatversion", "0"],
      ["core.bare", "false"],
      ["remote.origin.url", "https://example.invalid/r.git"],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["branch.main.remote", "origin"],
      ["branch.main.merge", "refs/heads/main"],
      ["submodule.lib.url", "https://example.invalid/lib.git"],
      ["submodule.lib.update", "rebase"],
      ["core.worktree", "../../../lib"],
    ]);
  });

  it("drops a remote whose URL runs a helper", () => {
    expect(safeGitConfigEntries([["remote.origin.url", "ext::sh -c evil"]])).toEqual([]);
  });
});

describe("parseNullConfigList", () => {
  it("reads key and value records, and bare keys as true", () => {
    expect(parseNullConfigList("core.bare\nfalse\0core.symlinks\0a.b\nline1\nline2\0")).toEqual([
      ["core.bare", "false"],
      ["core.symlinks", "true"],
      ["a.b", "line1\nline2"],
    ]);
  });
});

describe("isUncarriedGitPath", () => {
  it("skips hooks folders at any depth and nothing else", () => {
    expect(isUncarriedGitPath("hooks", true)).toBe(true);
    expect(isUncarriedGitPath("modules/lib/hooks", true)).toBe(true);
    expect(isUncarriedGitPath("hooks", false)).toBe(false);
    expect(isUncarriedGitPath("config", false)).toBe(false);
    expect(isUncarriedGitPath("refs/heads/hooks", false)).toBe(false);
  });
});

describe("copied repositories", () => {
  function repository(root: string) {
    const main = NodePath.join(root, "main");
    NodeFS.mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    write(NodePath.join(main, "file.txt"), "initial\n");
    write(NodePath.join(main, ".env"), "TOKEN=tracked\n");
    write(NodePath.join(main, "certs/server.pem"), "{}\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "initial");
    git(
      main,
      "config",
      "remote.origin.url",
      "https://private:never-transfer@example.invalid/r.git",
    );
    return main;
  }

  /** Writes the unsafe settings from outside the repository, so Git never applies them here. */
  function poison(root: string, main: string) {
    const configFile = NodePath.join(main, ".git/config");
    for (const [key, value] of UNSAFE)
      if (key !== "core.worktree") git(root, "config", "--file", configFile, key, value);
    git(root, "config", "--file", configFile, "extensions.worktreeConfig", "true");
    write(NodePath.join(main, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 1\n", 0o755);
    write(
      NodePath.join(main, ".git/config.worktree"),
      "[core]\n\tautocrlf = false\n\tfsmonitor = evil-fsmonitor\n",
    );
  }

  it("rewrites a Git directory's configs to the safe entries", async () => {
    const root = tempRoot();
    const main = repository(root);
    poison(root, main);
    const gitDir = NodePath.join(main, ".git");
    NodeFS.mkdirSync(NodePath.join(gitDir, "modules/lib"), { recursive: true });
    write(NodePath.join(gitDir, "modules/lib/HEAD"), "ref: refs/heads/main\n");
    write(
      NodePath.join(gitDir, "modules/lib/config"),
      "[core]\n\tbare = false\n\tworktree = ../../../lib\n\tfsmonitor = evil-fsmonitor\n",
    );
    await rewriteCopiedGitConfigs(gitDir);
    const config = NodeFS.readFileSync(NodePath.join(gitDir, "config"), "utf8");
    for (const [, value] of UNSAFE) expect(config).not.toContain(value);
    expect(config).not.toContain("never-transfer");
    expect(
      git(root, "config", "--file", NodePath.join(gitDir, "config"), "remote.origin.url"),
    ).toBe("https://example.invalid/r.git");
    expect(
      git(
        root,
        "config",
        "--file",
        NodePath.join(gitDir, "config"),
        "--bool",
        "extensions.worktreeConfig",
      ),
    ).toBe("true");
    const worktreeConfig = NodeFS.readFileSync(NodePath.join(gitDir, "config.worktree"), "utf8");
    expect(worktreeConfig).toContain("autocrlf");
    expect(worktreeConfig).not.toContain("evil");
    const lib = NodeFS.readFileSync(NodePath.join(gitDir, "modules/lib/config"), "utf8");
    expect(lib).toContain("../../../lib");
    expect(lib).not.toContain("evil");
  });

  it("prepares a main repository without hooks or unsafe settings, and names tracked secrets", async () => {
    const root = tempRoot();
    const main = repository(root);
    const scan = await scanFolder(main);
    poison(root, main);
    const overlay = NodePath.join(root, "overlay");
    const prepared = await preparePortableGit(scan, overlay);
    expect(prepared.entries.some((entry) => entry.path.startsWith(".git/hooks"))).toBe(false);
    const copied = NodeFS.readFileSync(NodePath.join(overlay, ".git/config"), "utf8");
    expect(copied).toContain("https://example.invalid/r.git");
    for (const [, value] of UNSAFE) expect(copied).not.toContain(value);
    expect(copied).not.toContain("never-transfer");
    expect(NodeFS.existsSync(NodePath.join(overlay, ".git/hooks"))).toBe(false);
    // The source keeps everything.
    expect(
      git(root, "config", "--file", NodePath.join(main, ".git/config"), "core.fsmonitor"),
    ).toBe("evil-fsmonitor");
    expect(NodeFS.existsSync(NodePath.join(main, ".git/hooks/post-checkout"))).toBe(true);

    const hints = summarize(scan).secretHints ?? [];
    expect(
      hints.filter((hint) => hint.source === TRACKED_SECRET_SOURCE).map((h) => h.path),
    ).toEqual(expect.arrayContaining([".env", "certs/server.pem"]));
    expect(hints.some((hint) => hint.path === "file.txt")).toBe(false);
  });
});
