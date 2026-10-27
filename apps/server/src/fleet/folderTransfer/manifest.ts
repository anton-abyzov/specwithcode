// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the copy engine walks, stats and hashes with no-follow descriptors.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { canonicalOrigin } from "../handoffGitTypes.ts";
import {
  classifyFile,
  FILE_CLASSES,
  isRebuildableDirectoryName,
  type FileClass,
} from "./classify.ts";
import { FolderGitError, gitList, runGit } from "./git.ts";
import { isSafeRelativePath, linkTargetOnWire } from "./paths.ts";

/** Fixed chunk size: large files move and resume in 8 MiB pieces. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
/** A copy refuses folders with more entries than this instead of exhausting memory. */
export const MAX_ENTRIES = 2_000_000;
const HASH_CONCURRENCY = 8;
/** Directory children are stat'ed this many at a time; entries keep their sorted order. */
const STAT_CONCURRENCY = 64;
/** A scan reports progress at most this often. */
const PROGRESS_INTERVAL_MS = 250;
const READ_BUFFER = 1024 * 1024;

export type EntryType = "file" | "directory" | "symlink";

export interface ManifestEntry {
  readonly path: string;
  readonly type: EntryType;
  /** Permission bits only. */
  readonly mode: number;
  /** Bytes for files; total bytes below a collapsed folder. */
  size: number;
  mtimeMs: number;
  readonly class: FileClass;
  /** Innermost repository containing the entry, relative to the root ("." is the root). */
  readonly repo: string | null;
  sha256?: string;
  chunks?: Array<string>;
  readonly target?: string;
  /** A rebuildable folder counted but not listed; listed only when selected. */
  collapsed?: { files: number };
  /** The file kept changing while it was read; it is copied as last read and flagged. */
  unstable?: boolean;
  /** Source-owned generated Git data in the operation's private snapshot. */
  readonly portableGit?: boolean;
}

export interface RepositoryInfo {
  readonly path: string;
  /** main: has a `.git` folder; linked: a linked worktree; gitfile: another `.git` file (submodule). */
  readonly kind: "main" | "linked" | "gitfile";
  readonly head: string | null;
  readonly branch: string | null;
  readonly branches: Readonly<Record<string, string>>;
  readonly stash: string | null;
  readonly stashCount: number;
  /** Canonical origin without credentials, or null without one. */
  readonly identity: string | null;
  /** The origin URL with any user name or password removed, for "clone from origin". */
  readonly origin: string | null;
  /** `git status --porcelain` lines (`XY path`), untracked folders collapsed. */
  readonly status: ReadonlyArray<string>;
  /** Linked worktrees of a main repository: inside the root (relative path) or outside. */
  readonly worktrees: ReadonlyArray<{ readonly path: string | null; readonly name: string }>;
  readonly missingWorktrees?: ReadonlyArray<string>;
  readonly worktreeRegistrationFingerprint?: string;
  /** For linked worktrees: the main repository's path relative to the root, or null outside it. */
  readonly mainRepository: string | null;
}

export type ClassTotals = Record<FileClass, { files: number; bytes: number }>;

export interface FolderScanSkipped {
  /** Rebuildable folders recorded as collapsed without counting what is inside them. */
  readonly rebuildableFolders: number;
  /** Linked worktrees inside the root whose main repository is inside it too, relative to the root. */
  readonly worktrees: ReadonlyArray<string>;
  /** Skipped worktrees with uncommitted (staged, unstaged or untracked) changes. */
  readonly dirtyWorktrees?: ReadonlyArray<string>;
  /** Skipped worktrees whose status could not be read in time; they may hold changes. */
  readonly uncheckedWorktrees?: ReadonlyArray<string>;
  /**
   * Skipped worktrees whose commits would not travel: a detached HEAD that no local
   * branch contains, or a rebase, merge, cherry-pick or revert in progress.
   */
  readonly strandedWorktrees?: ReadonlyArray<string>;
}

export interface FolderScan {
  readonly root: string;
  readonly entries: Array<ManifestEntry>;
  readonly repositories: Array<RepositoryInfo>;
  readonly totals: ClassTotals;
  readonly warnings: Array<string>;
  /** Informational scope/portability notes, not incomplete-snapshot warnings. */
  readonly notices?: Array<string>;
  /** What the scan left out to stay fast. */
  readonly skipped?: FolderScanSkipped;
}

export interface ScanProgress {
  readonly files: number;
  readonly bytes: number;
  /** Set while the skipped worktrees are checked for uncommitted changes. */
  readonly step?: "checking-worktrees";
}

export interface ScanOptions {
  readonly expandRebuildable?: boolean;
  readonly maxEntries?: number;
  /** Files and bytes listed so far, at most every 250 ms. */
  readonly onProgress?: (progress: ScanProgress) => void;
  /** Checked at least once per folder; true stops the scan with a "stopped" FolderScanError. */
  readonly shouldStop?: () => boolean;
  /**
   * Walk linked worktrees of repositories inside the root like any repository.
   * Only the private Git snapshot uses it, to list the relative pointers it wrote.
   */
  readonly keepLinkedWorktrees?: boolean;
  /** Test seam: per-worktree time limit for the uncommitted-changes check. */
  readonly worktreeStatusTimeoutMs?: number;
}

export class FolderScanError extends Error {
  readonly reason: "not-a-folder" | "too-many-entries" | "unreadable" | "git-failed" | "stopped";
  constructor(reason: FolderScanError["reason"], detail?: string) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

/** True for the error a scan throws when its `shouldStop` check asked it to stop. */
export const isScanStopped = (cause: unknown): boolean =>
  cause instanceof FolderScanError && cause.reason === "stopped";

export function emptyTotals(): ClassTotals {
  return Object.fromEntries(
    FILE_CLASSES.map((name) => [name, { files: 0, bytes: 0 }]),
  ) as ClassTotals;
}

interface RepoContext {
  readonly path: string;
  readonly absolute: string;
  readonly tracked: Set<string>;
  readonly ignoredFiles: Set<string>;
  readonly ignoredDirectories: Array<string>;
}

const relativeOf = (root: string, absolute: string) =>
  absolute === root ? "." : NodePath.relative(root, absolute).split(NodePath.sep).join("/");

/** Git prints absolute paths with forward slashes on Windows; compare them in native form. */
const fromGit = (path: string) => NodePath.resolve(path.trim());

const insideRepo = (repo: string, relative: string) =>
  repo === "."
    ? relative
    : relative.startsWith(`${repo}/`)
      ? relative.slice(repo.length + 1)
      : null;

function gitStateIn(context: RepoContext, inner: string): "tracked" | "untracked" | "ignored" {
  if (context.tracked.has(inner)) return "tracked";
  if (context.ignoredFiles.has(inner)) return "ignored";
  for (const directory of context.ignoredDirectories)
    if (inner === directory || inner.startsWith(`${directory}/`)) return "ignored";
  return "untracked";
}

async function readRepository(
  root: string,
  absolute: string,
  gitEntry: NodeFS.Stats,
): Promise<{ info: RepositoryInfo; context: RepoContext }> {
  const path = relativeOf(root, absolute);
  let kind: RepositoryInfo["kind"] = gitEntry.isDirectory() ? "main" : "gitfile";
  let mainRepository: string | null = null;
  if (kind === "gitfile") {
    const common = fromGit(
      (await runGit(absolute, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout,
    );
    const gitDir = fromGit(
      (await runGit(absolute, ["rev-parse", "--path-format=absolute", "--git-dir"])).stdout,
    );
    if (common !== gitDir) {
      kind = "linked";
      const mainTop = NodePath.dirname(common);
      const realRoot = await NodeFSP.realpath(root);
      mainRepository =
        mainTop === realRoot || mainTop.startsWith(`${realRoot}${NodePath.sep}`)
          ? relativeOf(realRoot, mainTop)
          : null;
    }
  }
  const headResult = await runGit(absolute, ["rev-parse", "--verify", "-q", "HEAD"], {
    allowFailure: true,
  });
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;
  const branchResult = await runGit(absolute, ["symbolic-ref", "-q", "--short", "HEAD"], {
    allowFailure: true,
  });
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const branches: Record<string, string> = {};
  for (const line of (
    await runGit(absolute, [
      "for-each-ref",
      "--format=%(objectname) %(refname:short)",
      "refs/heads",
    ])
  ).stdout
    .split("\n")
    .filter(Boolean)) {
    const space = line.indexOf(" ");
    branches[line.slice(space + 1)] = line.slice(0, space);
  }
  const stashResult = await runGit(absolute, ["rev-parse", "--verify", "-q", "refs/stash"], {
    allowFailure: true,
  });
  const stash = stashResult.code === 0 ? stashResult.stdout.trim() : null;
  const stashCount = stash
    ? Number(
        (
          await runGit(absolute, ["rev-list", "--walk-reflogs", "--count", "refs/stash"], {
            allowFailure: true,
          })
        ).stdout.trim() || "0",
      )
    : 0;
  const origin = await runGit(absolute, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  });
  const identity = origin.code === 0 ? canonicalOrigin(origin.stdout.trim()) : null;
  const originUrl = identity ? withoutCredentials(origin.stdout.trim()) : null;
  const status = (
    await gitList(absolute, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ])
  ).filter((line) => line.length > 3);
  const worktrees: Array<{ path: string | null; name: string }> = [];
  const missingWorktrees: Array<string> = [];
  let worktreeRegistrationFingerprint: string | undefined;
  if (kind === "main") {
    const listing = (await runGit(absolute, ["worktree", "list", "--porcelain"])).stdout;
    worktreeRegistrationFingerprint = NodeCrypto.createHash("sha256").update(listing).digest("hex");
    const realRoot = await NodeFSP.realpath(root);
    for (const block of listing.split("\n\n")) {
      const line = block.split("\n").find((item) => item.startsWith("worktree "));
      if (!line) continue;
      const location = fromGit(line.slice("worktree ".length));
      if (location === absolute || location === (await NodeFSP.realpath(absolute))) continue;
      // A Git registration can survive its working folder. Never call it a current folder.
      const exists = await NodeFSP.lstat(location).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (!exists?.isDirectory()) {
        missingWorktrees.push(NodePath.basename(location));
        continue;
      }
      const inside = location === realRoot || location.startsWith(`${realRoot}${NodePath.sep}`);
      worktrees.push({
        path: inside ? relativeOf(realRoot, location) : null,
        name: NodePath.basename(location),
      });
    }
  }
  const tracked = new Set(await gitList(absolute, ["ls-files", "-z", "--cached"]));
  const ignored = await gitList(absolute, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  const ignoredFiles = new Set<string>();
  const ignoredDirectories: Array<string> = [];
  for (const item of ignored)
    if (item.endsWith("/")) ignoredDirectories.push(item.slice(0, -1));
    else ignoredFiles.add(item);
  return {
    info: {
      path,
      kind,
      head,
      branch,
      branches,
      stash,
      stashCount,
      identity,
      origin: originUrl,
      status,
      worktrees,
      missingWorktrees,
      ...(worktreeRegistrationFingerprint !== undefined ? { worktreeRegistrationFingerprint } : {}),
      mainRepository,
    },
    context: { path, absolute, tracked, ignoredFiles, ignoredDirectories },
  };
}

/** An origin URL safe to send and store: no password, no HTTP user name. */
export function withoutCredentials(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- Control bytes never belong in a remote URL.
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (!value.includes("://"))
    return /^[^@/:]+@[^:]+:/.test(value) || !value.includes("@") ? value : null;
  try {
    const url = new URL(value);
    if (url.protocol === "ssh:") url.password = "";
    else {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The Git directory of a linked worktree at `absolute` whose main repository is
 * inside `realRoot`, read from the `.git` file and `commondir` without running
 * Git. It is such a worktree only when `.git` is a FILE whose `gitdir` resolves to
 * `<main>/.git/worktrees/<name>` and whose `commondir` resolves to that `<main>/.git`.
 * Being named by `git worktree list` is not enough: an independent repository
 * re-created at a stale worktree path must be read as a repository.
 * Null when it is not such a worktree or cannot be read.
 */
async function innerWorktreeGitDir(absolute: string, realRoot: string): Promise<string | null> {
  try {
    const gitFile = NodePath.join(absolute, ".git");
    const stat = await NodeFSP.lstat(gitFile);
    if (!stat.isFile() || stat.size > 4096) return null;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(await NodeFSP.readFile(gitFile, "utf8"));
    if (!match) return null;
    const gitDir = NodePath.resolve(absolute, match[1]!);
    const realGitDir = await NodeFSP.realpath(gitDir);
    const worktrees = NodePath.dirname(realGitDir);
    const mainGit = NodePath.dirname(worktrees);
    if (NodePath.basename(worktrees) !== "worktrees" || NodePath.basename(mainGit) !== ".git")
      return null;
    if (!(await NodeFSP.lstat(mainGit)).isDirectory()) return null;
    const common = await NodeFSP.realpath(
      NodePath.resolve(
        realGitDir,
        (await NodeFSP.readFile(NodePath.join(realGitDir, "commondir"), "utf8")).trim(),
      ),
    );
    if (common !== mainGit) return null;
    const mainTop = NodePath.dirname(mainGit);
    return mainTop === realRoot || mainTop.startsWith(`${realRoot}${NodePath.sep}`) ? gitDir : null;
  } catch {
    return null;
  }
}

/** Skipped worktrees checked at once, and each check's time limit. */
const WORKTREE_STATUS_CONCURRENCY = 4;
const WORKTREE_STATUS_TIMEOUT_MS = 10_000;

/** Markers in a worktree's Git directory of an operation that leaves commits on no branch. */
const STRANDING_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

/**
 * Whether a skipped worktree's committed work would stay behind: an operation in
 * progress, or a detached HEAD no local branch contains. Null when that could not
 * be decided in time: its Git commands share one deadline, the status check's limit.
 */
async function worktreeStranded(
  folder: string,
  gitDir: string | undefined,
  timeoutMs: number,
): Promise<boolean | null> {
  if (gitDir) {
    for (const marker of STRANDING_MARKERS)
      if (await NodeFSP.lstat(NodePath.join(gitDir, marker)).catch(() => null)) return true;
    // A HEAD naming a branch travels with the main repository's refs.
    const head = await NodeFSP.readFile(NodePath.join(gitDir, "HEAD"), "utf8").catch(() => null);
    if (head !== null && head.startsWith("ref: ")) return false;
  }
  const deadline = Date.now() + timeoutMs;
  const git = (args: ReadonlyArray<string>) => {
    const left = deadline - Date.now();
    return left <= 0
      ? Promise.resolve(null)
      : runGit(folder, args, { allowFailure: true, timeoutMs: left }).catch(() => null);
  };
  const symbolic = await git(["symbolic-ref", "-q", "HEAD"]);
  if (!symbolic) return null;
  if (symbolic.code === 0) return false;
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head) return null;
  // An unborn detached HEAD has no commits to lose.
  if (head.code !== 0) return false;
  const containing = await git([
    "for-each-ref",
    "--count=1",
    "--format=%(refname)",
    "--contains",
    "HEAD",
    "refs/heads",
  ]);
  if (!containing || containing.code !== 0) return null;
  return containing.stdout.trim().length === 0;
}

/**
 * Which skipped worktrees hold uncommitted work: staged, unstaged or untracked
 * changes (submodules ignored), and which hold commits that would not travel
 * (stranded). A check that fails or times out is "unknown".
 */
async function worktreeChanges(
  realRoot: string,
  folders: ReadonlyArray<string>,
  gitDirs: ReadonlyMap<string, string>,
  options: ScanOptions,
): Promise<{ dirty: Array<string>; unknown: Array<string>; stranded: Array<string> }> {
  const verdicts: Array<"clean" | "dirty" | "unknown"> = folders.map(() => "unknown");
  const stranded: Array<boolean> = folders.map(() => false);
  const timeoutMs = options.worktreeStatusTimeoutMs ?? WORKTREE_STATUS_TIMEOUT_MS;
  let checked = 0;
  await forEachLimited(folders, WORKTREE_STATUS_CONCURRENCY, async (folder, index) => {
    if (options.shouldStop?.()) throw new FolderScanError("stopped");
    const absolute = NodePath.join(realRoot, folder);
    const [result, strandedVerdict] = await Promise.all([
      runGit(
        absolute,
        ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"],
        { allowFailure: true, timeoutMs },
      ).catch(() => null),
      worktreeStranded(absolute, gitDirs.get(folder), timeoutMs).catch(() => null),
    ]);
    if (result && result.code === 0 && strandedVerdict !== null)
      verdicts[index] = result.stdout.length > 0 ? "dirty" : "clean";
    else if (result && result.code === 0 && result.stdout.length > 0) verdicts[index] = "dirty";
    stranded[index] = strandedVerdict === true;
    checked += 1;
    options.onProgress?.({ files: checked, bytes: 0, step: "checking-worktrees" });
  });
  if (options.shouldStop?.()) throw new FolderScanError("stopped");
  return {
    dirty: folders.filter((_, index) => verdicts[index] === "dirty"),
    unknown: folders.filter((_, index) => verdicts[index] === "unknown"),
    stranded: folders.filter((_, index) => stranded[index]),
  };
}

const SKIPPED_WORKTREES_NAMED = 20;

const SKIPPED_WORKTREES_PREFIX = /^\d+ linked worktree\(s\) inside this folder are not copied/;

/** True for the notice naming the skipped worktrees; summaries keep it first. */
export const isSkippedWorktreesNotice = (notice: string) => SKIPPED_WORKTREES_PREFIX.test(notice);

const nameSome = (paths: ReadonlyArray<string>) =>
  paths.slice(0, SKIPPED_WORKTREES_NAMED).join(", ") +
  (paths.length > SKIPPED_WORKTREES_NAMED
    ? ` and ${paths.length - SKIPPED_WORKTREES_NAMED} more`
    : "");

function skippedWorktreesNotice(
  paths: ReadonlyArray<string>,
  dirty: ReadonlyArray<string>,
  unknown: ReadonlyArray<string>,
  stranded: ReadonlyArray<string>,
): string {
  const changes =
    dirty.length > 0
      ? ` ${dirty.length} of them have uncommitted changes that stay on this machine: ${nameSome(dirty)}. Commit them first to copy that work.`
      : "";
  const unchecked =
    unknown.length > 0
      ? ` ${unknown.length} could not be checked for uncommitted changes and may hold some: ${nameSome(unknown)}.`
      : "";
  const strandedText =
    stranded.length > 0
      ? ` ${stranded.length} have commits on no branch that would not travel: ${nameSome(stranded)}. Create a branch there, or finish the rebase, merge or cherry-pick, to copy them.`
      : "";
  return `${paths.length} linked worktree(s) inside this folder are not copied: ${nameSome(paths)}. Their committed branches are copied with the main repository; uncommitted changes in them stay on this machine.${changes}${unchecked}${strandedText}`;
}

/**
 * Lists the folder without following any link: every entry's path, type, mode,
 * size and mtime, each file's class, and each repository's refs, status and
 * worktrees. Rebuildable ignored folders are recorded, not opened, until selected.
 * Linked worktrees inside the root whose main repository is inside it too are not
 * listed: their branches travel with the main repository.
 */
export async function scanFolder(root: string, options: ScanOptions = {}): Promise<FolderScan> {
  let realRoot: string;
  try {
    realRoot = await NodeFSP.realpath(root);
    if (!(await NodeFSP.lstat(realRoot)).isDirectory()) throw new Error();
  } catch {
    throw new FolderScanError("not-a-folder");
  }
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const entries: Array<ManifestEntry> = [];
  const repositories: Array<RepositoryInfo> = [];
  const totals = emptyTotals();
  const warnings: Array<string> = [];
  const notices: Array<string> = [];
  /** Worktree folders named by a main repository inside the root. */
  const listedWorktrees = new Set<string>();
  /** Relative paths of the worktree folders the walk left out, and their Git directories. */
  const skippedWorktrees: Array<string> = [];
  const skippedGitDirs: Array<string> = [];
  let rebuildableFolders = 0;
  let files = 0;
  let bytes = 0;
  let lastReport = Date.now();
  let sinceCheck = 0;
  const report = (force = false) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    options.onProgress({ files, bytes });
  };
  const checkStop = () => {
    if (options.shouldStop?.()) throw new FolderScanError("stopped");
  };
  const push = (entry: ManifestEntry) => {
    if (entries.length >= maxEntries) throw new FolderScanError("too-many-entries");
    entries.push(entry);
    if (entry.type === "file" || entry.collapsed) {
      totals[entry.class].files += entry.collapsed?.files ?? 1;
      totals[entry.class].bytes += entry.size;
    }
    if (entry.type === "file") {
      files += 1;
      bytes += entry.size;
    }
    sinceCheck += 1;
    if (sinceCheck >= 256) {
      sinceCheck = 0;
      report();
    }
  };

  /** "skipped" tells the caller to take back the folder's own entry. */
  const walk = async (
    absolute: string,
    repos: ReadonlyArray<RepoContext>,
    insideGitData: boolean,
  ): Promise<"walked" | "skipped"> => {
    checkStop();
    report();
    let children: Array<NodeFS.Dirent>;
    try {
      children = await NodeFSP.readdir(absolute, { withFileTypes: true });
    } catch (cause) {
      if (absolute === realRoot) throw new FolderScanError("unreadable", String(cause));
      warnings.push(`Could not read ${relativeOf(realRoot, absolute)}`);
      return "walked";
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let scope = repos;
    if (!insideGitData) {
      const gitChild = children.find((child) => child.name === ".git");
      // A linked worktree of a repository inside the root is not walked or read
      // with Git: its branches travel with the main repository's refs.
      if (gitChild && absolute !== realRoot && !options.keepLinkedWorktrees) {
        const gitDir = await innerWorktreeGitDir(absolute, realRoot);
        if (gitDir !== null) {
          skippedWorktrees.push(relativeOf(realRoot, absolute));
          skippedGitDirs.push(gitDir);
          return "skipped";
        }
      }
      if (gitChild) {
        try {
          const stat = await NodeFSP.lstat(NodePath.join(absolute, ".git"));
          if (stat.isDirectory() || stat.isFile()) {
            const read = await readRepository(realRoot, absolute, stat);
            const inside = read.info.worktrees.filter((tree) => tree.path !== null);
            if (!options.keepLinkedWorktrees)
              for (const tree of inside) listedWorktrees.add(NodePath.join(realRoot, tree.path!));
            repositories.push(
              inside.length > 0
                ? {
                    ...read.info,
                    worktrees: read.info.worktrees.filter((tree) => tree.path === null),
                  }
                : read.info,
            );
            if (read.info.missingWorktrees?.length)
              notices.push(
                `${read.info.path}: ${read.info.missingWorktrees.length} missing worktree registration(s), not current folders: ${read.info.missingWorktrees.join(", ")}. No registrations were removed.`,
              );
            const outside = read.info.worktrees.filter((tree) => tree.path === null);
            if (outside.length > 0)
              notices.push(
                `${read.info.path}: ${outside.length} worktree(s) outside this folder are not copied: ${outside.map((tree) => tree.name).join(", ")}. Copy those working folders separately to preserve their uncommitted changes.`,
              );
            scope = [...repos, read.context];
          }
        } catch (cause) {
          if (!(cause instanceof FolderGitError)) throw cause;
          warnings.push(
            `${relativeOf(realRoot, absolute)} has a .git entry Git cannot read; it is copied as plain files.`,
          );
        }
      }
    }
    const innermost = scope.at(-1) ?? null;
    const safe = children.map((child) =>
      isSafeRelativePath(relativeOf(realRoot, NodePath.join(absolute, child.name)), "linux"),
    );
    const stats: Array<NodeFS.Stats | null> = Array.from({ length: children.length }, () => null);
    await forEachLimited(children, STAT_CONCURRENCY, async (child, index) => {
      if (!safe[index]) return;
      stats[index] = await NodeFSP.lstat(NodePath.join(absolute, child.name)).catch(() => null);
    });
    for (const [index, child] of children.entries()) {
      const location = NodePath.join(absolute, child.name);
      const relative = relativeOf(realRoot, location);
      if (!safe[index]) {
        warnings.push(
          `Skipped an entry whose name cannot be copied safely below ${relativeOf(realRoot, absolute)}`,
        );
        continue;
      }
      const stat = stats[index];
      if (!stat) continue;
      const gitData = insideGitData || (child.name === ".git" && innermost?.absolute === absolute);
      // Git daemon sockets and transient writer locks are local runtime state,
      // never part of a portable snapshot or a reason to block later transfer.
      if (gitData && (child.name === "fsmonitor--daemon.ipc" || child.name.endsWith(".lock")))
        continue;
      const inner = innermost ? insideRepo(innermost.path, relative) : null;
      const gitState = gitData
        ? "outside"
        : innermost && inner !== null
          ? gitStateIn(innermost, inner)
          : "outside";
      const fileClass = classifyFile({ relative, insideGitData: gitData, gitState });
      const base = {
        path: relative,
        mode: stat.mode & 0o7777,
        mtimeMs: Math.trunc(stat.mtimeMs),
        repo: innermost?.path ?? null,
      };
      if (stat.isSymbolicLink()) {
        push({
          ...base,
          type: "symlink",
          size: 0,
          class: fileClass,
          target: linkTargetOnWire(await NodeFSP.readlink(location)),
        });
      } else if (stat.isFile()) {
        push({ ...base, type: "file", size: stat.size, class: fileClass });
      } else if (stat.isDirectory()) {
        if (
          !gitData &&
          !options.expandRebuildable &&
          fileClass === "rebuildable" &&
          isRebuildableDirectoryName(child.name) &&
          !(await NodeFSP.lstat(NodePath.join(location, ".git")).then(
            () => true,
            () => false,
          ))
        ) {
          // Dependencies and build output are recreated on the destination; opening
          // them would cost one stat per file (millions in a large umbrella).
          rebuildableFolders += 1;
          push({
            ...base,
            type: "directory",
            size: 0,
            class: fileClass,
            collapsed: { files: 0 },
          });
          continue;
        }
        const mark = entries.length;
        push({ ...base, type: "directory", size: 0, class: fileClass });
        if ((await walk(location, scope, gitData)) === "skipped") entries.length = mark;
      } else {
        warnings.push(`Skipped ${relative}: not a file, folder or link.`);
      }
    }
    return "walked";
  };

  await walk(realRoot, [], false);
  checkStop();
  if (skippedWorktrees.length > 0 || listedWorktrees.size > 0)
    await dropSkippedWorktrees({
      realRoot,
      entries,
      repositories,
      totals,
      folders: skippedWorktrees,
      listed: listedWorktrees,
      gitDirs: skippedGitDirs,
    });
  const gitDirOfSkipped = new Map(
    skippedWorktrees.map((folder, index) => [folder, skippedGitDirs[index]!] as const),
  );
  skippedWorktrees.sort();
  const changes =
    skippedWorktrees.length > 0
      ? await worktreeChanges(realRoot, skippedWorktrees, gitDirOfSkipped, options)
      : { dirty: [], unknown: [], stranded: [] };
  // First, so a cap on the number of notices can never drop it.
  if (skippedWorktrees.length > 0)
    notices.unshift(
      skippedWorktreesNotice(skippedWorktrees, changes.dirty, changes.unknown, changes.stranded),
    );
  // Dropped registrations were counted while listing; the totals no longer hold them.
  files = FILE_CLASSES.reduce((sum, name) => sum + totals[name].files, 0);
  bytes = FILE_CLASSES.reduce((sum, name) => sum + totals[name].bytes, 0);
  report(true);
  return {
    root: realRoot,
    entries,
    repositories,
    totals,
    warnings,
    notices,
    skipped: {
      rebuildableFolders,
      worktrees: skippedWorktrees,
      ...(skippedWorktrees.length > 0
        ? {
            dirtyWorktrees: changes.dirty,
            uncheckedWorktrees: changes.unknown,
            strandedWorktrees: changes.stranded,
          }
        : {}),
    },
  };
}

/**
 * Takes the skipped worktrees out of their main repositories: drops each one's
 * `.git/worktrees/<name>` registration (so the destination never gets a dangling
 * worktree) and the status lines that name the folder (`?? wt/` in a main checkout
 * that holds its own worktrees unignored).
 */
async function dropSkippedWorktrees(input: {
  readonly realRoot: string;
  readonly entries: Array<ManifestEntry>;
  readonly repositories: Array<RepositoryInfo>;
  readonly totals: ClassTotals;
  readonly folders: ReadonlyArray<string>;
  readonly listed: ReadonlySet<string>;
  readonly gitDirs: ReadonlyArray<string>;
}): Promise<void> {
  const { realRoot, entries, repositories, totals } = input;
  const admins = new Set<string>();
  for (const gitDir of input.gitDirs) {
    const resolved = await NodeFSP.realpath(gitDir).catch(() => gitDir);
    if (resolved.startsWith(`${realRoot}${NodePath.sep}`))
      admins.add(relativeOf(realRoot, resolved));
  }
  // Registrations of listed worktrees, found the way the portable snapshot finds
  // registrations outside the root: by the admin folder's `gitdir` pointer.
  const skippedFolders = new Set([
    ...input.listed,
    ...input.folders.map((folder) => NodePath.join(realRoot, folder)),
  ]);
  for (const info of repositories.filter((repo) => repo.kind === "main")) {
    const prefix = info.path === "." ? ".git/worktrees/" : `${info.path}/.git/worktrees/`;
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      if (!/^[^/]+\/gitdir$/.test(rest)) continue;
      const admin = entry.path.slice(0, -"/gitdir".length);
      if (admins.has(admin)) continue;
      try {
        const pointer = (
          await NodeFSP.readFile(NodePath.join(realRoot, entry.path), "utf8")
        ).trim();
        const gitFile = NodePath.resolve(NodePath.join(realRoot, admin), pointer);
        const folder = NodePath.dirname(gitFile);
        const real = await NodeFSP.realpath(folder).catch(() => folder);
        if (skippedFolders.has(folder) || skippedFolders.has(real)) admins.add(admin);
      } catch {
        // An unreadable registration stays as it was.
      }
    }
  }
  if (admins.size > 0) {
    const dropped = (path: string) => {
      for (const admin of admins) if (path === admin || path.startsWith(`${admin}/`)) return true;
      return false;
    };
    let kept = 0;
    for (const entry of entries) {
      if (dropped(entry.path)) {
        if (entry.type === "file" || entry.collapsed) {
          totals[entry.class].files -= entry.collapsed?.files ?? 1;
          totals[entry.class].bytes -= entry.size;
        }
        continue;
      }
      entries[kept] = entry;
      kept += 1;
    }
    entries.length = kept;
  }
  if (input.folders.length === 0) return;
  for (const [index, info] of repositories.entries()) {
    const repoPrefix = info.path === "." ? "" : `${info.path}/`;
    const status = info.status.filter((line) => {
      const path = `${repoPrefix}${line.slice(3).replace(/\/$/, "")}`;
      if (input.folders.some((folder) => path === folder || path.startsWith(`${folder}/`)))
        return false;
      // Git collapses `?? .worktrees/` when the folder holds only worktrees; the
      // copy has nothing in it there, so the line would never match.
      if (!input.folders.some((folder) => folder.startsWith(`${path}/`))) return true;
      return entries.some(
        (entry) =>
          entry.path.startsWith(`${path}/`) && (entry.type !== "directory" || entry.collapsed),
      );
    });
    if (status.length !== info.status.length) repositories[index] = { ...info, status };
  }
}

/** Re-lists a collapsed rebuildable folder once the person selects rebuildable files. */
export async function expandCollapsed(
  scan: FolderScan,
  options: Omit<ScanOptions, "expandRebuildable"> = {},
): Promise<FolderScan> {
  if (!scan.entries.some((entry) => entry.collapsed)) return scan;
  return scanFolder(scan.root, { ...options, expandRebuildable: true });
}

export interface HashedFile {
  readonly sha256: string;
  readonly chunks: Array<string>;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Reads a file through a no-follow descriptor, hashing the whole and each 8 MiB chunk. */
export async function hashFile(absolute: string, requireStable = true): Promise<HashedFile> {
  const handle = await NodeFSP.open(
    absolute,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new FolderScanError("unreadable", "not a regular file");
    const whole = NodeCrypto.createHash("sha256");
    const chunks: Array<string> = [];
    let chunk = NodeCrypto.createHash("sha256");
    let inChunk = 0;
    const buffer = Buffer.allocUnsafe(READ_BUFFER);
    let position = 0;
    for (;;) {
      const want = Math.min(READ_BUFFER, CHUNK_SIZE - inChunk);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      const slice = buffer.subarray(0, bytesRead);
      whole.update(slice);
      chunk.update(slice);
      inChunk += bytesRead;
      position += bytesRead;
      if (inChunk === CHUNK_SIZE) {
        chunks.push(chunk.digest("hex"));
        chunk = NodeCrypto.createHash("sha256");
        inChunk = 0;
      }
    }
    if (inChunk > 0 || chunks.length === 0) chunks.push(chunk.digest("hex"));
    const after = await handle.stat();
    if (requireStable && (after.size !== position || after.mtimeMs !== before.mtimeMs))
      throw new FileChangedError(absolute);
    return {
      sha256: whole.digest("hex"),
      chunks,
      size: position,
      mtimeMs: Math.trunc(after.mtimeMs),
    };
  } finally {
    await handle.close();
  }
}

export class FileChangedError extends Error {
  readonly absolute: string;
  constructor(absolute: string) {
    super("The file changed while it was read.");
    this.absolute = absolute;
  }
}

/**
 * Runs `work` over `items` with at most `limit` in flight. On the first failure no
 * worker takes another item, and the call rejects with that failure only after
 * every item already in flight settled, so a caller's cleanup or retry never
 * races a stale worker.
 */
export async function forEachLimited<T>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await work(items[index]!, index);
      } catch (cause) {
        if (!failed) {
          failed = true;
          failure = cause;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}

/**
 * Hashes the selected files in place. A file that keeps changing while it is read
 * is retried twice, then copied as last read and marked unstable for the preview.
 */
export async function hashSelected(
  scan: FolderScan,
  selection: ReadonlySet<FileClass>,
  onProgress?: (done: { files: number; bytes: number }) => void,
  rootForEntry: (entry: ManifestEntry) => string = () => scan.root,
): Promise<void> {
  const targets = scan.entries.filter(
    (entry) => entry.type === "file" && selection.has(entry.class) && entry.sha256 === undefined,
  );
  let files = 0;
  let bytes = 0;
  await forEachLimited(targets, HASH_CONCURRENCY, async (entry) => {
    const absolute = NodePath.join(rootForEntry(entry), entry.path);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const hashed = await hashFile(absolute, attempt < 2);
        entry.sha256 = hashed.sha256;
        entry.chunks = hashed.chunks;
        entry.size = hashed.size;
        entry.mtimeMs = hashed.mtimeMs;
        if (attempt === 2) entry.unstable = true;
        break;
      } catch (cause) {
        if (cause instanceof FileChangedError) continue;
        throw cause;
      }
    }
    files += 1;
    bytes += entry.size;
    onProgress?.({ files, bytes });
  });
}

export interface ManifestHeader {
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
  readonly version: 1;
  readonly operationId: string;
  readonly chunkSize: number;
  readonly selection: ReadonlyArray<FileClass>;
  readonly repositories: ReadonlyArray<RepositoryInfo>;
  readonly totals: ClassTotals;
  readonly warnings: ReadonlyArray<string>;
  readonly entryCount: number;
}

export interface Manifest {
  readonly header: ManifestHeader;
  readonly entries: ReadonlyArray<ManifestEntry>;
}

/** Entries the destination receives: selected classes, plus the folders that hold them. */
export function selectEntries(
  entries: ReadonlyArray<ManifestEntry>,
  selection: ReadonlySet<FileClass>,
): Array<ManifestEntry> {
  const needed = new Set<string>();
  for (const entry of entries) {
    if (!selection.has(entry.class) || entry.collapsed) continue;
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      needed.add(parts.slice(0, index).join("/"));
    if (entry.type === "directory") needed.add(entry.path);
  }
  return entries.filter((entry) =>
    entry.type === "directory"
      ? needed.has(entry.path) && !entry.collapsed
      : selection.has(entry.class),
  );
}

/** Gzipped NDJSON: a header line, then one line per entry. Streams for large folders. */
export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const gzip = NodeZlib.createGzip();
  const out = NodeFS.createWriteStream(temporary, { mode: 0o600, flags: "wx" });
  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gzip.on("error", reject);
  });
  gzip.pipe(out);
  const write = (line: string) =>
    new Promise<void>((resolve) => {
      if (gzip.write(`${line}\n`)) resolve();
      else gzip.once("drain", resolve);
    });
  await write(JSON.stringify(manifest.header));
  for (const entry of manifest.entries) await write(JSON.stringify(entry));
  gzip.end();
  await done;
  await NodeFSP.rename(temporary, file);
}

export async function readManifestBytes(bytes: Uint8Array): Promise<unknown[]> {
  const text = NodeZlib.gunzipSync(bytes).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

export async function readManifestFile(file: string): Promise<Manifest> {
  const [header, ...entries] = await readManifestBytes(await NodeFSP.readFile(file));
  return { header: header as ManifestHeader, entries: entries as Array<ManifestEntry> };
}
