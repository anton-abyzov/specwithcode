// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - operation-owned Git snapshots never modify the source repository; stops are polled.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { privateDirectory } from "./durable.ts";
import { FolderGitError, runGit } from "./git.ts";
import {
  emptyTotals,
  FolderScanError,
  forEachLimited,
  scanFolder,
  type FolderScan,
  type ManifestEntry,
  type RepositoryInfo,
} from "./manifest.ts";

/** Files copied at once inside one folder; Git stores thousands of small files. */
const COPY_CONCURRENCY = 16;
/** Whole-repository snapshot attempts, with the pause before each retry. */
const SNAPSHOT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 2_000];
/** How often a running Git command checks the stop request. */
const STOP_POLL_MS = 200;
const PROGRESS_INTERVAL_MS = 250;
/** Clone on copy-on-write file systems (Btrfs, XFS); a plain copy elsewhere. */
const CLONE = NodeFS.constants.COPYFILE_FICLONE;
/**
 * Node cannot clone on macOS (libuv answers ENOSYS), so larger files are cloned
 * with `cp -c` (clonefile): a 200 MB pack takes milliseconds instead of seconds.
 */
const MAC_CLONE_MIN_BYTES = 1024 * 1024;
const MAC_CLONE_MAX_FAILURES = 3;

export interface PrepareOptions {
  /** Checked between repositories and copies; true stops with a "stopped" FolderScanError. */
  readonly shouldStop?: () => boolean;
  /** Git files and bytes copied into the snapshot so far, at most every 250 ms. */
  readonly onProgress?: (progress: { readonly files: number; readonly bytes: number }) => void;
  /**
   * Test seam: runs once per object database after its loose objects are copied
   * and its packs are first listed, before any pack is copied.
   */
  readonly beforePackCopy?: (sourceGitDir: string) => Promise<void> | void;
}

interface CopyContext {
  readonly signal: AbortSignal;
  /** `cp -c` failures so far; cloning stops after a few (another volume, no APFS). */
  cloneFailures: number;
  readonly checkStop: () => void;
  readonly copied: (bytes: number) => void;
  /** Reports the final count, whatever the throttle. */
  readonly flush: () => void;
  readonly beforePackCopy?: (sourceGitDir: string) => Promise<void> | void;
}

const vanished = (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * A ref or log that turned into a folder after it was listed (branch `x` deleted,
 * `x/y` created): the listed file is gone.
 */
const becameFolder = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.code === "EISDIR";

/**
 * Git changed the refs while they were copied in a way the copy order cannot
 * absorb: a ref Git kept throughout, or the commit HEAD names, is missing from
 * the snapshot. The whole repository is taken again.
 */
class SnapshotRefsChanged extends Error {}

function copyContext(options: PrepareOptions, signal: AbortSignal): CopyContext {
  let files = 0;
  let bytes = 0;
  let lastReport = 0;
  return {
    signal,
    cloneFailures: process.platform === "darwin" ? 0 : MAC_CLONE_MAX_FAILURES,
    checkStop: () => {
      if (signal.aborted || options.shouldStop?.()) throw new FolderScanError("stopped");
    },
    copied: (size) => {
      files += 1;
      bytes += size;
      const now = Date.now();
      if (!options.onProgress || now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      options.onProgress({ files, bytes });
    },
    flush: () => options.onProgress?.({ files, bytes }),
    ...(options.beforePackCopy ? { beforePackCopy: options.beforePackCopy } : {}),
  };
}

/**
 * Copies one regular Git file. Following a planted link could expose unrelated
 * files, so links are refused. Returns false when an optional file vanished
 * (Git deleted a ref, a log or a removed worktree's file after it was listed).
 */
async function copyGitFile(
  context: CopyContext,
  source: string,
  target: string,
  required = false,
): Promise<boolean> {
  context.checkStop();
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.lstat(source);
  } catch (cause) {
    if (vanished(cause) && !required) return false;
    throw cause;
  }
  if (stat.isSymbolicLink()) throw new Error(`Git metadata contains a symbolic link: ${source}`);
  // Listed as a file, now a folder: the listed file vanished (branch `x` became `x/y`).
  if (stat.isDirectory() && !required) return false;
  if (!stat.isFile()) throw new Error(`Git metadata is not a regular file or folder: ${source}`);
  try {
    if (!(stat.size >= MAC_CLONE_MIN_BYTES && (await macClone(context, source, target))))
      await NodeFSP.copyFile(source, target, CLONE);
  } catch (cause) {
    if ((vanished(cause) || becameFolder(cause)) && !required) {
      await NodeFSP.rm(target, { force: true });
      return false;
    }
    throw cause;
  }
  // copyFile keeps the source's permission bits (libuv sets them on the copy).
  context.copied(stat.size);
  return true;
}

/** Clones with `cp -c -p` on macOS; false (and nothing written) when that did not work. */
async function macClone(context: CopyContext, source: string, target: string): Promise<boolean> {
  if (context.cloneFailures >= MAC_CLONE_MAX_FAILURES) return false;
  const cloned = await new Promise<boolean>((resolve) => {
    NodeChildProcess.execFile(
      "/bin/cp",
      ["-c", "-p", "--", source, target],
      { signal: context.signal, timeout: 60_000 },
      (error) => resolve(!error),
    );
  });
  if (cloned) return true;
  context.checkStop();
  // A source Git deleted meanwhile is not a reason to stop cloning.
  if (
    await NodeFSP.lstat(source).then(
      () => true,
      () => false,
    )
  )
    context.cloneFailures += 1;
  await NodeFSP.rm(target, { force: true });
  return false;
}

interface TreeOptions {
  /** Top-level files that must exist (HEAD, config); any other file may vanish. */
  readonly required?: ReadonlySet<string>;
  /** Relative paths left out of the snapshot. */
  readonly skip?: (relative: string, isDirectory: boolean) => boolean;
}

/** Lists a folder, or null when Git removed it. */
async function listFolder(folder: string): Promise<Array<NodeFS.Dirent> | null> {
  try {
    return await NodeFSP.readdir(folder, { withFileTypes: true });
  } catch (cause) {
    if (vanished(cause)) return null;
    throw cause;
  }
}

interface CopyJob {
  readonly source: string;
  readonly target: string;
  readonly required: boolean;
}

/**
 * Copies Git metadata as it is now: lists the tree first (creating its folders),
 * then copies every file in one pool, so folders of a few refs each do not copy
 * one file at a time. Every `packed-refs` file is copied afterwards, in a later
 * step: Git writes packed-refs before deleting the loose refs it packed, so a
 * loose ref that vanishes during the first step is in the packed-refs copied
 * after it. Transient writer locks and the monitor socket are skipped; folders
 * and files that vanish meanwhile are dropped. A submodule's object folder is
 * copied in the repack-safe order of `copyObjects`.
 */
async function copyGitTree(
  context: CopyContext,
  source: string,
  target: string,
  options: TreeOptions = {},
): Promise<void> {
  context.checkStop();
  const stat = await NodeFSP.lstat(source).catch((cause: unknown) => {
    if (vanished(cause)) return null;
    throw cause;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Git metadata contains a symbolic link: ${source}`);
  if (!stat.isDirectory()) {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
    await copyGitFile(context, source, target, false);
    return;
  }
  const jobs: Array<CopyJob> = [];
  const folders: Array<{ readonly target: string; readonly mode: number }> = [];
  const objectStores: Array<CopyJob> = [];
  const list = async (from: string, to: string, relative: string, mode: number) => {
    context.checkStop();
    const children = await listFolder(from);
    if (!children) return;
    await NodeFSP.mkdir(to, { recursive: true, mode: 0o700 });
    folders.push({ target: to, mode });
    for (const child of children) {
      if (child.name.endsWith(".lock") || child.name === "fsmonitor--daemon.ipc") continue;
      const path = relative ? `${relative}/${child.name}` : child.name;
      if (options.skip?.(path, child.isDirectory())) continue;
      const childSource = NodePath.join(from, child.name);
      const childTarget = NodePath.join(to, child.name);
      if (!child.isDirectory()) {
        jobs.push({
          source: childSource,
          target: childTarget,
          required: options.required?.has(path) ?? false,
        });
        continue;
      }
      if (
        child.name === "objects" &&
        path.startsWith("modules/") &&
        children.some((sibling) => sibling.name === "HEAD" && sibling.isFile())
      ) {
        objectStores.push({ source: childSource, target: childTarget, required: false });
        continue;
      }
      const childStat = await NodeFSP.lstat(childSource).catch(() => null);
      if (childStat?.isDirectory()) await list(childSource, childTarget, path, childStat.mode);
    }
  };
  await list(source, target, "", stat.mode);
  const packedRefs = (job: CopyJob) => NodePath.basename(job.source) === "packed-refs";
  for (const phase of [jobs.filter((job) => !packedRefs(job)), jobs.filter(packedRefs)])
    await forEachLimited(phase, COPY_CONCURRENCY, async (job) => {
      await copyGitFile(context, job.source, job.target, job.required);
    });
  for (const store of objectStores) await copyObjects(context, store.source, store.target);
  for (const folder of folders.reverse()) await NodeFSP.chmod(folder.target, folder.mode & 0o777);
}

/** Pack files that travel with their `.pack` and `.idx`. */
const PACK_COMPANIONS = [".rev", ".bitmap", ".keep", ".promisor", ".mtimes"];

/**
 * Copies an object database so a concurrent repack or gc cannot leave it
 * incomplete: loose objects first (a gc packs them before pruning them), then
 * every complete pack, then any pack that appeared meanwhile (a repack writes new
 * packs before deleting the old ones). Caches that can name vanished packs or
 * commits (commit-graph, multi-pack-index) are left out; Git works without them.
 */
async function copyObjects(context: CopyContext, source: string, target: string): Promise<void> {
  context.checkStop();
  await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
  const children = await listFolder(source);
  if (!children) return;
  // Loose objects, listed folder by folder, then copied in one pool.
  const loose: Array<CopyJob> = [];
  for (const child of children) {
    if (!child.isDirectory() || !/^[0-9a-f]{2}$/.test(child.name)) continue;
    context.checkStop();
    const names = await listFolder(NodePath.join(source, child.name));
    if (!names) continue;
    const folder = NodePath.join(target, child.name);
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    for (const name of names)
      if (!name.isDirectory() && /^[0-9a-f]+$/.test(name.name))
        loose.push({
          source: NodePath.join(source, child.name, name.name),
          target: NodePath.join(folder, name.name),
          required: false,
        });
  }
  await forEachLimited(loose, COPY_CONCURRENCY, async (job) => {
    await copyGitFile(context, job.source, job.target);
  });
  await copyGitTree(context, NodePath.join(source, "info"), NodePath.join(target, "info"), {
    skip: (relative) =>
      relative === "commit-graph" || relative === "commit-graphs" || relative === "packs",
  });
  const done = new Set<string>();
  for (let pass = 0; pass < 2; pass += 1) {
    const names = await listFolder(NodePath.join(source, "pack"));
    if (!names) continue;
    if (pass === 0) await context.beforePackCopy?.(NodePath.dirname(source));
    const present = new Set(names.filter((name) => name.isFile()).map((name) => name.name));
    const packs = [...present]
      .filter((name) => /^pack-[0-9a-f]+\.pack$/.test(name))
      .map((name) => name.slice(0, -".pack".length))
      .filter((base) => present.has(`${base}.idx`) && !done.has(base));
    if (packs.length === 0) continue;
    const folder = NodePath.join(target, "pack");
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    await forEachLimited(packs, 4, async (base) => {
      const from = (extension: string) => NodePath.join(source, "pack", `${base}${extension}`);
      const to = (extension: string) => NodePath.join(folder, `${base}${extension}`);
      const pack = await copyGitFile(context, from(".pack"), to(".pack"));
      const index = pack && (await copyGitFile(context, from(".idx"), to(".idx")));
      if (!pack || !index) {
        // Deleted by a repack while it was read; its objects are in a newer pack.
        for (const extension of [".pack", ".idx"]) await NodeFSP.rm(to(extension), { force: true });
        return;
      }
      done.add(base);
      for (const extension of PACK_COMPANIONS)
        await copyGitFile(context, from(extension), to(extension));
    });
  }
}

/** Waits, unless a stop is requested first. */
async function pause(context: CopyContext, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    context.checkStop();
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
  context.checkStop();
}

const transientSnapshotError = (cause: unknown) =>
  cause instanceof FolderGitError || cause instanceof SnapshotRefsChanged || vanished(cause);

function snapshotFailureDetail(cause: unknown): string {
  if (cause instanceof SnapshotRefsChanged) return cause.message;
  if (cause instanceof FolderGitError) {
    const line = cause.stderr.split("\n").find((item) => item.trim()) ?? "";
    return `${cause.message}${line ? `: ${line.trim().slice(0, 200)}` : ""}`;
  }
  const path = (cause as NodeJS.ErrnoException).path;
  return path ? `${path} disappeared` : String(cause);
}

/**
 * Takes one repository's snapshot from scratch, again with a fresh listing while
 * Git keeps changing it, up to three times. Only then fails, naming the repository.
 */
async function withSnapshotRetries(
  context: CopyContext,
  repository: string,
  take: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await take();
      return;
    } catch (cause) {
      // A stop kills a running Git command; report it as the stop it was.
      context.checkStop();
      if (!transientSnapshotError(cause)) throw cause;
      if (attempt >= SNAPSHOT_ATTEMPTS)
        throw new Error(
          `Could not prepare a self-contained Git snapshot of ${repository === "." ? "the folder's repository" : `repository "${repository}"`}: Git kept changing it while it was read (${snapshotFailureDetail(cause)}). Retry the copy; source files were not changed.`,
        );
      await pause(context, RETRY_BACKOFF_MS[attempt - 1] ?? 2_000);
    }
  }
}

/** Resolve object dependencies into the private copy, without copying another working folder. */
async function materializeAlternates(
  context: CopyContext,
  common: string,
  targetGit: string,
  target: string,
) {
  const alternates = NodePath.join(targetGit, "objects/info/alternates");
  if (!(await NodeFSP.lstat(alternates).catch(() => null))) return;
  const original = NodePath.join(common, "objects");
  const lines = (await NodeFSP.readFile(alternates, "utf8")).split("\n").filter(Boolean);
  await NodeFSP.writeFile(
    alternates,
    lines.map((line) => NodePath.resolve(original, line)).join("\n") + "\n",
  );
  await runGit(target, ["repack", "-a", "-d"], { signal: context.signal });
  await NodeFSP.unlink(alternates);
}

/** Shown with any repository: the Git snapshot is taken when copying starts, not while measuring. */
export const PORTABLE_GIT_NOTICE =
  "Git history, branches and staged changes are captured when copying starts. Work created afterward stays on this machine; copy again to include it.";

/** Paths in the manifest stay relative; only a source-owned marker selects the private overlay. */
export function sourceEntryRoot(folder: string, snapshotRoot: string, entry: ManifestEntry) {
  return entry.portableGit ? snapshotRoot : folder;
}

const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
  "rebase-merge",
  "rebase-apply",
];

/** Repositories that become independent Git repositories in the snapshot. */
const externalRepositories = (scan: FolderScan) =>
  scan.repositories.filter(
    (repo) => (repo.kind === "linked" && repo.mainRepository === null) || repo.kind === "gitfile",
  );

async function refuseInProgressOperation(info: { readonly path: string }, gitDir: string) {
  for (const marker of IN_PROGRESS_MARKERS)
    if (await NodeFSP.lstat(NodePath.join(gitDir, marker)).catch(() => null))
      throw new Error(
        `${info.path}: finish or abort the in-progress Git merge, rebase or cherry-pick before copying this external worktree. Ordinary uncommitted changes can be copied.`,
      );
}

/**
 * The quick part of preparing, for measuring: refuses an external worktree in
 * the middle of a merge, rebase or cherry-pick (it cannot become an independent
 * repository) without copying any Git data.
 */
export async function checkPortableGit(scan: FolderScan): Promise<void> {
  for (const info of externalRepositories(scan)) {
    const gitDir = (
      await runGit(NodePath.join(scan.root, info.path === "." ? "" : info.path), [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ])
    ).stdout.trim();
    await refuseInProgressOperation(info, gitDir);
  }
}

/**
 * Freezes each repository's Git data into the operation's private snapshot and
 * returns the scan with snapshot entries in place of the live ones. Git metadata
 * is listed when copying starts, not taken from the measured listing, so refs,
 * logs and worktrees Git removed meanwhile are simply absent.
 */
export async function preparePortableGit(
  scan: FolderScan,
  snapshotRoot: string,
  options: PrepareOptions = {},
): Promise<FolderScan> {
  const controller = new AbortController();
  const poll = setInterval(() => {
    if (options.shouldStop?.()) controller.abort();
  }, STOP_POLL_MS);
  poll.unref?.();
  try {
    const context = copyContext(options, controller.signal);
    const prepared = await prepareOnce(scan, snapshotRoot, context, options);
    context.flush();
    return prepared;
  } finally {
    clearInterval(poll);
  }
}

const gitDirOf = async (context: CopyContext, folder: string, flag: string) =>
  NodePath.resolve(
    (
      await runGit(folder, ["rev-parse", "--path-format=absolute", flag], {
        signal: context.signal,
      })
    ).stdout.trim(),
  );

/**
 * Worktree admin folders (`.git/worktrees/<name>`) the snapshot keeps: only those
 * of linked worktrees the copy carries. Skipped worktrees, worktrees outside the
 * root, stale registrations and ones added after measuring would arrive dangling.
 */
async function carriedAdmins(
  scan: FolderScan,
  info: RepositoryInfo,
  sourceGit: string,
): Promise<Set<string>> {
  const carried = new Set(
    scan.repositories
      .filter((repo) => repo.kind === "linked" && repo.mainRepository === info.path)
      .map((repo) => repo.path),
  );
  const kept = new Set<string>();
  if (carried.size === 0) return kept;
  for (const child of (await listFolder(NodePath.join(sourceGit, "worktrees"))) ?? []) {
    if (!child.isDirectory()) continue;
    const admin = NodePath.join(sourceGit, "worktrees", child.name);
    const pointer = await NodeFSP.readFile(NodePath.join(admin, "gitdir"), "utf8").catch(
      () => null,
    );
    if (pointer === null) continue;
    const folder = NodePath.dirname(NodePath.resolve(admin, pointer.trim()));
    const real = await NodeFSP.realpath(folder).catch(() => folder);
    for (const candidate of [folder, real]) {
      const relative = NodePath.relative(scan.root, candidate).split(NodePath.sep).join("/");
      if (carried.has(relative)) kept.add(child.name);
    }
  }
  return kept;
}

interface RefReading {
  /** Ref name to object name, as `git for-each-ref` lists them. */
  readonly refs: ReadonlyMap<string, string>;
  /** The commit HEAD resolves to, or null when it does not resolve. */
  readonly head: string | null;
}

async function readRefs(context: CopyContext, folder: string): Promise<RefReading> {
  const git = (args: ReadonlyArray<string>, allowFailure = false) =>
    runGit(folder, args, { signal: context.signal, allowFailure });
  const refs = new Map<string, string>();
  for (const line of (await git(["for-each-ref", "--format=%(refname) %(objectname)"])).stdout
    .split("\n")
    .filter(Boolean)) {
    const space = line.lastIndexOf(" ");
    refs.set(line.slice(0, space), line.slice(space + 1));
  }
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], true);
  return { refs, head: head.code === 0 ? head.stdout.trim() : null };
}

/**
 * Checks the snapshot against the source's refs read before listing and again
 * after copying. A ref present in both readings must be in the snapshot; a commit
 * some ref named in both readings must be named by a snapshot ref (a rename while
 * copying would otherwise lose it under both names); and HEAD must resolve when
 * the source's did both times. Anything else Git changed meanwhile is accepted as
 * the moment the snapshot was taken.
 */
async function checkSnapshotRefs(
  context: CopyContext,
  before: RefReading,
  after: RefReading,
  snapshot: string,
): Promise<void> {
  const taken = await readRefs(context, snapshot);
  const named = new Set(taken.refs.values());
  if (taken.head) named.add(taken.head);
  const afterObjects = new Set(after.refs.values());
  for (const [name, object] of before.refs) {
    if (after.refs.has(name) && !taken.refs.has(name))
      throw new SnapshotRefsChanged(`${name} went missing while it was copied`);
    if (afterObjects.has(object) && !named.has(object))
      throw new SnapshotRefsChanged(
        `commit ${object.slice(0, 12)} lost its ref while it was copied`,
      );
  }
  if (before.head && after.head && !taken.head)
    throw new SnapshotRefsChanged("HEAD stopped resolving while it was copied");
}

/**
 * One main repository's snapshot: metadata as listed now (HEAD and config must
 * exist), then objects in repack-safe order, then the carried worktrees'
 * relative pointers, then a connectivity check of the frozen result.
 */
async function snapshotMain(
  context: CopyContext,
  scan: FolderScan,
  info: RepositoryInfo,
  snapshotRoot: string,
): Promise<void> {
  const prefix = info.path === "." ? ".git" : `${info.path}/.git`;
  const sourceGit = NodePath.join(scan.root, prefix);
  const targetGit = NodePath.join(snapshotRoot, prefix);
  await NodeFSP.rm(targetGit, { recursive: true, force: true });
  const sourceFolder = NodePath.join(scan.root, info.path === "." ? "" : info.path);
  const before = await readRefs(context, sourceFolder);
  const admins = await carriedAdmins(scan, info, sourceGit);
  await copyGitTree(context, sourceGit, targetGit, {
    required: new Set(["HEAD", "config"]),
    skip: (relative, isDirectory) =>
      relative === "objects" ||
      (isDirectory &&
        relative.startsWith("worktrees/") &&
        !relative.slice("worktrees/".length).includes("/") &&
        !admins.has(relative.slice("worktrees/".length))),
  });
  const after = await readRefs(context, sourceFolder);
  // Objects AFTER all HEAD/index/refs/reflogs are frozen: every object they
  // name existed before they were written.
  await copyObjects(
    context,
    NodePath.join(sourceGit, "objects"),
    NodePath.join(targetGit, "objects"),
  );
  await materializeAlternates(context, sourceGit, targetGit, NodePath.dirname(targetGit));
  // Internal worktrees retain their relationship using deterministic relative
  // pointers. They never read the original Mac admin directory during checks.
  for (const linked of scan.repositories.filter(
    (repo) => repo.kind === "linked" && repo.mainRepository === info.path,
  )) {
    context.checkStop();
    const gitDir = await gitDirOf(context, NodePath.join(scan.root, linked.path), "--git-dir");
    const main = NodePath.join(snapshotRoot, info.path);
    const admin = NodePath.join(main, ".git", "worktrees", NodePath.basename(gitDir));
    const folder = NodePath.join(snapshotRoot, linked.path);
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(admin, { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(
      NodePath.join(folder, ".git"),
      `gitdir: ${NodePath.relative(folder, admin)}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(admin, "gitdir"),
      `${NodePath.relative(admin, NodePath.join(folder, ".git"))}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(admin, "commondir"),
      `${NodePath.relative(admin, NodePath.join(main, ".git"))}\n`,
    );
  }
  context.checkStop();
  await runGit(
    NodePath.join(snapshotRoot, info.path),
    ["fsck", "--connectivity-only", "--no-progress"],
    { signal: context.signal },
  );
  await checkSnapshotRefs(context, before, after, NodePath.join(snapshotRoot, info.path));
}

/**
 * An out-of-scope linked worktree (or a `.git` file repository) becomes a
 * self-contained repository: its index/HEAD and the common object/ref database,
 * never sibling worktrees, hooks, credentials, or machine-specific
 * common-dir/config pointers.
 */
async function snapshotExternal(
  context: CopyContext,
  scan: FolderScan,
  info: RepositoryInfo,
  snapshotRoot: string,
): Promise<void> {
  const relative = info.path === "." ? "" : info.path;
  const source = NodePath.join(scan.root, relative);
  const target = NodePath.join(snapshotRoot, relative);
  const targetGit = NodePath.join(target, ".git");
  const common = await gitDirOf(context, source, "--git-common-dir");
  const worktree = await gitDirOf(context, source, "--git-dir");
  await refuseInProgressOperation(info, worktree);
  await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
  // Rebuild only this exact operation-owned overlay, never the selected source.
  await NodeFSP.rm(targetGit, { recursive: true, force: true });
  const git = (cwd: string, args: ReadonlyArray<string>, allowFailure = false) =>
    runGit(cwd, args, { signal: context.signal, allowFailure });
  const format = (await git(source, ["rev-parse", "--show-object-format"])).stdout.trim();
  const before = await readRefs(context, source);
  await git(target, ["init", "-q", `--object-format=${format}`, "--template="]);
  for (const name of [
    "refs",
    "logs/refs",
    "packed-refs",
    "shallow",
    "info/exclude",
    "info/sparse-checkout",
  ])
    await copyGitTree(context, NodePath.join(common, name), NodePath.join(targetGit, name));
  for (const name of ["HEAD", "index", "logs/HEAD", "refs", "ORIG_HEAD", "info/sparse-checkout"])
    await copyGitTree(context, NodePath.join(worktree, name), NodePath.join(targetGit, name));
  const after = await readRefs(context, source);
  for (const key of [
    "core.fileMode",
    "core.symlinks",
    "core.sparseCheckout",
    "core.sparseCheckoutCone",
    "index.sparse",
  ]) {
    const setting = await git(source, ["config", "--bool", "--get", key], true);
    if (setting.code === 0) await git(target, ["config", key, setting.stdout.trim()]);
  }
  // Split indexes can refer to a shared index in either Git directory.
  for (const directory of new Set([common, worktree]))
    for (const name of await NodeFSP.readdir(directory))
      if (/^sharedindex\.[a-f0-9]+$/.test(name))
        await copyGitFile(context, NodePath.join(directory, name), NodePath.join(targetGit, name));
  if (info.origin) await git(target, ["config", "remote.origin.url", info.origin]);
  await git(target, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await copyObjects(context, NodePath.join(common, "objects"), NodePath.join(targetGit, "objects"));
  await materializeAlternates(context, common, targetGit, target);
  if (await NodeFSP.lstat(NodePath.join(targetGit, "index")).catch(() => null))
    await git(target, ["update-index", "--no-split-index"]);
  context.checkStop();
  await git(target, ["fsck", "--connectivity-only", "--no-progress"]);
  await checkSnapshotRefs(context, before, after, target);
}

async function prepareOnce(
  scan: FolderScan,
  snapshotRoot: string,
  context: CopyContext,
  options: PrepareOptions,
): Promise<FolderScan> {
  const mains = scan.repositories.filter((repo) => repo.kind === "main");
  const external = externalRepositories(scan);
  const shouldStop = () => context.signal.aborted || (options.shouldStop?.() ?? false);
  let entries = [...scan.entries];
  const repositories = [...scan.repositories];
  const notices = [...(scan.notices ?? [])];
  if (mains.length > 0 || external.length > 0) notices.push(PORTABLE_GIT_NOTICE);
  if (external.length > 0 || mains.length > 0) await privateDirectory(snapshotRoot);
  // Freeze each repository's metadata before listing its objects. A later commit
  // may publish a new ref, but the transfer keeps the matching earlier ref and
  // object graph rather than refreshing only half of the repository.
  for (const info of mains) {
    context.checkStop();
    await withSnapshotRetries(context, info.path, () =>
      snapshotMain(context, scan, info, snapshotRoot),
    );
  }
  for (const info of external) {
    context.checkStop();
    const relative = info.path === "." ? "" : info.path;
    await withSnapshotRetries(context, info.path, () =>
      snapshotExternal(context, scan, info, snapshotRoot),
    );
    const materialized = await scanFolder(NodePath.join(snapshotRoot, relative), {
      shouldStop,
      keepLinkedWorktrees: true,
    });
    const prefix = relative ? `${relative}/.git` : ".git";
    entries = entries.filter(
      (entry) => entry.path !== prefix && !entry.path.startsWith(`${prefix}/`),
    );
    entries.push(
      ...materialized.entries
        .filter((entry) => entry.path === ".git" || entry.path.startsWith(".git/"))
        .map((entry) => ({
          ...entry,
          path: relative ? `${relative}/${entry.path}` : entry.path,
          repo: info.path,
          portableGit: true,
        })),
    );
    repositories[repositories.indexOf(info)] = {
      ...info,
      kind: "main",
      worktrees: [],
      mainRepository: null,
    };
    notices.push(
      `${info.path}: this worktree will become an independent Git repository, preserving its branch, staged changes, history and stashes. Other working folders are not copied.`,
    );
  }
  if (mains.length > 0) {
    // Manifest entries come from the frozen snapshot, so they always match what was copied.
    const frozen = await scanFolder(snapshotRoot, { shouldStop, keepLinkedWorktrees: true });
    const mainGitPaths = mains.map((info) => (info.path === "." ? ".git" : `${info.path}/.git`));
    const linkedPaths = scan.repositories
      .filter((repo) => repo.kind === "linked" && repo.mainRepository !== null)
      .map((repo) => `${repo.path}/.git`);
    const belongs = (relative: string) =>
      linkedPaths.includes(relative) ||
      mainGitPaths.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
    entries = entries.filter((entry) => !belongs(entry.path));
    entries.push(
      ...frozen.entries
        .filter((entry) => belongs(entry.path))
        .map((entry) => ({ ...entry, portableGit: true })),
    );
    for (const info of frozen.repositories) {
      const index = repositories.findIndex((repo) => repo.path === info.path);
      if (index < 0) continue;
      const previous = repositories[index]!;
      repositories[index] = {
        ...previous,
        head: info.head,
        branch: info.branch,
        branches: info.branches,
        stash: info.stash,
        stashCount: info.stashCount,
      };
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = emptyTotals();
  for (const entry of entries)
    if (entry.type === "file" || entry.collapsed) {
      totals[entry.class].files += entry.collapsed?.files ?? 1;
      totals[entry.class].bytes += entry.size;
    }
  return { ...scan, entries, repositories, totals, notices };
}
