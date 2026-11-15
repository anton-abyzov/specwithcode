// @effect-diagnostics nodeBuiltinImport:off - plain async file I/O; Effect wraps it at startup.
/**
 * Terminal commands for the tools the app installs.
 *
 * The server finds `claude`, `codex`, `specweave`, Node.js and gh in folders a
 * new Terminal does not search: `~/.local/bin` (the official Claude installer
 * and the app's own CLI), `~/.local/share/specweave/providers/bin`, and the
 * app's tools folder. So threads work while `claude` in Terminal says "command
 * not found". This keeps one marked block in the login shell's startup file
 * that appends those folders to PATH. Appending keeps the person's own
 * installs first. A block the person deletes is never added back.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { managedToolDirs } from "./machineTools.ts";

export const TERMINAL_PATH_START = "# >>> SpecWithCode commands >>>";
export const TERMINAL_PATH_END = "# <<< SpecWithCode commands <<<";

/** A folder joins the block only when it holds one of these. */
const COMMANDS = [
  "claude",
  "codex",
  "specweave",
  "node",
  "npm",
  "gh",
  "specwithcode",
  "specweave-studio",
] as const;

export interface TerminalPathFs {
  /** The file's text, or null when it does not exist. */
  readonly readText: (file: string) => Promise<string | null>;
  readonly writeText: (file: string, text: string) => Promise<void>;
  readonly isSymlink: (file: string) => Promise<boolean>;
  readonly isFile: (file: string) => Promise<boolean>;
}

export interface TerminalPathInput {
  readonly home: string;
  /** The app's home (`config.baseDir`), where it installs Node.js, gh, SpecWeave and Codex. */
  readonly baseDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly glibc: boolean;
  /** The person's login shell, such as `/bin/zsh`. */
  readonly shell: string | undefined;
  readonly fs: TerminalPathFs;
}

export type TerminalPathAction =
  | "added"
  | "updated"
  | "removed"
  | "unchanged"
  | "opted-out"
  | "unsupported";

/** The startup file a new Terminal reads for this shell, or null where none is known. */
export function terminalStartupFile(
  home: string,
  platform: string,
  shell: string | undefined,
): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  const name = NodePath.posix.basename(shell ?? "");
  // macOS terminals open login shells; Linux ones open interactive shells.
  if (name === "zsh")
    return NodePath.posix.join(home, platform === "darwin" ? ".zprofile" : ".zshrc");
  if (name === "bash")
    return NodePath.posix.join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return null;
}

const VERSION = /^[\w.+-]+$/u;

async function activeCodexDir(baseDir: string, fs: TerminalPathFs): Promise<string | null> {
  const root = NodePath.posix.join(baseDir, "tools", "codex");
  const text = await fs.readText(NodePath.posix.join(root, "active.json"));
  if (text === null) return null;
  try {
    const version: unknown = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" && VERSION.test(version)
      ? NodePath.posix.join(root, version, "bin")
      : null;
  } catch {
    return null;
  }
}

/** The folders, in order, that hold a command the app installed or found. */
export async function terminalCommandDirs(
  input: Omit<TerminalPathInput, "shell">,
): Promise<ReadonlyArray<string>> {
  const { home, baseDir, platform, arch, glibc, fs } = input;
  const codex = await activeCodexDir(baseDir, fs);
  const candidates = [
    NodePath.posix.join(home, ".local", "bin"),
    NodePath.posix.join(home, ".local", "share", "specweave", "providers", "bin"),
    ...managedToolDirs({ home: baseDir, platform, arch, glibc }),
    ...(codex ? [codex] : []),
  ];
  const dirs: Array<string> = [];
  for (const dir of new Set(candidates)) {
    for (const command of COMMANDS) {
      if (await fs.isFile(NodePath.posix.join(dir, command))) {
        dirs.push(dir);
        break;
      }
    }
  }
  return dirs;
}

/** A folder as a double-quoted shell word, with the home folder spelled `$HOME`. */
function shellWord(dir: string, home: string): string {
  const escape = (text: string) => text.replace(/[\\"$`]/gu, (c) => `\\${c}`);
  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  return dir.startsWith(homePrefix)
    ? `"$HOME/${escape(dir.slice(homePrefix.length))}"`
    : `"${escape(dir)}"`;
}

/** The block for these folders, or null when there is nothing to add. */
export function terminalPathBlock(dirs: ReadonlyArray<string>, home: string): string | null {
  if (dirs.length === 0) return null;
  return [
    TERMINAL_PATH_START,
    "# Lets Terminal run the tools SpecWithCode installed. Your own installs stay first.",
    "# Delete this block to stop; SpecWithCode will not add it back.",
    `for _swc_dir in ${dirs.map((dir) => shellWord(dir, home)).join(" ")}; do`,
    '  case ":$PATH:" in *":$_swc_dir:"*) ;; *) PATH="$PATH:$_swc_dir" ;; esac',
    "done",
    "unset _swc_dir",
    "export PATH",
    TERMINAL_PATH_END,
    "",
  ].join("\n");
}

/**
 * The startup file's new text. A present block is replaced or removed. A missing one is added
 * only if the app never wrote one there: a person who deleted it opted out.
 */
export function applyTerminalPathBlock(
  existing: string | null,
  block: string | null,
  writtenBefore: boolean,
): { readonly text: string | null; readonly action: TerminalPathAction } {
  const text = existing ?? "";
  const start = text.indexOf(TERMINAL_PATH_START);
  const end = start === -1 ? -1 : text.indexOf(TERMINAL_PATH_END, start);
  if (start !== -1 && end === -1) return { text: null, action: "unchanged" };
  if (start !== -1) {
    let after = end + TERMINAL_PATH_END.length;
    if (text[after] === "\n") after += 1;
    const next = `${text.slice(0, start)}${block ?? ""}${text.slice(after)}`;
    if (next === text) return { text: null, action: "unchanged" };
    return { text: next, action: block === null ? "removed" : "updated" };
  }
  if (writtenBefore) return { text: null, action: "opted-out" };
  if (block === null) return { text: null, action: "unchanged" };
  if (text.length === 0) return { text: block, action: "added" };
  const gap = text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${gap}${block}`, action: "added" };
}

interface TerminalPathState {
  readonly file: string;
}

/** Bring the startup file's block in line with what is installed now. */
export async function syncTerminalPath(input: TerminalPathInput): Promise<TerminalPathAction> {
  const file = terminalStartupFile(input.home, input.platform, input.shell);
  if (file === null) return "unsupported";
  // A linked startup file belongs to someone's dotfiles; never edit through it.
  if (await input.fs.isSymlink(file)) return "unsupported";
  const statePath = NodePath.posix.join(input.baseDir, "terminal-path.json");
  let writtenBefore = false;
  const stateText = await input.fs.readText(statePath);
  if (stateText !== null) {
    try {
      writtenBefore = (JSON.parse(stateText) as Partial<TerminalPathState>).file === file;
    } catch {
      writtenBefore = false;
    }
  }
  const block = terminalPathBlock(await terminalCommandDirs(input), input.home);
  const { text, action } = applyTerminalPathBlock(
    await input.fs.readText(file),
    block,
    writtenBefore,
  );
  if (text === null) return action;
  // Record first: if the write lands and the record did not, a deleted block would come back.
  if (!writtenBefore)
    await input.fs.writeText(
      statePath,
      `${JSON.stringify({ file } satisfies TerminalPathState)}\n`,
    );
  await input.fs.writeText(file, text);
  return action;
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ||
  (error as NodeJS.ErrnoException | null)?.code === "ENOTDIR";

/** The real file system. */
export const nodeTerminalPathFs: TerminalPathFs = {
  readText: async (file) => {
    try {
      return await NodeFSP.readFile(file, "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  writeText: async (file, text) => {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, text, "utf8");
  },
  isSymlink: async (file) => {
    try {
      return (await NodeFSP.lstat(file)).isSymbolicLink();
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  },
  isFile: async (file) => {
    try {
      return (await NodeFSP.stat(file)).isFile();
    } catch {
      return false;
    }
  },
};
