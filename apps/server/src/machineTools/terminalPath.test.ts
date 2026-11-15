// @effect-diagnostics nodeBuiltinImport:off - Real temp homes: atomic writes, bytes, FIFOs.
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
  syncTerminalPath,
  TERMINAL_PATH_END,
  TERMINAL_PATH_START,
  terminalPathBlock,
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

const sync = (options: { baseDir?: string; shell?: string; fs?: TerminalPathFs } = {}) =>
  syncTerminalPath({
    home,
    baseDir: options.baseDir ?? NodePath.join(home, ".specwithcode"),
    platform: "darwin",
    arch: "arm64",
    glibc: false,
    shell: options.shell ?? "/bin/zsh",
    fs: options.fs ?? nodeTerminalPathFs,
  });

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
  it("lists the folders holding claude, Node.js, SpecWeave and Codex, then settles", async () => {
    const base = NodePath.join(home, ".specwithcode");
    const { node, specweave } = pinned(base);
    touch(NodePath.join(home, ".local/bin/claude"));
    touch(NodePath.join(node, "node"));
    touch(NodePath.join(specweave, "specweave"));
    touch(NodePath.join(base, "tools/codex/active.json"), '{"version":"0.200.0"}');
    touch(NodePath.join(base, "tools/codex/0.200.0/bin/codex"));
    touch(NodePath.join(home, ".local/share/specweave/providers/bin/README"));

    expect(await sync()).toBe("added");
    const rel = (dir: string) => `"$HOME/${NodePath.relative(home, dir)}"`;
    const codex = NodePath.join(base, "tools/codex/0.200.0/bin");
    const listed = [node, specweave, codex].toSorted().map(rel).join(" ");
    expect(read()).toContain(`for _swc_dir in "$HOME/.local/bin" ${listed}; do`);
    expect(read()).not.toContain("providers/bin");
    expect(JSON.parse(read(terminalPathStateFile(home)))).toEqual({ files: [zprofile()] });
    expect(await sync()).toBe("unchanged");
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
    expect(dirs).toContain(pinned(a).specweave);
    expect(dirs).toContain(pinned(b).node);
    // A home drops its own folder once it no longer holds a command; the other's stays.
    NodeFS.rmSync(NodePath.join(pinned(a).specweave, "specweave"));
    expect(await sync({ baseDir: a })).toBe("updated");
    expect(terminalPathBlockDirs(read(), home)).toEqual([pinned(b).node]);
  });

  it("never brings back a deleted block, even when its record is corrupt", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    await sync();
    NodeFS.writeFileSync(zprofile(), "# mine\n");
    expect(await sync()).toBe("opted-out");
    NodeFS.writeFileSync(terminalPathStateFile(home), '{"fil');
    expect(await sync()).toBe("opted-out");
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

  it("skips unknown shells and writes nothing when nothing is installed", async () => {
    touch(NodePath.join(home, ".local/bin/claude"));
    expect(await sync({ shell: "/usr/local/bin/fish" })).toBe("unsupported");
    NodeFS.rmSync(NodePath.join(home, ".local"), { recursive: true });
    expect(await sync()).toBe("unchanged");
    expect(NodeFS.existsSync(zprofile())).toBe(false);
  });
});
