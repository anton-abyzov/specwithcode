// @effect-diagnostics nodeBuiltinImport:off - Real temp homes: atomic writes, bytes, FIFOs.
// @effect-diagnostics globalDate:off - backdating a temp file.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { managedToolDirs } from "./machineTools.ts";
import {
  applyTerminalPathBlock,
  findTerminalPathBlocks,
  nodeTerminalPathFs,
  removeTerminalPathBlocks,
  syncTerminalCommandLinks,
  syncTerminalPath,
  TERMINAL_PATH_END,
  TERMINAL_PATH_START,
  terminalPathBlock,
  terminalCommandsDir,
  terminalPathBlockDirs,
  terminalPathStateFile,
  terminalStartupFile,
  type TerminalPathFs,
} from "./terminalPath.ts";

// oxlint-disable-next-line studio/no-global-process-runtime -- mkfifo exists only on POSIX hosts.
const posixOnly = process.platform === "win32" ? it.skip : it;

let home = "";
beforeEach(() => {
  home = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-term-")));
});
afterEach(() => NodeFS.rmSync(home, { recursive: true, force: true }));

const touch = (file: string, text = "") => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
};
const zprofile = () => NodePath.join(home, ".zprofile");
const read = (file = zprofile()) => NodeFS.readFileSync(file, "utf8");

/** One runtime pass: link the versioned tools, then bring the block in line. */
const sync = async (
  options: {
    baseDir?: string;
    shell?: string;
    fs?: TerminalPathFs;
    enabled?: boolean;
    rearm?: boolean;
  } = {},
) => {
  const input = {
    home,
    baseDir: options.baseDir ?? NodePath.join(home, ".specwithcode"),
    platform: "darwin",
    arch: "arm64",
    glibc: false,
    fs: options.fs ?? nodeTerminalPathFs,
  } as const;
  const enabled = options.enabled ?? true;
  if (enabled) await syncTerminalCommandLinks(input);
  return syncTerminalPath({
    ...input,
    shell: options.shell ?? "/bin/zsh",
    enabled,
    rearm: options.rearm ?? false,
  });
};
const commands = (baseDir = NodePath.join(home, ".specwithcode")) => terminalCommandsDir(baseDir);

const pinned = (baseDir: string) => {
  const [node, gh, specweave] = managedToolDirs({
    home: baseDir,
    platform: "darwin",
    arch: "arm64",
    glibc: false,
  });
  return { node: node!, gh: gh!, specweave: specweave! };
};

describe("terminalStartupFile", () => {
  it("picks the file a new Terminal reads", () => {
    expect(terminalStartupFile("/h", "darwin", "/bin/zsh")).toBe("/h/.zprofile");
    expect(terminalStartupFile("/h", "linux", "/usr/bin/zsh")).toBe("/h/.zshrc");
    expect(terminalStartupFile("/h", "darwin", "/bin/bash")).toBe("/h/.bash_profile");
    expect(terminalStartupFile("/h", "linux", "/bin/bash")).toBe("/h/.bashrc");
    expect(terminalStartupFile("/h", "darwin", "/opt/homebrew/bin/fish")).toBeNull();
    expect(terminalStartupFile("/h", "win32", "/bin/zsh")).toBeNull();
  });
});

describe("the block", () => {
  it("quotes each folder, spells home $HOME, and reads its own folders back", () => {
    const dirs = ["/h/.local/bin", '/opt/odd "$dir`\\x', "/h/café"];
    const block = terminalPathBlock(dirs, "/h")!;
    expect(block.startsWith(`${TERMINAL_PATH_START}\n`)).toBe(true);
    expect(block.endsWith(`${TERMINAL_PATH_END}\n`)).toBe(true);
    expect(block).toContain('for _swc_dir in "$HOME/.local/bin" "/opt/odd \\"\\$dir\\`\\\\x"');
    expect(terminalPathBlockDirs(block, "/h")).toEqual(dirs);
    expect(terminalPathBlock(["/a\nb"], "/h")).toBeNull();
  });

  it("matches markers only as whole lines and refuses ones that do not pair up", () => {
    const quoted = `echo "${TERMINAL_PATH_START}"\nexport FOO=1\necho "${TERMINAL_PATH_END}"\n`;
    expect(findTerminalPathBlocks(quoted)).toEqual([]);
    expect(findTerminalPathBlocks(`${TERMINAL_PATH_START}\nx\n`)).toBeNull();
    expect(findTerminalPathBlocks(`${TERMINAL_PATH_END}\n${TERMINAL_PATH_START}\n`)).toBeNull();
    expect(
      findTerminalPathBlocks(`${TERMINAL_PATH_START}\r\nx\r\n${TERMINAL_PATH_END}\r\n`),
    ).toEqual([{ from: 0, to: TERMINAL_PATH_START.length + 2 + 3 + TERMINAL_PATH_END.length + 2 }]);
  });

  it("collapses duplicate blocks into one, and never re-adds a deleted one", () => {
    const a = terminalPathBlock(["/a"], "/h")!;
    const b = terminalPathBlock(["/b"], "/h")!;
    expect(applyTerminalPathBlock(`x\n${a}y\n${a}z\n`, b, true)).toEqual({
      text: `x\n${b}y\nz\n`,
      action: "updated",
    });
    expect(applyTerminalPathBlock(`x\n${a}y\n${a}`, null, true).text).toBe("x\ny\n");
    expect(applyTerminalPathBlock("mine\n", a, true)).toEqual({ text: null, action: "opted-out" });
    expect(applyTerminalPathBlock("mine", a, false).text).toBe(`mine\n\n${a}`);
  });
});

describe("syncTerminalPath", () => {
  it("lists claude's folder and one stable commands folder for Node.js, SpecWeave and Codex", async () => {
    const base = NodePath.join(home, ".specwithcode");
    const { node, specweave } = pinned(base);
    touch(NodePath.join(home, ".local/bin/claude"));
    touch(NodePath.join(node, "node"));
    touch(NodePath.join(specweave, "specweave"));
    touch(NodePath.join(base, "tools/codex/active.json"), '{"version":"0.200.0"}');
    touch(NodePath.join(base, "tools/codex/0.200.0/bin/codex"));
    touch(NodePath.join(home, ".local/share/specweave/providers/bin/README"));

    expect(await sync()).toBe("added");
    expect(read()).toContain(
      'for _swc_dir in "$HOME/.local/bin" "$HOME/.specwithcode/commands"; do',
    );
    expect(read()).not.toContain("providers/bin");
    expect(read()).toContain("Settings > General > Use these commands in Terminal");
    expect(NodeFS.readlinkSync(NodePath.join(commands(), "node"))).toBe(
      NodePath.join(node, "node"),
    );
    expect(NodeFS.readdirSync(commands()).toSorted()).toEqual(["codex", "node", "specweave"]);
    expect(JSON.parse(read(terminalPathStateFile(home)))).toEqual({ files: [zprofile()] });
    expect(await sync()).toBe("unchanged");

    // Codex updates: the link follows, and the startup file stays as it is.
    const before = read();
    touch(NodePath.join(base, "tools/codex/active.json"), '{"version":"0.201.0"}');
    touch(NodePath.join(base, "tools/codex/0.201.0/bin/codex"));
    expect(await sync()).toBe("unchanged");
    expect(read()).toBe(before);
    expect(NodeFS.readlinkSync(NodePath.join(commands(), "codex"))).toBe(
      NodePath.join(base, "tools/codex/0.201.0/bin/codex"),
    );
  });

  it("drops links to tools that are gone and never touches the person's own files or links", async () => {
    const { node, specweave } = pinned(NodePath.join(home, ".specwithcode"));
    touch(NodePath.join(specweave, "specweave"));
    touch(NodePath.join(specweave, "helper"));
    touch(NodePath.join(node, "node"));
    touch(NodePath.join(commands(), "mine"), "# mine\n");
    NodeFS.symlinkSync("/opt/elsewhere/mytool", NodePath.join(commands(), "mytool"));
    NodeFS.symlinkSync("/opt/elsewhere/node", NodePath.join(commands(), "node"));
    await sync();
    // Only the known commands are linked, and the person's node link stays theirs.
    expect(NodeFS.readdirSync(commands()).toSorted()).toEqual(["mine", "mytool", "node", "specweave"]);
    expect(NodeFS.readlinkSync(NodePath.join(commands(), "node"))).toBe("/opt/elsewhere/node");
    NodeFS.rmSync(NodePath.join(specweave, "specweave"));
    await sync();
    expect(NodeFS.readdirSync(commands()).toSorted()).toEqual(["mine", "mytool", "node"]);
    expect(NodeFS.existsSync(zprofile()) ? read() : "").not.toContain(TERMINAL_PATH_START);
  });

  it("moves a block that names versioned folders onto the commands folder", async () => {
    const { specweave } = pinned(NodePath.join(home, ".specwithcode"));
    touch(NodePath.join(specweave, "specweave"));
    touch(zprofile(), `# mine\n${terminalPathBlock([specweave], home)!}`);
    touch(terminalPathStateFile(home), JSON.stringify({ files: [zprofile()] }));
    expect(await sync()).toBe("updated");
    expect(terminalPathBlockDirs(read(), home)).toEqual([commands()]);
    expect(read().startsWith("# mine\n")).toBe(true);
  });

  it("switched off, removes the block; switched on, adds it back", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    touch(zprofile(), "# mine\n");
    expect(await sync()).toBe("added");
    expect(await sync({ enabled: false })).toBe("removed");
    expect(read()).toBe("# mine\n");
    expect(JSON.parse(read(terminalPathStateFile(home)))).toEqual({ files: [] });
    expect(await sync({ enabled: false })).toBe("unchanged");
    expect(await sync()).toBe("added");
    expect(read()).toContain(TERMINAL_PATH_START);
  });

  it("switched off, keeps another app home's folder", async () => {
    const other = NodePath.join(home, ".specweave-studio");
    touch(NodePath.join(pinned(other).node, "node"));
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync({ baseDir: other });
    expect(await sync({ enabled: false })).toBe("updated");
    expect(terminalPathBlockDirs(read(), home)).toEqual([commands(other)]);
  });

  it("keeps the person's bytes and file mode exactly", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    const mine = Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]);
    NodeFS.writeFileSync(zprofile(), mine, { mode: 0o600 });
    NodeFS.chmodSync(zprofile(), 0o600);
    expect(await sync()).toBe("added");
    const bytes = NodeFS.readFileSync(zprofile());
    expect(bytes.subarray(0, mine.length).equals(mine)).toBe(true);
    expect(NodeFS.statSync(zprofile()).mode & 0o777).toBe(0o600);
    expect(NodeFS.readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("two app homes on one account settle on one merged block", async () => {
    const a = NodePath.join(home, ".specwithcode");
    const b = NodePath.join(home, ".specweave-studio");
    touch(NodePath.join(pinned(a).specweave, "specweave"));
    touch(NodePath.join(pinned(b).node, "node"));
    expect(await sync({ baseDir: a })).toBe("added");
    expect(await sync({ baseDir: b })).toBe("updated");
    expect(await sync({ baseDir: a })).toBe("unchanged");
    expect(await sync({ baseDir: b })).toBe("unchanged");
    const dirs = terminalPathBlockDirs(read(), home);
    expect(dirs).toEqual([commands(b), commands(a)]);
    // A home drops its own folder once it no longer holds a command; the other's stays.
    NodeFS.rmSync(NodePath.join(pinned(a).specweave, "specweave"));
    expect(await sync({ baseDir: a })).toBe("updated");
    expect(terminalPathBlockDirs(read(), home)).toEqual([commands(b)]);
  });

  it("keeps a deleted block deleted until the switch is turned back on", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync();
    NodeFS.writeFileSync(zprofile(), "# mine\n");
    expect(await sync()).toBe("opted-out");
    // Every pass sees it, so a lost settings write is retried rather than undone.
    expect(await sync()).toBe("opted-out");
    expect(await sync({ enabled: false })).toBe("opted-out");
    expect(read()).toBe("# mine\n");
    // Turned back on by the person, the block returns.
    expect(await sync({ rearm: true })).toBe("added");
    expect(await sync()).toBe("unchanged");

    NodeFS.writeFileSync(zprofile(), "# mine\n");
    NodeFS.writeFileSync(terminalPathStateFile(home), '{"fil');
    expect(await sync()).toBe("opted-out");
    expect(read()).toBe("# mine\n");
  });

  it("a block deleted while two app homes run is an opt-out for both", async () => {
    const other = NodePath.join(home, ".specweave-studio");
    touch(NodePath.join(pinned(other).node, "node"));
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync();
    await sync({ baseDir: other });
    NodeFS.writeFileSync(zprofile(), "# mine\n");
    expect(await sync()).toBe("opted-out");
    expect(await sync({ baseDir: other })).toBe("opted-out");
    expect(read()).toBe("# mine\n");
  });

  it("retries after a failed write instead of recording an opt-out", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    let fail = true;
    const flaky: TerminalPathFs = {
      ...nodeTerminalPathFs,
      replace: async (...args) => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return nodeTerminalPathFs.replace(...args);
      },
    };
    await expect(sync({ fs: flaky })).rejects.toThrow("EACCES");
    expect(NodeFS.existsSync(terminalPathStateFile(home))).toBe(false);
    expect(await sync({ fs: flaky })).toBe("added");
  });

  it("keeps an edit saved while it was working", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    NodeFS.writeFileSync(zprofile(), "# before\n");
    const racing: TerminalPathFs = {
      ...nodeTerminalPathFs,
      replace: async (file, ...rest) => {
        if (file === zprofile()) NodeFS.writeFileSync(file, "# saved meanwhile, longer\n");
        return nodeTerminalPathFs.replace(file, ...rest);
      },
    };
    expect(await sync({ fs: racing })).toBe("busy");
    expect(read()).toBe("# saved meanwhile, longer\n");
    expect(await sync()).toBe("added");
  });

  it("leaves half-deleted markers, links, folders and FIFOs alone", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    NodeFS.writeFileSync(zprofile(), `${TERMINAL_PATH_START}\nmine\n`);
    expect(await sync()).toBe("malformed");
    expect(read()).toBe(`${TERMINAL_PATH_START}\nmine\n`);

    NodeFS.rmSync(zprofile());
    touch(NodePath.join(home, "dotfiles/zprofile"), "# stow\n");
    NodeFS.symlinkSync(NodePath.join(home, "dotfiles/zprofile"), zprofile());
    expect(await sync()).toBe("unsupported");
    expect(read()).toBe("# stow\n");

    NodeFS.rmSync(zprofile());
    NodeFS.mkdirSync(zprofile());
    expect(await sync()).toBe("unsupported");
  });

  posixOnly("does not block on a FIFO", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    NodeChildProcess.execFileSync("mkfifo", [zprofile()]);
    expect(await sync()).toBe("unsupported");
  });

  it("moves the block when the login shell changes", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    NodeFS.writeFileSync(zprofile(), "# zsh\n");
    await sync();
    expect(await sync({ shell: "/bin/bash" })).toBe("added");
    expect(read()).toBe("# zsh\n");
    expect(read(NodePath.join(home, ".bash_profile"))).toContain(TERMINAL_PATH_START);
    expect(JSON.parse(read(terminalPathStateFile(home)))).toEqual({
      files: [NodePath.join(home, ".bash_profile")],
    });
  });

  it("switched off after a deleted block, a shell switch adds nothing", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync();
    NodeFS.writeFileSync(zprofile(), "# mine\n");
    expect(await sync()).toBe("opted-out");
    expect(await sync({ shell: "/bin/bash", enabled: false })).toBe("unchanged");
    expect(NodeFS.existsSync(NodePath.join(home, ".bash_profile"))).toBe(false);
    expect(await sync({ enabled: false })).toBe("unchanged");
    expect(read()).toBe("# mine\n");
  });

  it("does not mistake its own removal for an opt-out when the new shell's file is refused", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync();
    const bashProfile = NodePath.join(home, ".bash_profile");
    touch(bashProfile, `${TERMINAL_PATH_START}\nmine\n`);
    expect(await sync({ shell: "/bin/bash" })).toBe("malformed");
    expect(read()).not.toContain(TERMINAL_PATH_START);
    expect(await sync()).toBe("added");
  });

  it("leaves the old shell's block when its record update loses a race", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync();
    const block = read();
    let lose = true;
    const racing: TerminalPathFs = {
      ...nodeTerminalPathFs,
      replace: async (file, ...rest) => {
        if (file === terminalPathStateFile(home) && lose) {
          lose = false;
          return false;
        }
        return nodeTerminalPathFs.replace(file, ...rest);
      },
    };
    touch(NodePath.join(home, ".bash_profile"), `${TERMINAL_PATH_START}\nmine\n`);
    expect(await sync({ shell: "/bin/bash", fs: racing })).toBe("busy");
    expect(read()).toBe(block);
    expect(await sync({ shell: "/bin/bash" })).toBe("malformed");
    expect(read()).not.toContain(TERMINAL_PATH_START);
    expect(await sync()).toBe("added");
  });

  it("keeps folders a second, duplicate block listed", async () => {
    const other = pinned(NodePath.join(home, ".specweave-studio")).specweave;
    touch(NodePath.join(other, "specweave"));
    touch(NodePath.join(home, ".local/bin/claude"));
    const first = terminalPathBlock([NodePath.join(home, ".local/bin")], home)!;
    NodeFS.writeFileSync(zprofile(), `${first}# mine\n${terminalPathBlock([other], home)!}`);
    expect(await sync()).toBe("updated");
    expect(terminalPathBlockDirs(read(), home)).toEqual([NodePath.join(home, ".local/bin"), other]);
    expect(findTerminalPathBlocks(read())).toHaveLength(1);
  });

  it("keeps the person's blank line when a block in the middle goes", () => {
    const block = terminalPathBlock(["/a"], "/h")!;
    expect(applyTerminalPathBlock(`para\n\n${block}after\n`, null, true).text).toBe(
      "para\n\nafter\n",
    );
    expect(applyTerminalPathBlock(`para\n\n${block}`, null, true).text).toBe("para\n");
  });

  it("never edits a file the record names that is not a startup file", async () => {
    const notes = NodePath.join(home, "notes.txt");
    const text = `${terminalPathBlock(["/a"], home)!}keep\n`;
    touch(notes, text);
    touch(terminalPathStateFile(home), JSON.stringify({ files: [notes] }));
    touch(NodePath.join(home, ".local/bin/claude"));
    expect(await sync()).toBe("added");
    expect(read(notes)).toBe(text);
  });

  it("sweeps temp files a crash left, not ones another writer is using", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    const old = NodePath.join(home, "..zprofile.swc-old.tmp");
    const fresh = NodePath.join(home, "..zprofile.swc-fresh.tmp");
    touch(old);
    touch(fresh);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    NodeFS.utimesSync(old, hourAgo, hourAgo);
    expect(await sync()).toBe("added");
    expect(NodeFS.existsSync(old)).toBe(false);
    expect(NodeFS.existsSync(fresh)).toBe(true);
  });

  it("skips unknown shells and writes nothing when nothing is installed", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    expect(await sync({ shell: "/usr/local/bin/fish" })).toBe("unsupported");
    NodeFS.rmSync(NodePath.join(home, ".local"), { recursive: true });
    expect(await sync()).toBe("unchanged");
    expect(NodeFS.existsSync(zprofile())).toBe(false);
  });
});

describe("removeTerminalPathBlocks", () => {
  it("takes the block out of every startup file and clears the record", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    touch(zprofile(), "# zsh\n");
    await sync();
    const bashrc = NodePath.join(home, ".bashrc");
    touch(bashrc, `# bash\n${terminalPathBlock(["/a"], home)!}`);
    touch(NodePath.join(home, ".zshrc"), "# untouched\n");
    expect(await removeTerminalPathBlocks(home, nodeTerminalPathFs)).toEqual([]);
    expect(read()).toBe("# zsh\n");
    expect(read(bashrc)).toBe("# bash\n");
    expect(read(NodePath.join(home, ".zshrc"))).toBe("# untouched\n");
    expect(JSON.parse(read(terminalPathStateFile(home)))).toEqual({ files: [] });
  });

  it("names a file it could not change, or whose markers do not pair up", async () => {
    touch(zprofile(), `${TERMINAL_PATH_START}\nx\n${TERMINAL_PATH_END}\n`);
    const refusing: TerminalPathFs = { ...nodeTerminalPathFs, replace: async () => false };
    expect(await removeTerminalPathBlocks(home, refusing)).toEqual([zprofile()]);
    touch(zprofile(), `# mine\n${TERMINAL_PATH_START}\nx\n`);
    expect(await removeTerminalPathBlocks(home, nodeTerminalPathFs)).toEqual([zprofile()]);
    expect(read()).toBe(`# mine\n${TERMINAL_PATH_START}\nx\n`);
  });
});
