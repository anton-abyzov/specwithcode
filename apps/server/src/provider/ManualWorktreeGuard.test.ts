// @effect-diagnostics nodeBuiltinImport:off - runs the generated shim as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  MANUAL_WORKTREE_REFUSAL,
  installManualWorktreeGuard,
  isGitWorktreeAdd,
  manualWorktreeGuardFiles,
  manualWorktreeGuardPath,
  msysPath,
  posixGitShim,
  resolveRealGit,
  setManualWorktreeGuard,
  windowsGitShim,
  withManualWorktreeGuard,
} from "./ManualWorktreeGuard.ts";

const WORKTREE = "worktree";
/** [git args, refused] */
const CASES: ReadonlyArray<readonly [ReadonlyArray<string>, boolean]> = [
  [[WORKTREE, "add", "../x"], true],
  [[WORKTREE, "add", "--no-checkout", "-b", "fix/a", "/tmp/a", "origin/main"], true],
  [["-C", "/repo", WORKTREE, "add", "/tmp/a"], true],
  [["-c", "core.hooksPath=/x", "-C", "/repo", WORKTREE, "add", "/tmp/a"], true],
  [["--git-dir=/repo/.git", "--work-tree=/repo", WORKTREE, "add", "/tmp/a"], true],
  [["--git-dir", "/repo/.git", WORKTREE, "add", "/tmp/a"], true],
  [["--no-pager", "-P", WORKTREE, "add", "/tmp/a"], true],
  [[WORKTREE, "list"], false],
  [[WORKTREE, "remove", "/tmp/a"], false],
  [[WORKTREE], false],
  [["status"], false],
  [["log", WORKTREE, "add"], false],
  [["commit", "-m", "worktree add"], false],
  [["-C", WORKTREE, "add", "file.txt"], false],
  [["-c", "x=y", "status"], false],
  [[], false],
];

const temporaryDirectories: string[] = [];
const temporaryDirectory = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worktree-guard-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  setManualWorktreeGuard(null);
  for (const directory of temporaryDirectories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("isGitWorktreeAdd", () => {
  it.each(CASES)("%j refused: %s", (args, refused) => {
    expect(isGitWorktreeAdd(args)).toBe(refused);
  });
});

// oxlint-disable-next-line studio/no-global-process-runtime -- the shim runs under the real host shell.
describe.skipIf(process.platform === "win32")("posix git shim", () => {
  const install = () => {
    const directory = temporaryDirectory();
    const realGit = NodePath.join(directory, "real git");
    // Records its arguments one per line and exits 7, so pass-through is visible.
    NodeFS.writeFileSync(realGit, '#!/bin/sh\nfor a do printf "%s\\n" "$a"; done\nexit 7\n', {
      mode: 0o755,
    });
    const shim = NodePath.join(directory, "git");
    NodeFS.writeFileSync(shim, posixGitShim(realGit), { mode: 0o755 });
    return shim;
  };

  it.each(CASES)("%j refused: %s", (args, refused) => {
    const result = NodeChildProcess.spawnSync(install(), [...args], { encoding: "utf8" });
    if (refused) {
      expect(result.status).toBe(128);
      expect(result.stderr).toBe(`fatal: ${MANUAL_WORKTREE_REFUSAL}\n`);
      expect(result.stdout).toBe("");
    } else {
      expect(result.status).toBe(7);
      expect(result.stdout).toBe(args.map((arg) => `${arg}\n`).join(""));
    }
  });

  it("passes arguments with spaces, quotes and globs through untouched", () => {
    const args = ["commit", "-m", 'it\'s a "msg" with *', "--", "a b"];
    const result = NodeChildProcess.spawnSync(install(), args, { encoding: "utf8" });
    expect(result.status).toBe(7);
    expect(result.stdout).toBe(args.map((arg) => `${arg}\n`).join(""));
  });

  it("is written for the git found on PATH, never for itself", () => {
    const stateDir = temporaryDirectory();
    const bin = NodePath.join(stateDir, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "git"), '#!/bin/sh\necho real "$@"\n', {
      mode: 0o755,
    });
    const guardDir = NodePath.join(stateDir, "agent-bin");
    const serverEnvironment = { PATH: `${guardDir}:${bin}` };
    const install = () =>
      installManualWorktreeGuard({ stateDir, serverEnvironment, platform: "linux" });
    expect(install()).toEqual({ directory: guardDir, platform: "linux", serverEnvironment });
    // A second start with the shim already first on PATH still wraps the real git.
    install();
    const shim = NodePath.join(guardDir, "git");
    expect(NodeFS.statSync(shim).mode & 0o111).not.toBe(0);
    expect(NodeChildProcess.spawnSync(shim, ["status"], { encoding: "utf8" }).stdout).toBe(
      "real status\n",
    );
    expect(
      NodeChildProcess.spawnSync(shim, [WORKTREE, "add", "x"], { encoding: "utf8" }).status,
    ).toBe(128);
  });
});

describe("resolveRealGit", () => {
  it("skips the shim directory and relative entries", () => {
    const found = new Set(["/guard/git", "/usr/bin/git"]);
    expect(
      resolveRealGit("relative:/guard:/usr/bin", {
        platform: "linux",
        exclude: "/guard",
        isExecutable: (candidate) => found.has(candidate),
      }),
    ).toBe("/usr/bin/git");
    expect(resolveRealGit("/nowhere", { platform: "linux", isExecutable: () => false })).toBe(null);
  });

  it("finds git.exe on Windows", () => {
    expect(
      resolveRealGit("C:\\guard;C:\\Program Files\\Git\\cmd", {
        platform: "win32",
        exclude: "C:\\guard",
        isExecutable: (candidate) => candidate.endsWith("git.exe"),
      }),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });
});

describe("windowsGitShim", () => {
  it("runs the real git with every argument and refuses worktree add", () => {
    const shim = windowsGitShim("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(shim).toContain('"C:\\Program Files\\Git\\cmd\\git.exe" %*\r\n');
    expect(shim).toContain('if "%~1"=="worktree" if "%~2"=="add" exit /b 1');
    expect(shim).toContain(MANUAL_WORKTREE_REFUSAL);
    expect(shim.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("also writes an sh shim Git Bash finds, calling git by its MSYS path", () => {
    const realGit = "C:\\Program Files\\Git\\cmd\\git.exe";
    expect(msysPath(realGit)).toBe("/c/Program Files/Git/cmd/git.exe");
    expect(manualWorktreeGuardFiles("win32", realGit)).toEqual([
      ["git.cmd", windowsGitShim(realGit)],
      ["git", posixGitShim("/c/Program Files/Git/cmd/git.exe")],
    ]);
    expect(manualWorktreeGuardFiles("darwin", "/usr/bin/git")).toEqual([
      ["git", posixGitShim("/usr/bin/git")],
    ]);
  });
});

/**
 * The POSIX cases, where any bare `worktree add` pair is refused, plus an
 * empty argument the scan must not stop at.
 */
const WINDOWS_CASES: ReadonlyArray<readonly [ReadonlyArray<string>, boolean]> = [
  ...CASES.map(
    ([args, refused]) => [args, refused || args.join(" ").includes(`${WORKTREE} add`)] as const,
  ).filter(([args]) => !args.includes(`${WORKTREE} add`)),
  [["commit", "-m", `${WORKTREE} add`], false],
  [["-C", "", WORKTREE, "add", "../x"], true],
];

// oxlint-disable-next-line studio/no-global-process-runtime -- cmd.exe runs the shim for real.
describe.runIf(process.platform === "win32")("windows git shim under cmd.exe", () => {
  const install = () => {
    const directory = temporaryDirectory();
    const realGit = NodePath.join(directory, "real git.cmd");
    // Prints its arguments and exits 7, so pass-through is visible.
    NodeFS.writeFileSync(realGit, "@echo off\r\necho(%*\r\nexit /b 7\r\n");
    const shim = NodePath.join(directory, "git.cmd");
    NodeFS.writeFileSync(shim, windowsGitShim(realGit));
    return shim;
  };
  const quote = (arg: string) => (arg === "" || /[\s=,;]/.test(arg) ? `"${arg}"` : arg);

  it.each(WINDOWS_CASES)("%j refused: %s", (args, refused) => {
    const command = `"${install()}" ${args.map(quote).join(" ")}`;
    const result = NodeChildProcess.spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect({ status: result.status, stderr: result.stderr.trim() }).toEqual(
      refused
        ? { status: 128, stderr: `fatal: ${MANUAL_WORKTREE_REFUSAL}` }
        : { status: 7, stderr: "" },
    );
    if (!refused) expect(result.stdout.trim()).toBe(args.map(quote).join(" "));
  });

  it("refuses -c key=value before worktree add when cmd splits it", () => {
    const command = `"${install()}" -c core.longpaths=true ${WORKTREE} add ../x`;
    const result = NodeChildProcess.spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect(result.status).toBe(128);
  });
});

// oxlint-disable-next-line studio/no-global-process-runtime -- runs the shells agents use.
describe.skipIf(process.platform === "win32")("the guarded PATH in agent shells", () => {
  // Claude Code, Pi and OpenCode run tool commands as `<shell> -c` (Claude Code
  // after its snapshot of the user's rc files, which keeps the inherited PATH
  // first); only a login shell (`-l`, as Codex uses) rebuilds PATH.
  it.each(["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => NodeFS.existsSync(shell)))(
    "%s -c finds the shim first",
    (shell) => {
      const stateDir = temporaryDirectory();
      const bin = NodePath.join(stateDir, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.writeFileSync(NodePath.join(bin, "git"), '#!/bin/sh\necho real "$@"\n', {
        mode: 0o755,
      });
      const guard = installManualWorktreeGuard({
        stateDir,
        serverEnvironment: { PATH: `${bin}:/usr/bin:/bin` },
        platform: "linux",
      });
      setManualWorktreeGuard(guard);
      const environment = withManualWorktreeGuard({ PATH: `${bin}:/usr/bin:/bin` }, true);
      const run = (script: string) =>
        NodeChildProcess.spawnSync(shell, ["-c", script], {
          encoding: "utf8",
          env: { ...environment, HOME: stateDir },
        });
      expect(run("command -v git").stdout.trim()).toBe(NodePath.join(guard!.directory, "git"));
      expect(run(`git ${WORKTREE} add ../x`).status).toBe(128);
      expect(run("git status").stdout).toBe("real status\n");
    },
  );
});

const linuxGuard = {
  directory: "/g",
  platform: "linux",
  serverEnvironment: { PATH: "/server/bin" },
} as const;

describe("manualWorktreeGuardPath", () => {
  it("is empty unless the thread is blocked and the shim is installed", () => {
    expect(manualWorktreeGuardPath({ PATH: "/usr/bin" }, false, linuxGuard)).toEqual({});
    expect(manualWorktreeGuardPath({ PATH: "/usr/bin" }, undefined, linuxGuard)).toEqual({});
    expect(manualWorktreeGuardPath({ PATH: "/usr/bin" }, true, null)).toEqual({});
  });

  it("puts the shim first once, on the environment's own PATH", () => {
    expect(manualWorktreeGuardPath({ PATH: "/usr/bin:/g:/bin" }, true, linuxGuard)).toEqual({
      PATH: "/g:/usr/bin:/bin",
    });
    expect(manualWorktreeGuardPath(undefined, true, linuxGuard)).toEqual({
      PATH: "/g:/server/bin",
    });
  });

  it("keeps the Windows Path key and separator", () => {
    expect(
      manualWorktreeGuardPath({ Path: "C:\\Windows;C:\\Git\\cmd" }, true, {
        directory: "C:\\state\\agent-bin",
        platform: "win32",
        serverEnvironment: {},
      }),
    ).toEqual({ Path: "C:\\state\\agent-bin;C:\\Windows;C:\\Git\\cmd" });
  });
});

const stateGuard = {
  directory: "/state/agent-bin",
  platform: "linux",
  serverEnvironment: { PATH: "/usr/bin" },
} as const;

describe("provider environments", () => {
  it("guard a local-checkout thread's environment and leave a worktree thread's alone", () => {
    setManualWorktreeGuard(stateGuard);
    const environment = { PATH: "/usr/bin", HOME: "/home/a" };
    expect(withManualWorktreeGuard(environment, false)).toBe(environment);
    expect(withManualWorktreeGuard(environment, true)).toEqual({
      PATH: "/state/agent-bin:/usr/bin",
      HOME: "/home/a",
    });
  });

  it("gives a local Codex thread the guarded PATH without a login shell", () => {
    setManualWorktreeGuard(stateGuard);
    const runtimePolicy = (manualWorktreesBlocked: boolean) => ({
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      cwd: "/repo",
      manualWorktreesBlocked,
    });
    const local = codexThreadRuntimeParams({
      threadId: null,
      environment: { PATH: "/usr/bin" },
      runtimePolicy: runtimePolicy(true),
    }).config;
    expect(local).toMatchObject({
      allow_login_shell: false,
      "shell_environment_policy.set.PATH": "/state/agent-bin:/usr/bin",
    });
    const worktree = codexThreadRuntimeParams({
      threadId: null,
      environment: { PATH: "/usr/bin" },
      runtimePolicy: runtimePolicy(false),
    }).config;
    expect(Object.keys(worktree)).not.toContain("allow_login_shell");
    expect(Object.keys(worktree)).not.toContain("shell_environment_policy.set.PATH");
  });
});
