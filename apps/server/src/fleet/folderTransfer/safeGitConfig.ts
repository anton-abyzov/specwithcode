/**
 * The Git settings a folder copy carries to another machine (1328).
 *
 * A repository's `.git/config` can name commands Git runs later: hooks paths,
 * fsmonitor, filter and diff drivers, credential helpers, `ext::` remotes,
 * `!command` submodule updates, aliases, includes. Copied as it is, the next
 * ordinary Git call or agent on the destination runs them, and remote URLs can
 * hold a token. So a copied config keeps only an allowlist of plain settings,
 * with user info stripped from every URL; everything else stays behind.
 */
// @effect-diagnostics nodeBuiltinImport:off - folder transfer runs on plain Node promises.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runGit } from "./git.ts";

const PLAIN_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.sparsecheckout",
  "core.sparsecheckoutcone",
  "core.autocrlf",
  "core.eol",
  "core.safecrlf",
  "core.longpaths",
  "core.splitindex",
  "core.untrackedcache",
  "core.commitgraph",
  "core.multipackindex",
  "extensions.objectformat",
  "extensions.refstorage",
  "extensions.worktreeconfig",
  "extensions.preciousobjects",
  "index.sparse",
  "index.version",
  "lfs.repositoryformatversion",
  "pull.rebase",
  "pull.ff",
  "fetch.prune",
]);

/** Per-name sections whose listed keys are plain values. */
const SECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  remote: new Set(["url", "fetch", "promisor", "partialclonefilter", "tagopt"]),
  branch: new Set(["remote", "merge", "rebase", "pushremote"]),
  submodule: new Set(["url", "active", "update", "branch", "shallow"]),
};

const URL_KEYS = new Set(["remote.url", "submodule.url"]);
/** Keys whose value names a remote, or may be a URL in its place. */
const REMOTE_NAME_KEYS = new Set(["branch.remote", "branch.pushremote"]);
/** Section-less keys whose value names a remote, or may be a URL in its place. */
const REMOTE_NAME_PLAIN_KEYS = new Set(["extensions.partialclone"]);
const SUBMODULE_UPDATE = new Set(["checkout", "rebase", "merge", "none"]);
/** The filter Git LFS itself installs; any other filter command stays behind. */
const LFS_FILTER: Readonly<Record<string, string>> = {
  "filter.lfs.clean": "git-lfs clean -- %f",
  "filter.lfs.smudge": "git-lfs smudge -- %f",
  "filter.lfs.process": "git-lfs filter-process",
  "filter.lfs.required": "true",
};
const SCHEMES = new Set(["https", "http", "ssh", "git"]);
const SCP_LIKE =
  /^(?:([A-Za-z0-9._~+-]+)@)?(\[[0-9A-Fa-f:.%a-z]+\]|[A-Za-z0-9][A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

/**
 * A remote URL safe to carry: user info removed (a plain ssh user name stays),
 * query and fragment removed from web URLs, and only transports that run no
 * local command. The rest of the URL is kept byte for byte, so Git selects the
 * same repository. Null when it must stay behind.
 */
export function safeRemoteUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2_048) return null;
  // Control characters and backslashes (Windows paths) never belong in a carried remote.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  // `ext::cmd`, `fd::` and other `<helper>::<address>` forms start programs.
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (!SCHEMES.has(name)) return null;
    const rest = value.slice(scheme[0].length);
    // The authority ends at the first `/`, `?` or `#`, whichever comes first.
    const end = rest.search(/[/?#]/);
    const authority = end < 0 ? rest : rest.slice(0, end);
    let path = end < 0 ? "" : rest.slice(end);
    const at = authority.lastIndexOf("@");
    const host = authority.slice(at + 1);
    if (host.length === 0 || host.startsWith("-") || /\s/.test(host)) return null;
    // ssh keeps a plain user name (git@); a password or token never travels.
    const user = name === "ssh" && at > 0 ? authority.slice(0, at).split(":")[0]! : "";
    if (user.startsWith("-")) return null;
    if (name === "https" || name === "http") path = path.replace(/[?#].*$/s, "");
    if (/[?#]/.test(host)) return null;
    return `${name}://${user ? `${user}@` : ""}${host}${path}`;
  }
  // scp-like `[user@]host:path`, host at least two characters so a drive letter is not one.
  const scp = SCP_LIKE.exec(value);
  if (scp && !scp[2]!.startsWith("-") && !(scp[1] ?? "").startsWith("-")) return value;
  // Local paths would point at the source machine's folders.
  return null;
}

/** A remote's name as `branch.<b>.remote` holds it; null when it is no plain name. */
const isRemoteName = (value: string) =>
  /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..");

export interface SafeGitConfigOptions {
  /** Whether a `core.worktree` value may stay: it must point inside the copy. Absent: never. */
  readonly keepWorktree?: (value: string) => boolean;
}

interface WorktreeCheck {
  /** The config file being rewritten. */
  readonly file: string;
  /** The copied folder the worktree must stay inside. */
  readonly root: string;
  /** The live folder the copy mirrors: symlinks are resolved there. */
  readonly sourceRoot: string;
}

/** Which entries of a copied config are kept, given `git config --list` pairs. */
export function safeGitConfigEntries(
  entries: ReadonlyArray<readonly [string, string]>,
  options: SafeGitConfigOptions = {},
): Array<readonly [string, string]> {
  const kept: Array<readonly [string, string]> = [];
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    if (REMOTE_NAME_PLAIN_KEYS.has(lower)) {
      const value_kept = isRemoteName(value) ? value : safeRemoteUrl(value);
      if (value_kept !== null) kept.push([key, value_kept]);
      continue;
    }
    if (PLAIN_KEYS.has(lower)) {
      kept.push([key, value]);
      continue;
    }
    if (lower in LFS_FILTER) {
      if (value.trim() === LFS_FILTER[lower]) kept.push([key, value.trim()]);
      continue;
    }
    if (lower === "core.worktree") {
      if (options.keepWorktree?.(value) === true) kept.push([key, value]);
      continue;
    }
    const first = lower.indexOf(".");
    const last = lower.lastIndexOf(".");
    if (first <= 0 || last === first) continue;
    const section = lower.slice(0, first);
    const name = lower.slice(last + 1);
    if (!SECTION_KEYS[section]?.has(name)) continue;
    if (URL_KEYS.has(`${section}.${name}`)) {
      const url = safeRemoteUrl(value);
      if (url !== null) kept.push([key, url]);
      continue;
    }
    if (REMOTE_NAME_KEYS.has(`${section}.${name}`)) {
      if (isRemoteName(value)) kept.push([key, value]);
      else {
        const url = safeRemoteUrl(value);
        if (url !== null) kept.push([key, url]);
      }
      continue;
    }
    if (section === "submodule" && name === "update" && !SUBMODULE_UPDATE.has(value.trim()))
      continue;
    kept.push([key, value]);
  }
  return kept;
}

/** Parses `git config --null --list` output: `key\nvalue\0` records. */
export function parseNullConfigList(output: string): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const newline = record.indexOf("\n");
    entries.push(
      newline < 0 ? [record, "true"] : [record.slice(0, newline), record.slice(newline + 1)],
    );
  }
  return entries;
}

/**
 * A `core.worktree` check for the config file at `file`: the value, read
 * relative to that Git directory, must stay inside `root`, the copied folder,
 * with no link on the way (checked in `sourceRoot`, the live folder the copy
 * mirrors).
 */
export async function worktreeInside(check: WorktreeCheck, value: string): Promise<boolean> {
  if (value.length === 0 || /[\\\u0000-\u001f]/.test(value)) return false;
  if (NodePath.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  // Climbing out of the Git directory, then down by name only: a `..` after a
  // name would be read through whatever that name links to.
  const segments = value.split("/");
  let index = 0;
  while (segments[index] === "..") index += 1;
  if (segments.slice(index).some((part) => part === "" || part === "." || part === ".."))
    return false;
  const resolved = NodePath.resolve(NodePath.dirname(check.file), value);
  const relative = NodePath.relative(NodePath.resolve(check.root), resolved);
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) return false;
  const sourceRoot = await NodeFSP.realpath(check.sourceRoot).catch(() => null);
  if (sourceRoot === null) return false;
  const lexical = NodePath.join(sourceRoot, relative);
  const real = await NodeFSP.realpath(lexical).catch(() => null);
  // Missing, or reached through a link: not kept.
  return real === lexical;
}

/** Writes `target` holding only the safe entries of `source`, read without following includes. */
async function writeSafeGitConfig(
  source: string,
  target: string,
  options: { readonly worktree?: WorktreeCheck; readonly signal?: AbortSignal },
): Promise<void> {
  // Outside any repository, so Git reads no other config while it lists and writes this one.
  const cwd = NodeOS.tmpdir();
  const signal = options.signal ? { signal: options.signal } : {};
  const listed = await runGit(
    cwd,
    ["config", "--file", source, "--no-includes", "--null", "--list"],
    signal,
  );
  const entries = parseNullConfigList(listed.stdout);
  const allowed = new Set<string>();
  if (options.worktree !== undefined)
    for (const [key, value] of entries)
      if (
        key.trim().toLowerCase() === "core.worktree" &&
        (await worktreeInside(options.worktree, value))
      )
        allowed.add(value);
  const kept = safeGitConfigEntries(entries, { keepWorktree: (value) => allowed.has(value) });
  await NodeFSP.rm(target, { force: true });
  await NodeFSP.writeFile(target, "", { mode: 0o600 });
  for (const [key, value] of kept)
    await runGit(cwd, ["config", "--file", target, "--add", key, value], signal);
}

/**
 * Rewrites one copied config file to its safe entries. Reads it without
 * following includes, then writes a fresh file in its place.
 */
export async function rewriteCopiedGitConfig(
  file: string,
  options: { readonly worktree?: WorktreeCheck; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const exists = await NodeFSP.lstat(file).catch(() => null);
  if (!exists?.isFile()) return;
  const fresh = `${file}.safe`;
  await writeSafeGitConfig(file, fresh, options);
  await NodeFSP.rename(fresh, file);
}

/**
 * The bytes a copy would carry for a live config file, so a later drift check
 * compares like with like. `root` is the copied folder. Null when missing.
 */
export async function safeGitConfigBytes(
  file: string,
  /** The live copied folder; null for a main repository's own configs, which keep no worktree. */
  root: string | null,
): Promise<Buffer | null> {
  const exists = await NodeFSP.lstat(file).catch(() => null);
  if (!exists?.isFile()) return null;
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-safe-config-"));
  try {
    const target = NodePath.join(directory, "config");
    await writeSafeGitConfig(
      file,
      target,
      root === null ? {} : { worktree: { file, root, sourceRoot: root } },
    );
    return await NodeFSP.readFile(target);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/** A Git directory has a HEAD file and an objects folder; a name prefix has neither. */
async function isGitDirectory(dir: string): Promise<boolean> {
  const head = await NodeFSP.lstat(NodePath.join(dir, "HEAD")).catch(() => null);
  const objects = await NodeFSP.lstat(NodePath.join(dir, "objects")).catch(() => null);
  return head?.isFile() === true && objects?.isDirectory() === true;
}

/**
 * Every Git directory a copied `.git` holds: itself and each one anywhere
 * under `modules/` (a HEAD file and an objects folder), however submodule
 * names nest or overlap. No folder is trusted as a boundary: a repository
 * planted at a name prefix cannot hide a deeper one. Links are not followed.
 */
export async function gitDirectoriesIn(gitDir: string): Promise<Array<string>> {
  const modules = NodePath.join(gitDir, "modules");
  const entries = await NodeFSP.readdir(modules, { withFileTypes: true, recursive: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return [];
      throw cause;
    },
  );
  const found: Array<string> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = NodePath.join(entry.parentPath, entry.name);
    if (await isGitDirectory(dir)) found.push(dir);
  }
  found.sort((left, right) => left.length - right.length || (left < right ? -1 : 1));
  return [gitDir, ...found];
}

/** The config files of one Git directory: its own, and each worktree's `config.worktree`. */
export async function gitConfigFilesOf(dir: string): Promise<Array<string>> {
  const files = [NodePath.join(dir, "config"), NodePath.join(dir, "config.worktree")];
  for (const admin of await NodeFSP.readdir(NodePath.join(dir, "worktrees"), {
    withFileTypes: true,
  }).catch(() => []))
    if (admin.isDirectory())
      files.push(NodePath.join(dir, "worktrees", admin.name, "config.worktree"));
  return files;
}

/** Pending sequences whose todo lines Git runs as commands on `--continue`. */
const TODO_FILES = ["rebase-merge/git-rebase-todo", "sequencer/todo"];

async function refuseCommandTodo(dir: string): Promise<void> {
  const admins = [dir];
  for (const admin of await NodeFSP.readdir(NodePath.join(dir, "worktrees"), {
    withFileTypes: true,
  }).catch(() => []))
    if (admin.isDirectory()) admins.push(NodePath.join(dir, "worktrees", admin.name));
  for (const admin of admins)
    for (const name of TODO_FILES) {
      const text = await NodeFSP.readFile(NodePath.join(admin, name), "utf8").catch(() => "");
      if (/^\s*(?:x|exec)\b/m.test(text))
        throw new Error(
          "A Git rebase in progress here runs commands (exec lines). Finish or abort it before copying.",
        );
    }
}

/**
 * Makes a copied Git folder safe to carry (1328): in every Git directory it
 * holds, configs keep only safe entries, and the parts that run commands or
 * point elsewhere are removed: hooks, a top-level `commondir` (it would pick
 * another config), legacy `remotes/` and `branches/` (they hold URLs). A
 * pending rebase with `exec` lines refuses the copy. `root` is the copied
 * folder `core.worktree` must stay inside.
 */
/**
 * Names Git reads inside a Git directory. Another spelling of one (`HOOKS`,
 * `Config`) is plain data on a case-sensitive disk but becomes that entry on a
 * case-insensitive one, so it is removed rather than carried unchecked.
 */
const GIT_NAMES = [
  "HEAD",
  "config",
  "config.worktree",
  "hooks",
  "commondir",
  "gitdir",
  "remotes",
  "branches",
  "info",
  "objects",
  "refs",
  "logs",
  "modules",
  "worktrees",
  "packed-refs",
  "index",
  "shallow",
  "sequencer",
  "rebase-merge",
  "rebase-apply",
  "attributes",
  "exclude",
  "sparse-checkout",
  "alternates",
];
const GIT_NAME_OF = new Map(GIT_NAMES.map((name) => [name.toLowerCase(), name]));

async function removeCaseAliases(dir: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(dir).catch(() => [] as Array<string>)) {
    const canonical = GIT_NAME_OF.get(entry.toLowerCase());
    if (canonical !== undefined && canonical !== entry)
      await NodeFSP.rm(NodePath.join(dir, entry), { recursive: true, force: true });
  }
}

export async function sanitizeCopiedGitDir(
  gitDir: string,
  root: string,
  options: {
    readonly signal?: AbortSignal;
    /** The live folder the copy mirrors; defaults to `root`. */
    readonly sourceRoot?: string;
  } = {},
): Promise<void> {
  // Aliases first, so the walk below sees only the names Git will read.
  const aliasDirs = async (dir: string) => {
    const dirs = [dir, NodePath.join(dir, "info"), NodePath.join(dir, "objects", "info")];
    for (const admin of await NodeFSP.readdir(NodePath.join(dir, "worktrees"), {
      withFileTypes: true,
    }).catch(() => []))
      if (admin.isDirectory()) {
        const path = NodePath.join(dir, "worktrees", admin.name);
        dirs.push(path, NodePath.join(path, "info"));
      }
    return dirs;
  };
  await removeCaseAliases(gitDir);
  for (const dir of await gitDirectoriesIn(gitDir))
    for (const path of await aliasDirs(dir)) await removeCaseAliases(path);
  for (const dir of await gitDirectoriesIn(gitDir)) {
    await refuseCommandTodo(dir);
    for (const name of ["hooks", "commondir", "remotes", "branches"])
      await NodeFSP.rm(NodePath.join(dir, name), { recursive: true, force: true });
    for (const file of await gitConfigFilesOf(dir))
      await rewriteCopiedGitConfig(file, {
        ...(options.signal ? { signal: options.signal } : {}),
        // Only a submodule's own config names its working folder; the main one never needs to.
        ...(dir === gitDir
          ? {}
          : { worktree: { file, root, sourceRoot: options.sourceRoot ?? root } }),
      });
  }
}

/** Git directory parts not copied at all: the main hooks folder (removed again by sanitizing). */
export function isUncarriedGitPath(relative: string, isDirectory: boolean): boolean {
  return isDirectory && relative.toLowerCase() === "hooks";
}
