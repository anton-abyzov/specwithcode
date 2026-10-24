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
  /** For linked worktrees: the main repository's path relative to the root, or null outside it. */
  readonly mainRepository: string | null;
}

export type ClassTotals = Record<FileClass, { files: number; bytes: number }>;

export interface FolderScan {
  readonly root: string;
  readonly entries: Array<ManifestEntry>;
  readonly repositories: Array<RepositoryInfo>;
  readonly totals: ClassTotals;
  readonly warnings: Array<string>;
  /** Informational scope/portability notes, not incomplete-snapshot warnings. */
  readonly notices?: Array<string>;
}

export class FolderScanError extends Error {
  readonly reason: "not-a-folder" | "too-many-entries" | "unreadable" | "git-failed";
  constructor(reason: FolderScanError["reason"], detail?: string) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

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
  if (kind === "main") {
    const listing = (await runGit(absolute, ["worktree", "list", "--porcelain"])).stdout;
    const realRoot = await NodeFSP.realpath(root);
    for (const block of listing.split("\n\n")) {
      const line = block.split("\n").find((item) => item.startsWith("worktree "));
      if (!line) continue;
      const location = fromGit(line.slice("worktree ".length));
      if (location === absolute || location === (await NodeFSP.realpath(absolute))) continue;
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

async function sizeOfTree(absolute: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const pending = [absolute];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let children: Array<NodeFS.Dirent>;
    try {
      children = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const location = NodePath.join(directory, child.name);
      if (child.isDirectory()) pending.push(location);
      else if (child.isFile()) {
        files += 1;
        try {
          bytes += (await NodeFSP.lstat(location)).size;
        } catch {
          // Gone while counting: the count is an estimate for the selection screen.
        }
      }
    }
  }
  return { files, bytes };
}

/**
 * Lists the folder without following any link: every entry's path, type, mode,
 * size and mtime, each file's class, and each repository's refs, status and
 * worktrees. Rebuildable ignored folders are counted, not listed, until selected.
 */
export async function scanFolder(
  root: string,
  options: { readonly expandRebuildable?: boolean; readonly maxEntries?: number } = {},
): Promise<FolderScan> {
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
  const push = (entry: ManifestEntry) => {
    if (entries.length >= maxEntries) throw new FolderScanError("too-many-entries");
    entries.push(entry);
    if (entry.type === "file" || entry.collapsed) {
      totals[entry.class].files += entry.collapsed?.files ?? 1;
      totals[entry.class].bytes += entry.size;
    }
  };

  const walk = async (
    absolute: string,
    repos: ReadonlyArray<RepoContext>,
    insideGitData: boolean,
  ): Promise<void> => {
    let children: Array<NodeFS.Dirent>;
    try {
      children = await NodeFSP.readdir(absolute, { withFileTypes: true });
    } catch (cause) {
      if (absolute === realRoot) throw new FolderScanError("unreadable", String(cause));
      warnings.push(`Could not read ${relativeOf(realRoot, absolute)}`);
      return;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let scope = repos;
    if (!insideGitData) {
      const gitChild = children.find((child) => child.name === ".git");
      if (gitChild) {
        try {
          const stat = await NodeFSP.lstat(NodePath.join(absolute, ".git"));
          if (stat.isDirectory() || stat.isFile()) {
            const read = await readRepository(realRoot, absolute, stat);
            repositories.push(read.info);
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
    for (const child of children) {
      const location = NodePath.join(absolute, child.name);
      const relative = relativeOf(realRoot, location);
      if (!isSafeRelativePath(relative, "linux")) {
        warnings.push(
          `Skipped an entry whose name cannot be copied safely below ${relativeOf(realRoot, absolute)}`,
        );
        continue;
      }
      let stat: NodeFS.Stats;
      try {
        stat = await NodeFSP.lstat(location);
      } catch {
        continue;
      }
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
          const counted = await sizeOfTree(location);
          push({
            ...base,
            type: "directory",
            size: counted.bytes,
            class: fileClass,
            collapsed: { files: counted.files },
          });
          continue;
        }
        push({ ...base, type: "directory", size: 0, class: fileClass });
        await walk(location, scope, gitData);
      } else {
        warnings.push(`Skipped ${relative}: not a file, folder or link.`);
      }
    }
  };

  await walk(realRoot, [], false);
  return { root: realRoot, entries, repositories, totals, warnings, notices };
}

/** Re-lists a collapsed rebuildable folder once the person selects rebuildable files. */
export async function expandCollapsed(scan: FolderScan): Promise<FolderScan> {
  if (!scan.entries.some((entry) => entry.collapsed)) return scan;
  return scanFolder(scan.root, { expandRebuildable: true });
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

/** Runs `work` over `items` with at most `limit` in flight. */
export async function forEachLimited<T>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
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
