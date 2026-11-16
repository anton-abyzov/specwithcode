// @effect-diagnostics nodeBuiltinImport:off - plain async file I/O; Effect wraps it at startup.
// @effect-diagnostics globalDate:off - temp file age against the wall clock.
/**
 * Terminal commands for the tools the app installs.
 *
 * The server finds `claude`, `codex`, `specweave`, Node.js and gh in folders a
 * new Terminal does not search: `~/.local/bin` (the official Claude installer
 * and the app's own CLI), `~/.local/share/specweave/providers/bin`, and the
 * app's versioned tools folders. The versioned tools are linked from one
 * stable folder, `<app home>/commands`, kept current as they update, and one
 * marked block in the login shell's startup file appends those stable folders
 * to PATH, so the file changes only when the switch does. Appending keeps the
 * person's own installs first. The "Use these commands in Terminal" setting
 * (on by default) adds or removes the block; a block the person deletes turns
 * the setting off instead of coming back: the record keeps naming the file, so
 * every app home sees the opt-out, until the person turns the setting back on.
 *
 * The person's file is handled as bytes (latin1 maps each byte to one
 * character), never decoded, and replaced atomically only if nobody changed it
 * since it was read. Every app home on this account shares one block: each
 * writer merges its folders with the ones already listed, in a fixed order,
 * so two servers settle on the same text instead of taking turns.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { existingManagedToolDirs } from "./machineTools.ts";

export const TERMINAL_PATH_START = "# >>> SpecWithCode commands >>>";
export const TERMINAL_PATH_END = "# <<< SpecWithCode commands <<<";
/** A startup file larger than this is someone's own machinery; leave it alone. */
export const TERMINAL_PATH_MAX_BYTES = 1024 * 1024;

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

/** The commands the commands folder links: the block's commands plus npx. */
const LINKED = [...COMMANDS, "npx"] as const;

export interface StartupFileInfo {
  /** `other` is a symlink, folder, FIFO or anything but a regular file. */
  readonly kind: "missing" | "file" | "other";
  readonly size: number;
  readonly mode: number;
  /** Owned by the account the server runs as. */
  readonly owned: boolean;
  /** Changes whenever the file does; null when missing. */
  readonly stamp: string | null;
}

export interface TerminalPathFs {
  /** The file itself, never following a link. */
  readonly inspect: (file: string) => Promise<StartupFileInfo>;
  readonly readBytes: (file: string) => Promise<Buffer>;
  /** Atomically replace `file`, only if its stamp is still `expected`; false when it changed. */
  readonly replace: (
    file: string,
    bytes: Buffer,
    mode: number,
    expected: string | null,
  ) => Promise<boolean>;
  /** A regular file, following links (the Claude installer links `~/.local/bin/claude`). */
  readonly isFile: (file: string) => Promise<boolean>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly listDir: (path: string) => Promise<string[]>;
  /** A symbolic link's target, or null for anything else or nothing. */
  readonly readLink: (path: string) => Promise<string | null>;
  /** Point `path` at `target`, replacing a link already there atomically. */
  readonly setLink: (path: string, target: string) => Promise<void>;
  /** Remove a symbolic link; never a file or a folder. */
  readonly removeLink: (path: string) => Promise<void>;
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
  /** "Use these commands in Terminal": false removes this home's folders from the block. */
  readonly enabled: boolean;
  /**
   * The person just turned the setting on: a block they deleted before is added again. Without
   * it a deleted block stays deleted for every app home.
   */
  readonly rearm?: boolean;
  readonly fs: TerminalPathFs;
}

export type TerminalPathAction =
  | "added"
  | "updated"
  | "removed"
  | "unchanged"
  | "opted-out"
  | "busy"
  | "malformed"
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

/** Shared by every app home on this account, so one block has one history. */
export function terminalPathStateFile(home: string): string {
  return NodePath.posix.join(home, ".local", "share", "specweave", "terminal-path.json");
}

const VERSION = /^[\w.+-]+$/u;

/** One stable folder linking the app's versioned tools, so the startup file never names a version. */
export function terminalCommandsDir(baseDir: string): string {
  return NodePath.posix.join(baseDir, "commands");
}

async function activeCodexDir(baseDir: string, fs: TerminalPathFs): Promise<string | null> {
  const root = NodePath.posix.join(baseDir, "tools", "codex");
  const pointer = NodePath.posix.join(root, "active.json");
  if ((await fs.inspect(pointer)).kind !== "file") return null;
  try {
    const parsed: unknown = JSON.parse((await fs.readBytes(pointer)).toString("utf8"));
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" && VERSION.test(version)
      ? NodePath.posix.join(root, version, "bin")
      : null;
  } catch {
    return null;
  }
}

async function holdsCommand(dir: string, fs: TerminalPathFs): Promise<boolean> {
  for (const command of COMMANDS)
    if (await fs.isFile(NodePath.posix.join(dir, command))) return true;
  return false;
}

/** Folders of this app home's own versioned copies; another home's are never pruned here. */
function ownManagedRoots(baseDir: string): ReadonlyArray<string> {
  return [
    ["runtime", "node"],
    ["tools", "gh"],
    ["tools", "specweave"],
    ["tools", "codex"],
  ].map((parts) => `${NodePath.posix.join(baseDir, ...parts)}/`);
}

/** The stable folders this app home lists in the block: those that hold a command now. */
export async function terminalCommandDirs(
  input: Omit<TerminalPathInput, "shell" | "enabled">,
): Promise<ReadonlyArray<string>> {
  const { home, baseDir, fs } = input;
  const candidates = [
    NodePath.posix.join(home, ".local", "bin"),
    NodePath.posix.join(home, ".local", "share", "specweave", "providers", "bin"),
    terminalCommandsDir(baseDir),
  ];
  const dirs: Array<string> = [];
  for (const dir of candidates) if (await holdsCommand(dir, fs)) dirs.push(dir);
  return dirs;
}

/**
 * Link every command in the app's current versioned tools (Node.js, gh, SpecWeave, Codex) from
 * the commands folder, and drop links to versions that are gone. Only links are touched.
 * True when anything changed.
 */
export async function syncTerminalCommandLinks(
  input: Omit<TerminalPathInput, "shell" | "enabled">,
): Promise<boolean> {
  const { baseDir, fs } = input;
  const codex = await activeCodexDir(baseDir, fs);
  const managed = await existingManagedToolDirs(fs, {
    home: baseDir,
    platform: input.platform,
    arch: input.arch,
    glibc: input.glibc,
  });
  const wanted = new Map<string, string>();
  for (const dir of [...managed, ...(codex ? [codex] : [])])
    for (const name of LINKED) {
      const target = NodePath.posix.join(dir, name);
      if (!wanted.has(name) && (await fs.isFile(target))) wanted.set(name, target);
    }
  const folder = terminalCommandsDir(baseDir);
  const roots = ownManagedRoots(baseDir);
  // Only a link this app made (one into its own versioned tools) is ever replaced or removed.
  const ours = (link: string | null) =>
    link !== null && roots.some((root) => link.startsWith(root));
  let changed = false;
  for (const name of await fs.listDir(folder)) {
    const path = NodePath.posix.join(folder, name);
    const current = await fs.readLink(path);
    if (ours(current) && current !== wanted.get(name)) {
      await fs.removeLink(path);
      changed = true;
    }
  }
  for (const [name, target] of wanted) {
    const path = NodePath.posix.join(folder, name);
    const current = await fs.readLink(path);
    if (current === target) continue;
    // The person's own file or link stays.
    if (!ours(current) && (await fs.inspect(path)).kind !== "missing") continue;
    await fs.setLink(path, target);
    changed = true;
  }
  return changed;
}

/** The person's own folders first, then the rest by name: the same order for every writer. */
function blockOrder(home: string) {
  const first = [
    NodePath.posix.join(home, ".local", "bin"),
    NodePath.posix.join(home, ".local", "share", "specweave", "providers", "bin"),
  ];
  const rank = (dir: string) => (first.includes(dir) ? first.indexOf(dir) : first.length);
  return (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A folder as a double-quoted shell word, with the home folder spelled `$HOME`. */
function shellWord(dir: string, home: string): string {
  const escape = (text: string) => text.replace(/[\\"$`]/gu, (c) => `\\${c}`);
  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  return dir.startsWith(homePrefix)
    ? `"$HOME/${escape(dir.slice(homePrefix.length))}"`
    : `"${escape(dir)}"`;
}

const LOOP_START = "for _swc_dir in ";
const LOOP_END = "; do";

/** The folders a block written by terminalPathBlock lists; [] for anything else. */
export function terminalPathBlockDirs(block: string, home: string): ReadonlyArray<string> {
  const line = block
    .split("\n")
    .map((text) => text.replace(/\r$/u, ""))
    .find((text) => text.startsWith(LOOP_START));
  if (!line?.endsWith(LOOP_END)) return [];
  const words = line.slice(LOOP_START.length, -LOOP_END.length);
  const word = /"((?:[^"\\]|\\[\\"$`])*)"(?: |$)/uy;
  const dirs: Array<string> = [];
  let match: RegExpExecArray | null;
  while ((match = word.exec(words)) !== null) {
    let dir = match[1]!;
    const homeRelative = dir.startsWith("$HOME/");
    if (homeRelative) dir = dir.slice("$HOME/".length);
    dir = dir.replace(/\\([\\"$`])/gu, "$1");
    if (homeRelative) dir = NodePath.posix.join(home, dir);
    if (NodePath.posix.isAbsolute(dir)) dirs.push(dir);
    if (word.lastIndex >= words.length) break;
  }
  return dirs;
}

/** The block for these folders, or null when there is nothing to add. */
export function terminalPathBlock(dirs: ReadonlyArray<string>, home: string): string | null {
  const listed = dirs.filter((dir) => !dir.includes("\n") && !dir.includes("\r"));
  if (listed.length === 0) return null;
  return [
    TERMINAL_PATH_START,
    "# Lets Terminal run claude, codex, specweave and the tools SpecWithCode installed.",
    "# Turn it off in SpecWithCode: Settings > General > Use these commands in Terminal.",
    `${LOOP_START}${listed.map((dir) => shellWord(dir, home)).join(" ")}${LOOP_END}`,
    '  case ":$PATH:" in *":$_swc_dir:"*) ;; *) PATH="$PATH:$_swc_dir" ;; esac',
    "done",
    "unset _swc_dir",
    "export PATH",
    TERMINAL_PATH_END,
    "",
  ].join("\n");
}

interface BlockRange {
  /** Offset of the start marker line. */
  readonly from: number;
  /** Offset just past the end marker line and its newline. */
  readonly to: number;
}

/** The well-formed blocks, matched as whole lines, or null when markers do not pair up. */
export function findTerminalPathBlocks(text: string): ReadonlyArray<BlockRange> | null {
  const blocks: Array<BlockRange> = [];
  let open: number | null = null;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const next = newline === -1 ? text.length : newline + 1;
    const line = text.slice(offset, newline === -1 ? text.length : newline).replace(/\r$/u, "");
    if (line === TERMINAL_PATH_START) {
      if (open !== null) return null;
      open = offset;
    } else if (line === TERMINAL_PATH_END) {
      if (open === null) return null;
      blocks.push({ from: open, to: next });
      open = null;
    }
    offset = next;
  }
  return open === null ? blocks : null;
}

/**
 * The startup file's new text. Present blocks collapse into one, replaced or removed. A missing
 * one is added only if the app never wrote one there: a person who deleted it opted out.
 */
export function applyTerminalPathBlock(
  existing: string,
  block: string | null,
  writtenBefore: boolean,
): { readonly text: string | null; readonly action: TerminalPathAction } {
  const blocks = findTerminalPathBlocks(existing);
  if (blocks === null) return { text: null, action: "malformed" };
  if (blocks.length > 0) {
    let next = "";
    let from = 0;
    blocks.forEach((range, index) => {
      const before = existing.slice(from, range.from);
      // Removing a block at the end also takes the blank line the add put in front of it.
      const gapped = block === null && range.to === existing.length && before.endsWith("\n\n");
      next += gapped ? before.slice(0, -1) : before;
      if (index === 0 && block !== null) next += block;
      from = range.to;
    });
    next += existing.slice(from);
    if (next === existing) return { text: null, action: "unchanged" };
    return { text: next, action: block === null ? "removed" : "updated" };
  }
  if (writtenBefore) return { text: null, action: "opted-out" };
  if (block === null) return { text: null, action: "unchanged" };
  if (existing.length === 0) return { text: block, action: "added" };
  const gap = existing.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${existing}${gap}${block}`, action: "added" };
}

/** Every startup file terminalStartupFile can name: the only files the record may point at. */
function knownStartupFiles(home: string): ReadonlyArray<string> {
  return [".zprofile", ".zshrc", ".bash_profile", ".bashrc"].map((name) =>
    NodePath.posix.join(home, name),
  );
}

/** Startup files the app wrote a block into; "unknown" when the record cannot be read. */
async function readState(
  home: string,
  fs: TerminalPathFs,
): Promise<ReadonlyArray<string> | "unknown"> {
  const file = terminalPathStateFile(home);
  const info = await fs.inspect(file);
  if (info.kind === "missing") return [];
  if (info.kind !== "file") return "unknown";
  try {
    const parsed: unknown = JSON.parse((await fs.readBytes(file)).toString("utf8"));
    const files = (parsed as { files?: unknown } | null)?.files;
    if (!Array.isArray(files) || !files.every((entry) => typeof entry === "string"))
      return "unknown";
    // Anything but a known startup file is never edited, whatever the record says.
    const known = knownStartupFiles(home);
    return files.filter((entry) => known.includes(entry));
  } catch {
    return "unknown";
  }
}

/** False when another writer changed the record meanwhile. */
async function writeState(
  home: string,
  files: ReadonlyArray<string>,
  fs: TerminalPathFs,
): Promise<boolean> {
  const file = terminalPathStateFile(home);
  const info = await fs.inspect(file);
  const bytes = Buffer.from(`${JSON.stringify({ files: [...new Set(files)] })}\n`, "utf8");
  return fs.replace(file, bytes, 0o644, info.stamp);
}

/** A startup file the app may edit: a regular file this account owns, or none yet. */
const editable = (info: StartupFileInfo) =>
  info.kind === "missing" ||
  (info.kind === "file" && info.owned && info.size <= TERMINAL_PATH_MAX_BYTES);

const toBytes = (text: string) => Buffer.from(text, "latin1");
/** UTF-8 text as the byte string the person's file is handled in, and back. */
const asByteString = (text: string) => Buffer.from(text, "utf8").toString("latin1");
const fromByteString = (text: string) => Buffer.from(text, "latin1").toString("utf8");

/**
 * A startup file the shell no longer reads, with its block taken out, or null when it has none
 * to take: a file without one may be a deleted block, so its record stays as the opt-out.
 */
async function staleBlockRemoval(file: string, fs: TerminalPathFs) {
  const info = await fs.inspect(file);
  if (info.kind !== "file" || !editable(info)) return null;
  const text = (await fs.readBytes(file)).toString("latin1");
  const { text: next } = applyTerminalPathBlock(text, null, true);
  return next === null ? null : { file, info, next };
}

/** Bring the startup file's block in line with what is installed now. */
export async function syncTerminalPath(input: TerminalPathInput): Promise<TerminalPathAction> {
  const { home, fs } = input;
  const file = terminalStartupFile(home, input.platform, input.shell);
  if (file === null) return "unsupported";
  const state = await readState(home, fs);
  let recorded = state === "unknown" ? [] : [...state];

  // A changed login shell: the file it no longer reads keeps no stale block. The record lets go
  // of it first, so a block the app removes never reads as one the person deleted; a block whose
  // removal then fails is recorded again when that shell comes back.
  let persisted: ReadonlyArray<string> | "unknown" = state;
  if (state !== "unknown") {
    const removals: Array<NonNullable<Awaited<ReturnType<typeof staleBlockRemoval>>>> = [];
    for (const stale of state.filter((entry) => entry !== file)) {
      const removal = await staleBlockRemoval(stale, fs);
      if (removal) removals.push(removal);
    }
    if (removals.length > 0) {
      recorded = recorded.filter((entry) => !removals.some((removal) => removal.file === entry));
      if (!(await writeState(home, recorded, fs))) return "busy";
      persisted = [...recorded];
      for (const { file: stale, info, next } of removals)
        await fs.replace(stale, toBytes(next), info.mode, info.stamp);
    }
  }

  const info = await fs.inspect(file);
  if (!editable(info)) return "unsupported";
  const text = info.kind === "missing" ? "" : (await fs.readBytes(file)).toString("latin1");
  const blocks = findTerminalPathBlocks(text);
  if (blocks === null) return "malformed";

  // Every block's folders: duplicates collapse into one, so none may lose another home's.
  const listed = blocks.flatMap((range) =>
    terminalPathBlockDirs(fromByteString(text.slice(range.from, range.to)), home),
  );
  const own = await terminalCommandDirs(input);
  const ownRoots = ownManagedRoots(input.baseDir);
  const others: Array<string> = [];
  for (const dir of listed) {
    if (own.includes(dir) || ownRoots.some((root) => dir.startsWith(root))) continue;
    // Another app home's folder stays while it still holds a command.
    if (await holdsCommand(dir, fs)) others.push(dir);
  }
  // Switched off: only other app homes' folders stay, if any are listed.
  const dirs = [...new Set([...(input.enabled ? own : []), ...others])].toSorted(blockOrder(home));
  const block = terminalPathBlock(dirs, home);
  const writtenBefore = !input.rearm && (state === "unknown" || state.includes(file));
  const { text: next, action } = applyTerminalPathBlock(
    text,
    block === null ? null : asByteString(block),
    writtenBefore,
  );

  if (next === null) {
    // A block written before a lost record still counts as written.
    if (blocks.length > 0 && !recorded.includes(file)) recorded.push(file);
  } else {
    const mode = info.kind === "file" ? info.mode : 0o644;
    if (!(await fs.replace(file, toBytes(next), mode, info.stamp))) return "busy";
    recorded = recorded.filter((entry) => entry !== file);
    if (action !== "removed") recorded.push(file);
  }
  const changed =
    persisted === "unknown" ? recorded.length > 0 : recorded.join("\n") !== persisted.join("\n");
  // Lost to another writer: a block found without a record is recorded on the next pass.
  if (changed) await writeState(home, recorded, fs);
  return action;
}

/**
 * Take the block out of every startup file the app may have written, for uninstall. A file that
 * changed while it was read, or could not be edited, is listed in the result.
 */
export async function removeTerminalPathBlocks(
  home: string,
  fs: TerminalPathFs,
): Promise<ReadonlyArray<string>> {
  const left: Array<string> = [];
  for (const file of knownStartupFiles(home)) {
    try {
      const info = await fs.inspect(file);
      if (info.kind !== "file") continue;
      const text = (await fs.readBytes(file)).toString("latin1");
      if (!text.includes(TERMINAL_PATH_START) && !text.includes(TERMINAL_PATH_END)) continue;
      const { text: next, action } = applyTerminalPathBlock(text, null, true);
      if (action === "malformed" || !editable(info)) left.push(file);
      else if (next !== null && !(await fs.replace(file, toBytes(next), info.mode, info.stamp)))
        left.push(file);
    } catch {
      left.push(file);
    }
  }
  const state = await readState(home, fs);
  if (state !== "unknown" && state.length > 0) await writeState(home, [], fs);
  return left;
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ||
  (error as NodeJS.ErrnoException | null)?.code === "ENOTDIR";

async function inspectFile(file: string): Promise<StartupFileInfo> {
  try {
    const info = await NodeFSP.lstat(file);
    const uid = process.getuid?.();
    return {
      kind: info.isFile() ? "file" : "other",
      size: info.size,
      mode: info.mode & 0o7777,
      owned: uid === undefined || info.uid === uid,
      stamp: `${info.ino}:${info.size}:${info.mtimeMs}`,
    };
  } catch (error) {
    if (missing(error)) return { kind: "missing", size: 0, mode: 0, owned: true, stamp: null };
    throw error;
  }
}

const TEMPORARY_STALE_MS = 10 * 60 * 1000;

/** Temp files a crash left behind; a fresh one may belong to another writer still at work. */
async function sweepTemporaries(dir: string, base: string): Promise<void> {
  const prefix = `.${base}.swc-`;
  for (const name of await NodeFSP.readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const temporary = NodePath.join(dir, name);
    const info = await NodeFSP.lstat(temporary).catch(() => null);
    if (info?.isFile() && Date.now() - info.mtimeMs > TEMPORARY_STALE_MS)
      await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** The real file system. */
export const nodeTerminalPathFs: TerminalPathFs = {
  inspect: inspectFile,
  readBytes: (file) => NodeFSP.readFile(file),
  replace: async (file, bytes, mode, expected) => {
    const dir = NodePath.dirname(file);
    await NodeFSP.mkdir(dir, { recursive: true });
    const temporary = NodePath.join(
      dir,
      `.${NodePath.basename(file)}.swc-${NodeCrypto.randomUUID()}.tmp`,
    );
    try {
      await NodeFSP.writeFile(temporary, bytes, { mode, flag: "wx" });
      await NodeFSP.chmod(temporary, mode);
      // Someone saved the file since it was read: keep theirs and try again next pass. This
      // narrows the window to the check and the rename; it does not lock out an editor.
      if ((await inspectFile(file)).stamp !== expected) {
        await NodeFSP.rm(temporary, { force: true });
        return false;
      }
      await NodeFSP.rename(temporary, file);
      await sweepTemporaries(dir, NodePath.basename(file));
      return true;
    } catch (error) {
      await NodeFSP.rm(temporary, { force: true });
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
  exists: async (path) => {
    try {
      await NodeFSP.lstat(path);
      return true;
    } catch {
      return false;
    }
  },
  listDir: async (path) => {
    try {
      return await NodeFSP.readdir(path);
    } catch {
      return [];
    }
  },
  readLink: async (path) => {
    try {
      return await NodeFSP.readlink(path);
    } catch {
      return null;
    }
  },
  setLink: async (path, target) => {
    const dir = NodePath.dirname(path);
    await NodeFSP.mkdir(dir, { recursive: true });
    const temporary = NodePath.join(dir, `.${NodePath.basename(path)}.swc-${NodeCrypto.randomUUID()}`);
    await NodeFSP.symlink(target, temporary);
    try {
      await NodeFSP.rename(temporary, path);
    } catch (error) {
      await NodeFSP.rm(temporary, { force: true });
      throw error;
    }
  },
  removeLink: async (path) => {
    const info = await NodeFSP.lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) await NodeFSP.rm(path, { force: true });
  },
};
