import { describe, expect, it } from "vite-plus/test";

import { managedToolDirs } from "./machineTools.ts";
import {
  applyTerminalPathBlock,
  syncTerminalPath,
  TERMINAL_PATH_END,
  TERMINAL_PATH_START,
  terminalPathBlock,
  terminalStartupFile,
  type TerminalPathFs,
} from "./terminalPath.ts";

const HOME = "/Users/anna";
const BASE = "/Users/anna/.specwithcode";

function memoryFs(files: Record<string, string>, links: ReadonlyArray<string> = []) {
  const store = new Map(Object.entries(files));
  const writes: Array<string> = [];
  const fs: TerminalPathFs = {
    readText: async (file) => store.get(file) ?? null,
    writeText: async (file, text) => {
      writes.push(file);
      store.set(file, text);
    },
    isSymlink: async (file) => links.includes(file),
    isFile: async (file) => store.has(file),
  };
  return { fs, store, writes };
}

const input = (fs: TerminalPathFs, shell = "/bin/zsh") => ({
  home: HOME,
  baseDir: BASE,
  platform: "darwin",
  arch: "arm64",
  glibc: false,
  shell,
  fs,
});

describe("terminalStartupFile", () => {
  it("picks the file a new Terminal reads", () => {
    expect(terminalStartupFile(HOME, "darwin", "/bin/zsh")).toBe(`${HOME}/.zprofile`);
    expect(terminalStartupFile(HOME, "linux", "/usr/bin/zsh")).toBe(`${HOME}/.zshrc`);
    expect(terminalStartupFile(HOME, "darwin", "/bin/bash")).toBe(`${HOME}/.bash_profile`);
    expect(terminalStartupFile(HOME, "linux", "/bin/bash")).toBe(`${HOME}/.bashrc`);
    expect(terminalStartupFile(HOME, "darwin", "/opt/homebrew/bin/fish")).toBeNull();
    expect(terminalStartupFile(HOME, "win32", "/bin/zsh")).toBeNull();
  });
});

describe("terminalPathBlock", () => {
  it("appends each folder once, home spelled $HOME, special characters escaped", () => {
    const block = terminalPathBlock([`${HOME}/.local/bin`, '/opt/odd "$dir`'], HOME)!;
    expect(block.startsWith(`${TERMINAL_PATH_START}\n`)).toBe(true);
    expect(block.endsWith(`${TERMINAL_PATH_END}\n`)).toBe(true);
    expect(block).toContain('for _swc_dir in "$HOME/.local/bin" "/opt/odd \\"\\$dir\\`"; do');
    expect(block).toContain('*) PATH="$PATH:$_swc_dir" ;;');
  });

  it("is nothing when no folder holds a command", () => {
    expect(terminalPathBlock([], HOME)).toBeNull();
  });
});

describe("applyTerminalPathBlock", () => {
  const block = terminalPathBlock(["/a"], HOME)!;
  const other = terminalPathBlock(["/b"], HOME)!;

  it("adds to a missing or existing file without touching the person's lines", () => {
    expect(applyTerminalPathBlock(null, block, false)).toEqual({ text: block, action: "added" });
    expect(applyTerminalPathBlock("eval x", block, false).text).toBe(`eval x\n\n${block}`);
    expect(applyTerminalPathBlock("eval x\n", block, false).text).toBe(`eval x\n\n${block}`);
  });

  it("replaces only its own block, and removes it when nothing is left", () => {
    const file = `before\n${block}after\n`;
    expect(applyTerminalPathBlock(file, other, true)).toEqual({
      text: `before\n${other}after\n`,
      action: "updated",
    });
    expect(applyTerminalPathBlock(file, block, true).action).toBe("unchanged");
    expect(applyTerminalPathBlock(file, null, true)).toEqual({
      text: "before\nafter\n",
      action: "removed",
    });
  });

  it("never adds back a block the person deleted", () => {
    expect(applyTerminalPathBlock("mine\n", block, true)).toEqual({
      text: null,
      action: "opted-out",
    });
  });

  it("leaves a half-deleted block alone", () => {
    expect(applyTerminalPathBlock(`${TERMINAL_PATH_START}\nx\n`, block, true).text).toBeNull();
  });
});

describe("syncTerminalPath", () => {
  const [nodeDir, , specweaveDir] = managedToolDirs({
    home: BASE,
    platform: "darwin",
    arch: "arm64",
    glibc: false,
  });

  it("puts the folders holding claude, Node.js, SpecWeave and Codex in ~/.zprofile", async () => {
    const { fs, store } = memoryFs({
      [`${HOME}/.local/bin/claude`]: "",
      [`${nodeDir}/node`]: "",
      [`${specweaveDir}/specweave`]: "",
      [`${BASE}/tools/codex/active.json`]: '{"version":"0.200.0"}',
      [`${BASE}/tools/codex/0.200.0/bin/codex`]: "",
      [`${HOME}/.local/share/specweave/providers/bin/README`]: "",
    });
    expect(await syncTerminalPath(input(fs))).toBe("added");
    const zprofile = store.get(`${HOME}/.zprofile`)!;
    const rel = (dir: string) => `"$HOME/${dir.slice(HOME.length + 1)}"`;
    expect(zprofile).toContain(
      `for _swc_dir in "$HOME/.local/bin" ${rel(nodeDir!)} ${rel(specweaveDir!)} "$HOME/.specwithcode/tools/codex/0.200.0/bin"; do`,
    );
    // A folder without one of the commands stays out.
    expect(zprofile).not.toContain("providers/bin");
    expect(JSON.parse(store.get(`${BASE}/terminal-path.json`)!)).toEqual({
      file: `${HOME}/.zprofile`,
    });
    // Nothing new installed: no write.
    expect(await syncTerminalPath(input(fs))).toBe("unchanged");
  });

  it("respects a deleted block and a linked dotfile", async () => {
    const { fs, store, writes } = memoryFs({ [`${HOME}/.local/bin/claude`]: "" });
    await syncTerminalPath(input(fs));
    store.set(`${HOME}/.zprofile`, "# mine\n");
    expect(await syncTerminalPath(input(fs))).toBe("opted-out");
    expect(store.get(`${HOME}/.zprofile`)).toBe("# mine\n");

    const linked = memoryFs({ [`${HOME}/.local/bin/claude`]: "" }, [`${HOME}/.zprofile`]);
    expect(await syncTerminalPath(input(linked.fs))).toBe("unsupported");
    expect(linked.writes).toEqual([]);
    expect(writes).toHaveLength(2);
  });

  it("skips shells it has no startup file for, and writes nothing when nothing is installed", async () => {
    const fish = memoryFs({ [`${HOME}/.local/bin/claude`]: "" });
    expect(await syncTerminalPath(input(fish.fs, "/usr/local/bin/fish"))).toBe("unsupported");
    const empty = memoryFs({});
    expect(await syncTerminalPath(input(empty.fs))).toBe("unchanged");
    expect(empty.writes).toEqual([]);
  });
});
