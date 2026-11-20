// @effect-diagnostics nodeBuiltinImport:off - temp folders standing in for a machine's own places.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { knownHostsFile, type MachineSources, probeMachine } from "./machine.ts";
import { knownGitHosts, type ProbeSpawn } from "./probe.ts";
import type { TerminalEnvironment } from "./terminalEnv.ts";

let base: string;
let project: string;
let commands: string;
let managed: string;

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "credentials-machine-")),
  );
  project = NodePath.join(base, "project");
  commands = NodePath.join(base, "app", "commands");
  managed = NodePath.join(base, "app", "tools", "gh", "bin");
  for (const folder of [project, commands, managed])
    await NodeFSP.mkdir(folder, { recursive: true });
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

const spawn: ProbeSpawn = async () => ({ exitCode: 0, printed: true, timedOut: false });
const shell = (over: Partial<TerminalEnvironment> = {}): TerminalEnvironment => ({
  path: "/opt/homebrew/bin:/usr/bin",
  xdgConfigHome: null,
  variables: {},
  ...over,
});
const sources = (over: Partial<MachineSources> = {}) => {
  const asked: Array<boolean> = [];
  const made: MachineSources = {
    platform: "linux",
    home: NodePath.join(base, "home"),
    baseDir: NodePath.join(base, "app"),
    appFolders: async () => [commands, managed],
    terminal: async (fresh) => {
      asked.push(fresh);
      return shell();
    },
    serverEnv: {},
    spawn,
    ...over,
  };
  return { made, asked };
};

describe("probeMachine", () => {
  it("looks where Terminal looks first, then the system's folders, then the app's own", async () => {
    const { made, asked } = sources();
    const machine = await probeMachine(made, [project], project, false);
    expect(machine.terminalFolders).toEqual(["/opt/homebrew/bin", "/usr/bin"]);
    expect(machine.appFolders).toEqual([commands, managed]);
    expect(machine.folders.slice(0, 2)).toEqual(["/opt/homebrew/bin", "/usr/bin"]);
    expect(machine.folders.slice(-2)).toEqual([commands, managed]);
    expect(machine.projectRoots).toEqual([project]);
    expect(machine.projectRoot).toBe(project);
    expect(asked).toEqual([false]);
    // A check the person asked for asks the shell again.
    await probeMachine(made, [project], null, true);
    expect(asked).toEqual([false, true]);
  });

  it("has no copy of the project when the caller named none this machine has", async () => {
    const machine = await probeMachine(sources().made, [project], null, false);
    expect(machine.projectRoot).toBeNull();
  });

  it("falls back to the server's own PATH without the app's folders, and its listed variables", async () => {
    const { made } = sources({
      terminal: async () => null,
      serverEnv: {
        PATH: `/usr/local/bin:${commands}:${managed}:relative/bin`,
        GH_TOKEN: "from-the-login-shell-at-start",
        HTTPS_PROXY: "http://proxy:8080",
        KUBECONFIG: "/somewhere/else.yaml",
      },
    });
    const machine = await probeMachine(made, [project], null, false);
    // The app added its own folders to its PATH at start: a new Terminal window may not have them.
    expect(machine.terminalFolders).toEqual(["/usr/local/bin"]);
    expect(machine.variables).toEqual({
      GH_TOKEN: "from-the-login-shell-at-start",
      HTTPS_PROXY: "http://proxy:8080",
    });
  });

  it("takes the Terminal's variables over the server's, and only listed ones", async () => {
    const { made } = sources({
      terminal: async () =>
        shell({ variables: { SSH_AUTH_SOCK: "/tmp/terminal.sock", KUBECONFIG: "/evil.yaml" } }),
      serverEnv: { SSH_AUTH_SOCK: "/tmp/server.sock", GH_TOKEN: "server-only" },
    });
    const machine = await probeMachine(made, [project], null, false);
    expect(machine.variables).toEqual({ SSH_AUTH_SOCK: "/tmp/terminal.sock" });
  });

  it("leaves out every folder inside a registered project, links followed", async () => {
    const own = NodePath.join(project, "node_modules", ".bin");
    await NodeFSP.mkdir(own, { recursive: true });
    const linked = NodePath.join(base, "linked");
    await NodeFSP.symlink(own, linked);
    const { made } = sources({
      terminal: async () => shell({ path: `${own}:${linked}:/usr/bin` }),
      appFolders: async () => [commands, NodePath.join(project, "tools")],
    });
    const machine = await probeMachine(made, [project], project, false);
    // A tool run by full path still finds `node` through PATH: a project's folder is never on it.
    expect(machine.terminalFolders).toEqual(["/usr/bin"]);
    expect(machine.appFolders).toEqual([commands]);
    for (const folder of machine.folders) expect(folder.startsWith(project)).toBe(false);
    expect(machine.folders).not.toContain(linked);
  });

  it("refuses a config folder inside a project, and keeps the person's own", async () => {
    const inside = NodePath.join(project, ".config");
    const linked = NodePath.join(base, "config-link");
    await NodeFSP.mkdir(inside);
    await NodeFSP.symlink(inside, linked);
    const xdg = async (xdgConfigHome: string) =>
      (
        await probeMachine(
          sources({ terminal: async () => shell({ xdgConfigHome }) }).made,
          [project],
          null,
          false,
        )
      ).xdgConfigHome;
    expect(await xdg(inside)).toBeNull();
    expect(await xdg(linked)).toBeNull();
    expect(await xdg("relative/config")).toBeNull();
    const own = NodePath.join(base, "home", ".xdg");
    expect(await xdg(own)).toBe(own);
  });

  it("still answers when the app's folders or the shell cannot be read", async () => {
    const { made } = sources({
      appFolders: () => Promise.reject(new Error("unreadable")),
      terminal: () => Promise.reject(new Error("no shell")),
      serverEnv: { PATH: "/usr/bin" },
    });
    const machine = await probeMachine(made, [], null, false);
    expect(machine.appFolders).toEqual([]);
    expect(machine.terminalFolders).toEqual(["/usr/bin"]);
  });

  it("looks for nothing on Windows", async () => {
    const machine = await probeMachine(
      sources({ platform: "win32", terminal: async () => null }).made,
      [],
      null,
      false,
    );
    expect(machine.folders).toEqual([]);
    expect(machine.knownHosts).toBeNull();
  });
});

describe("knownHostsFile", () => {
  it("writes the pinned keys once, and puts them right when the file was changed", async () => {
    const app = NodePath.join(base, "app");
    const file = await knownHostsFile(app);
    expect(file).toBe(NodePath.join(app, "caches", "known-git-hosts"));
    expect(await NodeFSP.readFile(file!, "utf8")).toBe(knownGitHosts());
    const before = (await NodeFSP.stat(file!)).mtimeMs;
    expect(await knownHostsFile(app)).toBe(file);
    expect((await NodeFSP.stat(file!)).mtimeMs).toBe(before);
    await NodeFSP.writeFile(file!, "github.com ssh-ed25519 someone-elses-key\n");
    await knownHostsFile(app);
    expect(await NodeFSP.readFile(file!, "utf8")).toBe(knownGitHosts());
    expect((await NodeFSP.readdir(NodePath.dirname(file!))).sort()).toEqual(["known-git-hosts"]);
  });

  it("survives being asked many times at once, and leaves no draft behind", async () => {
    const app = NodePath.join(base, "busy");
    const files = await Promise.all(Array.from({ length: 12 }, () => knownHostsFile(app)));
    const file = NodePath.join(app, "caches", "known-git-hosts");
    expect(new Set(files)).toEqual(new Set([file]));
    expect(await NodeFSP.readFile(file, "utf8")).toBe(knownGitHosts());
    expect(await NodeFSP.readdir(NodePath.dirname(file))).toEqual(["known-git-hosts"]);
  });

  it("gives nothing where it cannot write, so no host is contacted unpinned", async () => {
    const blocked = NodePath.join(base, "blocked");
    await NodeFSP.writeFile(blocked, "a file, not a folder");
    expect(await knownHostsFile(blocked)).toBeNull();
  });
});
