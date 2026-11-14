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
  sanitizeCopiedGitDir,
  worktreeInside,
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
    const kept = safeGitConfigEntries(
      [
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
      ],
      { keepWorktree: (value) => !value.startsWith("/") },
    );
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
  it("skips only the main hooks folder while copying; sanitizing removes the rest", () => {
    expect(isUncarriedGitPath("hooks", true)).toBe(true);
    // A branch named hooks/x lives in refs/heads/hooks: never skipped by name.
    expect(isUncarriedGitPath("refs/heads/hooks", true)).toBe(false);
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
    NodeFS.mkdirSync(NodePath.join(gitDir, "modules/lib/objects"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(main, "lib"));
    write(NodePath.join(gitDir, "modules/lib/HEAD"), "ref: refs/heads/main\n");
    write(
      NodePath.join(gitDir, "modules/lib/config"),
      "[core]\n\tbare = false\n\tworktree = ../../../lib\n\tfsmonitor = evil-fsmonitor\n",
    );
    await sanitizeCopiedGitDir(gitDir, main);
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

  it("sanitizes every Git directory and removes what selects or names other places", async () => {
    const root = tempRoot();
    const main = repository(root);
    const gitDir = NodePath.join(main, ".git");
    // A submodule whose name holds a slash and starts with refs.
    const nested = NodePath.join(gitDir, "modules/refs/lib");
    NodeFS.mkdirSync(nested, { recursive: true });
    write(NodePath.join(nested, "HEAD"), "ref: refs/heads/main\n");
    write(
      NodePath.join(nested, "config"),
      "[core]\n\tfsmonitor = evil-fsmonitor\n\tworktree = ../../../../..\n",
    );
    NodeFS.mkdirSync(NodePath.join(nested, "objects"));
    // A submodule named `x/HEAD`: its parent folder holds a HEAD folder, not a Git directory.
    const underHead = NodePath.join(gitDir, "modules/x/HEAD");
    write(NodePath.join(underHead, "HEAD"), "ref: refs/heads/main\n");
    NodeFS.mkdirSync(NodePath.join(underHead, "objects"));
    write(NodePath.join(underHead, "config"), "[core]\n\tfsmonitor = evil-fsmonitor\n");
    write(NodePath.join(gitDir, "commondir"), "shadow\n");
    write(NodePath.join(gitDir, "shadow/config"), "[core]\n\tfsmonitor = evil-fsmonitor\n");
    write(NodePath.join(gitDir, "remotes/origin"), "URL: https://u:token@example.invalid/r.git\n");
    write(NodePath.join(nested, "hooks/post-checkout"), "#!/bin/sh\nexit 1\n", 0o755);
    const configFile = NodePath.join(gitDir, "config");
    git(
      root,
      "config",
      "--file",
      configFile,
      "branch.main.remote",
      "https://u:token@example.invalid/r.git",
    );
    git(root, "config", "--file", configFile, "branch.main.pushRemote", "origin");
    git(
      root,
      "config",
      "--file",
      configFile,
      "remote.web.url",
      "https://example.invalid/r.git?access_token=secret#x",
    );
    git(
      root,
      "config",
      "--file",
      configFile,
      "extensions.partialClone",
      "https://u:token@example.invalid/r.git",
    );
    git(root, "config", "--file", configFile, "filter.lfs.smudge", "git-lfs smudge -- %f");
    git(root, "config", "--file", configFile, "filter.lfs.process", "git-lfs filter-process");
    git(root, "config", "--file", configFile, "filter.lfs.clean", "evil-clean %f");
    await sanitizeCopiedGitDir(gitDir, main);
    expect(NodeFS.existsSync(NodePath.join(gitDir, "commondir"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(gitDir, "remotes"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(nested, "hooks"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(underHead, "config"), "utf8")).not.toContain("evil");
    const nestedConfig = NodeFS.readFileSync(NodePath.join(nested, "config"), "utf8");
    expect(nestedConfig).not.toContain("evil");
    // A worktree outside the copied folder is dropped.
    expect(nestedConfig).not.toContain("worktree");
    const read = (key: string) =>
      git(root, "config", "--file", configFile, "--get-all", key).split("\n");
    expect(read("branch.main.remote")).toEqual(["https://example.invalid/r.git"]);
    expect(read("branch.main.pushremote")).toEqual(["origin"]);
    expect(read("remote.web.url")).toEqual(["https://example.invalid/r.git"]);
    expect(read("extensions.partialclone")).toEqual(["https://example.invalid/r.git"]);
    expect(read("filter.lfs.smudge")).toEqual(["git-lfs smudge -- %f"]);
    expect(read("filter.lfs.process")).toEqual(["git-lfs filter-process"]);
    expect(NodeFS.readFileSync(configFile, "utf8")).not.toContain("evil-clean");
  });

  it("finds a submodule a planted repository at its name prefix would hide", async () => {
    const root = tempRoot();
    const main = repository(root);
    const gitDir = NodePath.join(main, ".git");
    const evil = "[core]\n\tfsmonitor = evil-fsmonitor\n";
    // A real submodule `a/lib`, and a repository planted at `modules/a`.
    for (const dir of ["modules/a", "modules/a/lib"]) {
      write(NodePath.join(gitDir, dir, "HEAD"), "ref: refs/heads/main\n");
      NodeFS.mkdirSync(NodePath.join(gitDir, dir, "objects"), { recursive: true });
      write(NodePath.join(gitDir, dir, "config"), evil);
    }
    await sanitizeCopiedGitDir(gitDir, main);
    for (const dir of ["modules/a", "modules/a/lib"])
      expect(NodeFS.readFileSync(NodePath.join(gitDir, dir, "config"), "utf8")).not.toContain(
        "evil",
      );
    expect(isUncarriedGitPath("HOOKS", true)).toBe(true);
  });

  it("refuses another spelling of a name Git reads, naming its path", async () => {
    const root = tempRoot();
    const main = repository(root);
    const gitDir = NodePath.join(main, ".git");
    // `commondir` does not exist here, so `Commondir` keeps its spelling on every disk.
    write(NodePath.join(gitDir, "Commondir"), "shadow\n");
    await expect(sanitizeCopiedGitDir(gitDir, main)).rejects.toThrow(
      /Git data at \.git\/Commondir is spelled differently from commondir/,
    );
    NodeFS.rmSync(NodePath.join(gitDir, "Commondir"));
    // Aliases of existing names exist only on a case-sensitive disk (Linux).
    write(NodePath.join(root, "probe"), "");
    if (!NodeFS.existsSync(NodePath.join(root, "PROBE"))) {
      write(NodePath.join(gitDir, "HOOKS/post-checkout"), "#!/bin/sh\nexit 1\n", 0o755);
      await expect(sanitizeCopiedGitDir(gitDir, main)).rejects.toThrow(/\.git\/HOOKS/);
      // Nothing is deleted when the copy is refused.
      expect(NodeFS.existsSync(NodePath.join(gitDir, "HOOKS/post-checkout"))).toBe(true);
    }
    // Ref names are the user's own and are not checked.
    git(main, "branch", "Config");
    git(main, "update-ref", "refs/heads/HEAD-like/Index", "HEAD");
    NodeFS.rmSync(NodePath.join(gitDir, "HOOKS"), { recursive: true, force: true });
    await expect(sanitizeCopiedGitDir(gitDir, main)).resolves.toBeUndefined();
  });

  it("does not copy a .GIT folder some disks read as .git", async () => {
    const root = tempRoot();
    const folder = NodePath.join(root, "folder");
    write(NodePath.join(folder, "file.txt"), "kept\n");
    write(NodePath.join(folder, "sub/.GIT/config"), "[core]\n\tfsmonitor = evil-fsmonitor\n");
    const scan = await scanFolder(folder);
    expect(scan.entries.some((entry) => entry.path.toLowerCase().includes(".git"))).toBe(false);
    expect(scan.warnings.join(" ")).toContain("some disks read it as .git");
  });

  it("refuses a submodule whose HEAD or todo is spelled differently", async () => {
    const root = tempRoot();
    const main = repository(root);
    const gitDir = NodePath.join(main, ".git");
    // A dormant submodule whose HEAD is spelled `head`: one on a case-insensitive disk.
    const dormant = NodePath.join(gitDir, "modules/dormant");
    write(NodePath.join(dormant, "head"), "ref: refs/heads/main\n");
    NodeFS.mkdirSync(NodePath.join(dormant, "objects"), { recursive: true });
    write(NodePath.join(dormant, "config"), "[core]\n\tfsmonitor = evil-fsmonitor\n");
    await expect(sanitizeCopiedGitDir(gitDir, main)).rejects.toThrow(
      /\.git\/modules\/dormant\/head is spelled differently from HEAD/,
    );
    NodeFS.rmSync(dormant, { recursive: true });
    // A rebase todo under another spelling.
    write(NodePath.join(gitDir, "rebase-merge/GIT-REBASE-TODO"), "exec touch /tmp/x\n");
    await expect(sanitizeCopiedGitDir(gitDir, main)).rejects.toThrow(
      /rebase-merge\/GIT-REBASE-TODO/,
    );
  });

  it.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "refuses an object store pointer spelled ALTERNATES",
    async () => {
      const root = tempRoot();
      const main = repository(root);
      const outside = NodePath.join(root, "outside.git");
      git(root, "init", "-q", "--bare", outside);
      write(NodePath.join(main, ".git/objects/info/ALTERNATES"), `${outside}/objects\n`);
      const scan = await scanFolder(main);
      await expect(preparePortableGit(scan, NodePath.join(root, "overlay"))).rejects.toThrow(
        /ALTERNATES is spelled differently from alternates/,
      );
    },
  );

  it("makes a submodule that borrows objects self-contained", async () => {
    const root = tempRoot();
    const main = repository(root);
    const reference = NodePath.join(root, "reference");
    NodeFS.mkdirSync(reference);
    git(reference, "init", "-q", "-b", "main");
    write(NodePath.join(reference, "lib.txt"), "lib\n");
    git(reference, "add", ".");
    git(reference, "commit", "-qm", "lib");
    // A dormant submodule Git directory whose objects live in `reference`.
    const lib = NodePath.join(main, ".git/modules/lib");
    git(root, "clone", "-q", "--bare", "--shared", reference, lib);
    expect(NodeFS.existsSync(NodePath.join(lib, "objects/info/alternates"))).toBe(true);
    const scan = await scanFolder(main);
    const overlay = NodePath.join(root, "overlay");
    await preparePortableGit(scan, overlay);
    NodeFS.renameSync(reference, NodePath.join(root, "gone"));
    const copied = NodePath.join(overlay, ".git/modules/lib");
    expect(NodeFS.existsSync(NodePath.join(copied, "objects/info/alternates"))).toBe(false);
    expect(git(root, "--git-dir", copied, "cat-file", "-t", "HEAD")).toBe("commit");
    expect(git(root, "--git-dir", copied, "show", "HEAD:lib.txt")).toBe("lib");
  });

  it("refuses a pending rebase that runs commands", async () => {
    const root = tempRoot();
    const main = repository(root);
    const gitDir = NodePath.join(main, ".git");
    write(
      NodePath.join(gitDir, "rebase-merge/git-rebase-todo"),
      "pick abc one\nexec touch /tmp/x\n",
    );
    await expect(sanitizeCopiedGitDir(gitDir, main)).rejects.toThrow(/exec lines/);
    write(NodePath.join(gitDir, "rebase-merge/git-rebase-todo"), "pick abc one\n");
    await expect(sanitizeCopiedGitDir(gitDir, main)).resolves.toBeUndefined();
  });

  it("does not copy a linked .git", async () => {
    const root = tempRoot();
    const folder = NodePath.join(root, "folder");
    const elsewhere = repository(root);
    write(NodePath.join(folder, "file.txt"), "kept\n");
    NodeFS.symlinkSync(NodePath.join(elsewhere, ".git"), NodePath.join(folder, ".git"));
    const scan = await scanFolder(folder);
    expect(scan.entries.some((entry) => entry.path.startsWith(".git"))).toBe(false);
    expect(scan.entries.some((entry) => entry.path === "file.txt")).toBe(true);
    expect(scan.warnings.join(" ")).toContain("has a .git link");
  });

  it("does not copy a .git Git cannot read", async () => {
    const root = tempRoot();
    const folder = NodePath.join(root, "folder");
    write(NodePath.join(folder, "file.txt"), "kept\n");
    write(NodePath.join(folder, ".git/config"), "[core]\n\tfsmonitor = evil-fsmonitor\n");
    write(NodePath.join(folder, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 1\n", 0o755);
    const scan = await scanFolder(folder);
    expect(scan.entries.some((entry) => entry.path.startsWith(".git"))).toBe(false);
    expect(scan.entries.some((entry) => entry.path === "file.txt")).toBe(true);
    expect(scan.warnings.join(" ")).toContain("its Git data is not copied");
  });
});

describe("remote URL forms", () => {
  it.each([
    ["host.example:org/repo.git", "host.example:org/repo.git"],
    ["git@[::1]:org/repo.git", "git@[::1]:org/repo.git"],
    ["git@host.example:path with spaces/repo.git", "git@host.example:path with spaces/repo.git"],
    ["ssh://git@host.example/srv/link/../repo.git", "ssh://git@host.example/srv/link/../repo.git"],
    ["https://%75ser:%70w@host.example/r.git", "https://host.example/r.git"],
  ])("keeps %s as %s", (raw, expected) => {
    expect(safeRemoteUrl(raw)).toBe(expected);
  });

  it.each(["C:/repo", "-oProxyCommand=x:repo", "ssh://-oProxyCommand=x/repo", "git@host:repo\nx"])(
    "drops %s",
    (raw) => {
      expect(safeRemoteUrl(raw)).toBeNull();
    },
  );

  it.each([
    ["https://u:token@host.example?access_token=x", "https://host.example"],
    ["https://host.example#token", "https://host.example"],
    ["http://u:pw@host.example?x=1/y", "http://host.example"],
  ])("strips credentials and queries from %s", (raw, expected) => {
    expect(safeRemoteUrl(raw)).toBe(expected);
  });

  it("keeps a submodule worktree only inside the copied folder, through no link", async () => {
    const root = tempRoot();
    const copy = NodePath.join(root, "copy");
    NodeFS.mkdirSync(NodePath.join(copy, "lib"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(root, "outside"));
    NodeFS.symlinkSync(NodePath.join(root, "outside"), NodePath.join(copy, "linked"));
    const check = {
      file: NodePath.join(copy, ".git/modules/lib/config"),
      root: copy,
      sourceRoot: copy,
    };
    expect(await worktreeInside(check, "../../../lib")).toBe(true);
    expect(await worktreeInside(check, "../../../linked")).toBe(false);
    expect(await worktreeInside(check, "../../../linked/../lib")).toBe(false);
    expect(await worktreeInside(check, "../../../missing")).toBe(false);
    expect(await worktreeInside(check, "../../../..")).toBe(false);
    expect(await worktreeInside(check, "\\\\server\\share")).toBe(false);
    expect(await worktreeInside(check, "C:lib")).toBe(false);
  });
});
