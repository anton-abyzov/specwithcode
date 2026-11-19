// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Plain promises over the project's checkouts and Git objects, like ProjectBoard.
/**
 * The copies of a project's increments, and which one is the newest.
 *
 * With worktrees on, threads write `spec.md` and `ledger.jsonl` in their own
 * worktree and merge to the default branch, and nothing brings the project
 * folder current. So an increment is read from the newest of:
 *
 *   - the project folder (the planning root);
 *   - every linked worktree Git registered for that folder's repository that
 *     holds `.specweave/increments` (registeredCheckout.ts, Git's own files);
 *   - the remote's default branch as last fetched (`refs/remotes/origin/HEAD`,
 *     else `origin/main`, else `origin/master`), read from Git objects.
 *
 * The rule for "newest", first difference wins (`rankCopies`):
 *   1. more recorded reopens (`metadata.reopened`): a reopen leaves the ledger
 *      as it is, so only this tells a reopened copy from a stale closed one;
 *   2. closed (completed, or dropped) before open;
 *   3. the longer ledger in bytes: the ledger is append-only;
 *   4. the later metadata time;
 *   5. the project folder, then worktrees by path, then the remote branch.
 * A copy with a `spec.md` is taken before any copy without one. One whole
 * copy is shown; files are never mixed across copies.
 *
 * Nothing here fetches, switches, writes or locks a checkout. Git runs only
 * when the remote branch's commit changes: one `ls-tree` and one `cat-file
 * --batch` per commit, and one `cat-file --batch` for a remote copy that is
 * shown, which is written once to a cache folder outside the repository so
 * the readers and the file viewer, which work on folders, can open it.
 *
 * Cost per read with nothing changed: a few small reads for the remote
 * commit, one stat per worktree, and two stats per worktree copy of an
 * increment that is still open. An increment closed in the project folder or
 * on the remote branch is settled between those two and is not looked up in
 * worktrees.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { parseIncrementMetadata } from "../mods/SpecweaveProgress.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import { checkoutCommonDir, registeredCheckouts } from "./registeredCheckout.ts";
import { incrementIds, readBounded } from "./ThreadIncrementProgress.ts";
import { INCREMENTS_DIR } from "./ThreadReports.ts";

const SMALL_BYTES = 524_288;
const PAUSED_REASON_CHARS = 300;
const CACHE_ENTRIES = 20_000;
const READ_BATCH = 64;
const INCREMENT_FOLDER = /^\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const REF_NAME = /^refs\/[A-Za-z0-9._/-]+$/u;
const CONFIG_PATH = ".specweave/config.json";
const REMOTE_PREFIX = "refs/remotes/";
/** One Git read; a slower one answers nothing and the folders are shown alone. */
const GIT_MS = 3_000;
const GIT_OUTPUT_BYTES = 64 * 1_048_576;
/** A remote branch that could not be read is not asked again for this long. */
const REMOTE_RETRY_MS = 30_000;
/** Bounds of one remote copy written to the cache. */
const COPY_FILES = 400;
const COPY_FILE_BYTES = 2 * 1_048_576;
const COPY_TOTAL_BYTES = 16 * 1_048_576;
/** A cached copy the branch no longer holds is kept this long for a view that still reads it. */
const COPY_KEPT_MS = 10 * 60_000;
const COMPLETE_MARK = ".complete";

/**
 * What a `metadata.json` status means for the board, across the spellings
 * older increments and other tools wrote (`in_progress`, `done`, `cancelled`).
 * `dropped` increments are left off the board.
 */
export type BoardStatus = "planned" | "active" | "paused" | "review" | "completed" | "dropped";
const STATUS_MEANINGS: Readonly<Record<string, BoardStatus>> = {
  active: "active",
  "in-progress": "active",
  started: "active",
  paused: "paused",
  "ready-for-review": "review",
  "in-review": "review",
  review: "review",
  completed: "completed",
  complete: "completed",
  done: "completed",
  closed: "completed",
  abandoned: "dropped",
  cancelled: "dropped",
  canceled: "dropped",
  superseded: "dropped",
  archived: "dropped",
};
export function boardStatus(status: string): BoardStatus {
  return (
    STATUS_MEANINGS[
      status
        .trim()
        .toLowerCase()
        .replaceAll(/[_\s]+/gu, "-")
    ] ?? "planned"
  );
}

/** What the board needs of one copy's `metadata.json`. */
export interface CopyMeta {
  readonly title: string | null;
  readonly status: string;
  readonly updatedAt: string | null;
  readonly pausedReason: string | null;
  /** How many times `specweave reopen` reopened it. */
  readonly reopened: number;
}

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

export function copyMetaOf(metadata: Record<string, unknown>): CopyMeta {
  return {
    title:
      typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : null,
    status:
      typeof metadata.status === "string" && metadata.status.trim()
        ? metadata.status.trim().toLowerCase()
        : "unknown",
    updatedAt:
      isoOrNull(metadata.lastActivity) ??
      isoOrNull(metadata.updated) ??
      isoOrNull(metadata.created),
    pausedReason:
      typeof metadata.pausedReason === "string" && metadata.pausedReason.trim()
        ? metadata.pausedReason.trim().slice(0, PAUSED_REASON_CHARS)
        : null,
    reopened: Array.isArray(metadata.reopened) ? metadata.reopened.length : 0,
  };
}

const NO_METADATA = copyMetaOf({});

function remember<K, V>(cache: Map<K, V>, key: K, value: V, entries = CACHE_ENTRIES): V {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > entries) cache.delete(cache.keys().next().value!);
  return value;
}

/** Parsed `metadata.json` by path, valid while its mtime and size hold. */
const metaCache = new Map<string, { signature: string; value: CopyMeta }>();

/** One folder copy's metadata; a folder without the file reads as `unknown`. */
export async function readCopyMeta(root: string, folder: string): Promise<CopyMeta> {
  const file = NodePath.join(folder, "metadata.json");
  const stat = await NodeFSP.stat(file).catch(() => null);
  const signature = stat === null ? "-" : `${stat.mtimeMs}:${stat.size}`;
  const cached = metaCache.get(file);
  if (cached?.signature === signature) return cached.value;
  const value =
    stat === null
      ? NO_METADATA
      : copyMetaOf(parseIncrementMetadata(await readBounded(root, file, SMALL_BYTES)));
  remember(metaCache, file, { signature, value });
  return value;
}

export async function inBatches<A, B>(
  items: ReadonlyArray<A>,
  read: (item: A) => Promise<B>,
): Promise<B[]> {
  const results: B[] = [];
  for (let start = 0; start < items.length; start += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(start, start + READ_BATCH).map(read))));
  }
  return results;
}

// ── Git ─────────────────────────────────────────────────────────────────────

/** Runs Git in `cwd` with `input` on stdin; `ok` is false on any failure, timeout or oversized answer. */
export type BoardGitRun = (
  cwd: string,
  args: ReadonlyArray<string>,
  input?: string,
) => Promise<{ readonly ok: boolean; readonly stdout: Buffer }>;

/** A repository's Git variables, such as GIT_DIR, could point the read at another one. */
const gitEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("GIT_"))),
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
});

const runGit: BoardGitRun = (cwd, args, input) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: ok ? Buffer.concat(chunks) : Buffer.alloc(0) });
    };
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      child = NodeChildProcess.spawn("git", ["--no-optional-locks", "-C", cwd, ...args], {
        env: gitEnvironment(process.env),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, GIT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(false);
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });

const readText = (file: string) => NodeFSP.readFile(file, "utf8").catch(() => null);

/** `refs/remotes/origin/*` of `packed-refs` by common directory, valid while the file is unchanged. */
const packedRefs = new Map<string, { signature: string; refs: ReadonlyMap<string, string> }>();

async function packedRef(common: string, ref: string): Promise<string | null> {
  const file = NodePath.join(common, "packed-refs");
  const stat = await NodeFSP.stat(file).catch(() => null);
  if (stat === null) return null;
  const signature = `${stat.mtimeMs}:${stat.size}`;
  let cached = packedRefs.get(common);
  if (cached?.signature !== signature) {
    const refs = new Map<string, string>();
    for (const line of ((await readText(file)) ?? "").split(/\r?\n/u)) {
      const space = line.indexOf(" ");
      if (space <= 0) continue;
      const commit = line.slice(0, space);
      if (COMMIT.test(commit)) refs.set(line.slice(space + 1).trim(), commit);
    }
    cached = remember(packedRefs, common, { signature, refs }, 64);
  }
  return cached.refs.get(ref) ?? null;
}

/** The commit a ref names, from Git's files alone: the loose ref first, then `packed-refs`. */
async function refCommit(common: string, ref: string): Promise<string | null> {
  if (!REF_NAME.test(ref)) return null;
  if (ref.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const loose = (await readText(NodePath.join(common, ...ref.split("/"))))?.trim();
  if (loose !== undefined) return COMMIT.test(loose) ? loose : null;
  return packedRef(common, ref);
}

/** The remote's default branch as last fetched: its short name and commit. */
async function remoteDefault(
  common: string,
): Promise<{ readonly ref: string; readonly commit: string } | null> {
  const head = (await readText(NodePath.join(common, "refs", "remotes", "origin", "HEAD")))?.trim();
  const named = /^ref:\s*(refs\/remotes\/origin\/[A-Za-z0-9._/-]+)$/u.exec(head ?? "")?.[1];
  const candidates =
    named === undefined ? ["refs/remotes/origin/main", "refs/remotes/origin/master"] : [named];
  for (const ref of candidates) {
    const commit = await refCommit(common, ref);
    if (commit !== null) return { ref: ref.slice(REMOTE_PREFIX.length), commit };
  }
  return null;
}

/** The commit checked out in the checkout whose top is `top`. */
async function checkedOutCommit(top: string, common: string): Promise<string | null> {
  const dotGit = NodePath.join(top, ".git");
  const stat = await NodeFSP.lstat(dotGit).catch(() => null);
  if (stat === null) return null;
  let gitDir = dotGit;
  if (!stat.isDirectory()) {
    const pointer = /^gitdir:\s*(.+)$/mu.exec((await readText(dotGit)) ?? "")?.[1]?.trim();
    if (pointer === undefined) return null;
    gitDir = NodePath.resolve(top, pointer);
  }
  const head = (await readText(NodePath.join(gitDir, "HEAD")))?.trim() ?? "";
  if (COMMIT.test(head)) return head;
  const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/u.exec(head)?.[1];
  return ref === undefined ? null : refCommit(common, ref);
}

// ── The remote branch ───────────────────────────────────────────────────────

interface RemoteFile {
  readonly oid: string;
  readonly size: number;
}

export interface RemoteIncrement {
  /** The copy's regular files by path inside the increment folder. */
  readonly files: ReadonlyMap<string, RemoteFile>;
  /** Names this exact content (and the config beside it) in the cache. */
  readonly key: string;
  readonly meta: CopyMeta;
}

export interface RemoteBranch {
  readonly top: string;
  readonly common: string;
  /** Such as `origin/main`. */
  readonly ref: string;
  readonly commit: string;
  readonly increments: ReadonlyMap<string, RemoteIncrement>;
  readonly config: RemoteFile | null;
}

const safeSegment = (part: string) =>
  part !== "" && part !== "." && part !== ".." && !/[\\\0:]/u.test(part);

/** Blob contents from `git cat-file --batch`, in the order asked; null for one that is missing. */
function parseBatch(output: Buffer, oids: ReadonlyArray<string>): Array<Buffer | null> | null {
  const blobs: Array<Buffer | null> = [];
  let position = 0;
  for (const oid of oids) {
    const lineEnd = output.indexOf(10, position);
    if (lineEnd === -1) return null;
    const header = output.toString("utf8", position, lineEnd).split(" ");
    position = lineEnd + 1;
    if (header[0] !== oid) return null;
    if (header[1] !== "blob") {
      if (header[1] === "missing") {
        blobs.push(null);
        continue;
      }
      return null;
    }
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || position + size > output.length) return null;
    blobs.push(output.subarray(position, position + size));
    position += size + 1;
  }
  return blobs;
}

async function readBlobs(
  git: BoardGitRun,
  top: string,
  oids: ReadonlyArray<string>,
): Promise<Array<Buffer | null> | null> {
  if (oids.length === 0) return [];
  const result = await git(top, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  return result.ok ? parseBatch(result.stdout, oids) : null;
}

const decode = (bytes: Buffer): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Parsed `metadata.json` blobs by object id: a blob never changes. */
const remoteMeta = new Map<string, CopyMeta>();

async function loadRemote(
  git: BoardGitRun,
  top: string,
  common: string,
  ref: string,
  commit: string,
): Promise<RemoteBranch | null> {
  const listing = await git(top, [
    "ls-tree",
    "-r",
    "-l",
    "-z",
    commit,
    "--",
    `${INCREMENTS_DIR}/`,
    CONFIG_PATH,
  ]);
  if (!listing.ok) return null;
  const files = new Map<string, Map<string, RemoteFile>>();
  let config: RemoteFile | null = null;
  for (const record of listing.stdout.toString("utf8").split("\0")) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/u.exec(record);
    if (match === null || match[2] !== "blob") continue;
    // Regular files only: a link in the tree could name a path outside the copy.
    if (match[1] !== "100644" && match[1] !== "100755") continue;
    const file: RemoteFile = { oid: match[3]!, size: Number(match[4]) };
    const path = match[5]!;
    if (path === CONFIG_PATH) {
      config = file;
      continue;
    }
    if (!path.startsWith(`${INCREMENTS_DIR}/`)) continue;
    const [id, ...rest] = path.slice(INCREMENTS_DIR.length + 1).split("/");
    if (id === undefined || rest.length === 0 || !INCREMENT_FOLDER.test(id)) continue;
    if (!rest.every(safeSegment)) continue;
    let own = files.get(id);
    if (own === undefined) files.set(id, (own = new Map()));
    own.set(rest.join("/"), file);
  }
  const wanted = new Set<string>();
  for (const own of files.values()) {
    const metadata = own.get("metadata.json");
    if (metadata !== undefined && metadata.size <= SMALL_BYTES && !remoteMeta.has(metadata.oid)) {
      wanted.add(metadata.oid);
    }
  }
  const oids = [...wanted];
  const blobs = await readBlobs(git, top, oids);
  if (blobs === null) return null;
  oids.forEach((oid, index) => {
    const blob = blobs[index];
    const text = blob === null || blob === undefined ? null : decode(blob);
    remember(remoteMeta, oid, copyMetaOf(parseIncrementMetadata(text)));
  });
  const increments = new Map<string, RemoteIncrement>();
  for (const [id, own] of files) {
    const hash = NodeCrypto.createHash("sha256").update(`${id}\n${config?.oid ?? "-"}\n`);
    for (const path of [...own.keys()].toSorted()) hash.update(`${path}:${own.get(path)!.oid}\n`);
    const metadata = own.get("metadata.json");
    increments.set(id, {
      files: own,
      key: hash.digest("hex").slice(0, 32),
      meta: (metadata === undefined ? undefined : remoteMeta.get(metadata.oid)) ?? NO_METADATA,
    });
  }
  return { top, common, ref, commit, increments, config };
}

/** The last read of each repository's remote branch, by common directory. */
const remotes = new Map<
  string,
  { readonly commit: string; readonly at: number; readonly value: Promise<RemoteBranch | null> }
>();

async function remoteBranch(
  git: BoardGitRun,
  top: string,
  common: string,
): Promise<RemoteBranch | null> {
  const named = await remoteDefault(common);
  if (named === null) return null;
  const held = remotes.get(common);
  if (held?.commit === named.commit) {
    const value = await held.value;
    if (value !== null || Date.now() - held.at < REMOTE_RETRY_MS) return value;
  }
  const value = loadRemote(git, top, common, named.ref, named.commit).catch(() => null);
  remember(remotes, common, { commit: named.commit, at: Date.now(), value }, 64);
  return value;
}

const behindCounts = new Map<string, { readonly key: string; readonly count: number | null }>();

async function behindCount(
  git: BoardGitRun,
  top: string,
  common: string,
  commit: string,
): Promise<number | null> {
  const head = await checkedOutCommit(top, common);
  if (head === null) return null;
  if (head === commit) return 0;
  const key = `${head}..${commit}`;
  const held = behindCounts.get(top);
  if (held?.key === key) return held.count;
  const result = await git(top, ["rev-list", "--count", key]);
  const parsed = result.ok ? Number(result.stdout.toString("utf8").trim()) : Number.NaN;
  const count = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  remember(behindCounts, top, { key, count }, 64);
  return count;
}

// ── A remote copy as a folder ───────────────────────────────────────────────

const writing = new Map<string, Promise<string | null>>();
const pruned = new Map<string, string>();
let temporary = 0;

const repositoryKey = (common: string) =>
  NodeCrypto.createHash("sha256").update(common).digest("hex").slice(0, 16);

/** Removes cached copies the branch no longer holds, once per commit. */
async function pruneCopies(branch: RemoteBranch, folder: string): Promise<void> {
  if (pruned.get(folder) === branch.commit) return;
  remember(pruned, folder, branch.commit, 64);
  const keep = new Set<string>();
  for (const increment of branch.increments.values()) keep.add(increment.key);
  const now = Date.now();
  for (const name of await NodeFSP.readdir(folder).catch(() => [] as string[])) {
    if (keep.has(name)) continue;
    const path = NodePath.join(folder, name);
    const stat = await NodeFSP.stat(path).catch(() => null);
    if (stat === null || now - stat.mtimeMs < COPY_KEPT_MS) continue;
    await NodeFSP.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeCopy(
  git: BoardGitRun,
  branch: RemoteBranch,
  id: string,
  increment: RemoteIncrement,
  root: string,
): Promise<string | null> {
  const first = ["metadata.json", "spec.md", "tasks.md", "ledger.jsonl"];
  const paths = [
    ...first.filter((path) => increment.files.has(path)),
    ...[...increment.files.keys()].filter((path) => !first.includes(path)).toSorted(),
  ];
  const wanted: Array<{ readonly target: ReadonlyArray<string>; readonly oid: string }> = [];
  let total = 0;
  for (const path of paths) {
    const file = increment.files.get(path)!;
    if (wanted.length >= COPY_FILES) break;
    if (!(file.size <= COPY_FILE_BYTES) || total + file.size > COPY_TOTAL_BYTES) continue;
    total += file.size;
    wanted.push({ target: [...INCREMENTS_DIR.split("/"), id, ...path.split("/")], oid: file.oid });
  }
  if (branch.config !== null && branch.config.size <= SMALL_BYTES) {
    wanted.push({ target: CONFIG_PATH.split("/"), oid: branch.config.oid });
  }
  const blobs = await readBlobs(
    git,
    branch.top,
    wanted.map((entry) => entry.oid),
  );
  if (blobs === null) return null;
  temporary += 1;
  const staging = `${root}.tmp-${process.pid}-${temporary}`;
  try {
    await NodeFSP.mkdir(NodePath.join(staging, ...INCREMENTS_DIR.split("/"), id), {
      recursive: true,
      mode: 0o700,
    });
    for (const [index, entry] of wanted.entries()) {
      const blob = blobs[index];
      if (blob === null || blob === undefined) continue;
      const file = NodePath.join(staging, ...entry.target);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      // Read-only: this is a view of the branch, and an edit here would be lost.
      await NodeFSP.writeFile(file, blob, { mode: 0o400 });
    }
    await NodeFSP.writeFile(NodePath.join(staging, COMPLETE_MARK), `${branch.commit}\n`);
    await NodeFSP.rename(staging, root);
    return root;
  } catch {
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // Another reader may have written the same content first.
    const done = await NodeFSP.stat(NodePath.join(root, COMPLETE_MARK)).catch(() => null);
    return done === null ? null : root;
  }
}

/**
 * The root of a folder holding the remote branch's copy of one increment
 * (`<root>/.specweave/increments/<id>`), written on first use; null when it
 * cannot be written or there is no cache folder.
 */
async function remoteCopyRoot(copies: BoardCopies, id: string): Promise<string | null> {
  const branch = copies.remote;
  const increment = branch?.increments.get(id);
  if (branch === null || increment === undefined || copies.cacheDir === null) return null;
  const folder = NodePath.join(copies.cacheDir, repositoryKey(branch.common));
  const root = NodePath.join(folder, increment.key);
  const done = await NodeFSP.stat(NodePath.join(root, COMPLETE_MARK)).catch(() => null);
  if (done !== null) return root;
  const running = writing.get(root);
  if (running !== undefined) return running;
  const work = (async () => {
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    void pruneCopies(branch, folder);
    return writeCopy(copies.git, branch, id, increment, root);
  })()
    .catch(() => null)
    .finally(() => writing.delete(root));
  writing.set(root, work);
  return work;
}

// ── Worktrees ───────────────────────────────────────────────────────────────

export interface WorktreeCopies {
  /** The worktree's top, which holds `.specweave/increments`. */
  readonly root: string;
  /** Its folder name, as the card says it. */
  readonly name: string;
  readonly ids: ReadonlySet<string>;
}

/** A worktree's increment folder names, valid while its increments folder is unchanged. */
const worktreeListings = new Map<string, { stamp: string; ids: ReadonlySet<string> }>();

async function worktreesOf(root: string): Promise<WorktreeCopies[]> {
  const real = await NodeFSP.realpath(root).catch(() => null);
  if (real === null) return [];
  const tops = (await registeredCheckouts([real])).filter((top) => top !== real);
  const read = await inBatches(tops, async (top): Promise<WorktreeCopies | null> => {
    const stat = await NodeFSP.stat(NodePath.join(top, INCREMENTS_DIR)).catch(() => null);
    if (stat === null || !stat.isDirectory()) return null;
    const stamp = `${stat.mtimeMs}:${stat.ino}`;
    let listing = worktreeListings.get(top);
    if (listing?.stamp !== stamp) {
      listing = remember(
        worktreeListings,
        top,
        { stamp, ids: new Set(await incrementIds(top)) },
        512,
      );
    }
    return { root: top, name: NodePath.basename(top), ids: listing.ids };
  });
  return read.filter((entry): entry is WorktreeCopies => entry !== null);
}

// ── Choosing ────────────────────────────────────────────────────────────────

export interface BoardCopies {
  /** The project folder's planning root. */
  readonly root: string;
  readonly projectIds: ReadonlySet<string>;
  readonly worktrees: ReadonlyArray<WorktreeCopies>;
  readonly remote: RemoteBranch | null;
  /** The project folder's checkout against the remote branch; null when unknown. */
  readonly behind: {
    readonly ref: string;
    readonly count: number;
    readonly fetchedAt: string | null;
  } | null;
  /** When the repository last fetched, as an ISO time. */
  readonly fetchedAt: string | null;
  readonly cacheDir: string | null;
  readonly git: BoardGitRun;
}

export interface BoardCopyOptions {
  /** Where remote copies are written; without it a remote copy shows without its files. */
  readonly cacheDir?: string | undefined;
  /** Tests replace Git. */
  readonly git?: BoardGitRun | undefined;
}

/** Every copy of the project's increments that can be read now. Never fails. */
export async function openBoardCopies(
  root: string,
  options: BoardCopyOptions = {},
): Promise<BoardCopies> {
  const git = options.git ?? runGit;
  const projectIds = new Set(await incrementIds(root));
  const none: BoardCopies = {
    root,
    projectIds,
    worktrees: [],
    remote: null,
    behind: null,
    fetchedAt: null,
    cacheDir: options.cacheDir ?? null,
    git,
  };
  try {
    // Only a checkout's top: the remote paths and the worktree list are its own.
    const common = await checkoutCommonDir(root);
    if (common === null) return none;
    const top = (await NodeFSP.realpath(root).catch(() => null)) ?? root;
    const [worktrees, remote, fetched] = await Promise.all([
      worktreesOf(root).catch(() => []),
      remoteBranch(git, top, common).catch(() => null),
      NodeFSP.stat(NodePath.join(common, "FETCH_HEAD")).catch(() => null),
    ]);
    const fetchedAt = fetched === null ? null : new Date(fetched.mtimeMs).toISOString();
    const count =
      remote === null
        ? null
        : await behindCount(git, top, common, remote.commit).catch(() => null);
    return {
      ...none,
      worktrees,
      remote,
      fetchedAt,
      behind: remote === null || count === null ? null : { ref: remote.ref, count, fetchedAt },
    };
  } catch {
    return none;
  }
}

/** One copy of one increment. */
export interface IncrementCopy {
  readonly kind: "project" | "worktree" | "remote";
  /** The worktree's folder name or the remote branch; null for the project folder. */
  readonly name: string | null;
  readonly meta: CopyMeta;
  /** The root holding its folder; null for a remote copy until `copyRoot` writes it. */
  readonly root: string | null;
}

const isClosed = (meta: CopyMeta) => {
  const meaning = boardStatus(meta.status);
  return meaning === "completed" || meaning === "dropped";
};

const folderOf = (root: string, id: string) => NodePath.join(root, INCREMENTS_DIR, id);

const projectCopy = (copies: BoardCopies, meta: CopyMeta): IncrementCopy => ({
  kind: "project",
  name: null,
  meta,
  root: copies.root,
});

const remoteCopy = (branch: RemoteBranch, increment: RemoteIncrement): IncrementCopy => ({
  kind: "remote",
  name: branch.ref,
  meta: increment.meta,
  root: null,
});

async function ledgerBytes(copies: BoardCopies, id: string, copy: IncrementCopy): Promise<number> {
  if (copy.root === null) return copies.remote?.increments.get(id)?.files.get("ledger.jsonl")?.size ?? 0;
  const stat = await NodeFSP.stat(NodePath.join(folderOf(copy.root, id), "ledger.jsonl")).catch(
    () => null,
  );
  return stat?.isFile() === true ? stat.size : 0;
}

async function hasSpec(copies: BoardCopies, id: string, copy: IncrementCopy): Promise<boolean> {
  if (copy.root === null) return copies.remote?.increments.get(id)?.files.has("spec.md") ?? false;
  const stat = await NodeFSP.stat(NodePath.join(folderOf(copy.root, id), "spec.md")).catch(
    () => null,
  );
  return stat?.isFile() === true;
}

/** What the rule compares; the array order of the copies is its last step. */
export interface CopyRank {
  readonly reopened: number;
  readonly closed: boolean;
  readonly ledgerBytes: number;
  readonly updatedAt: string | null;
}

/** Negative when `left` is the newer copy, positive when `right` is, 0 when the rule cannot tell. */
export function rankCopies(left: CopyRank, right: CopyRank): number {
  return (
    right.reopened - left.reopened ||
    Number(right.closed) - Number(left.closed) ||
    right.ledgerBytes - left.ledgerBytes ||
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  );
}

/** The first copy with a `spec.md`, in the order given; the first one when none has it. */
async function firstWithSpec(
  copies: BoardCopies,
  id: string,
  ordered: ReadonlyArray<IncrementCopy>,
): Promise<IncrementCopy | null> {
  for (const copy of ordered) if (await hasSpec(copies, id, copy)) return copy;
  return ordered[0] ?? null;
}

async function worktreeCopiesOf(copies: BoardCopies, id: string): Promise<IncrementCopy[]> {
  const holding = copies.worktrees.filter((worktree) => worktree.ids.has(id));
  return Promise.all(
    holding.map(
      async (worktree): Promise<IncrementCopy> => ({
        kind: "worktree",
        name: worktree.name,
        meta: await readCopyMeta(worktree.root, folderOf(worktree.root, id)),
        root: worktree.root,
      }),
    ),
  );
}

/**
 * The newest copy of one increment, or null when no copy exists. `projectMeta`
 * is the project folder's metadata when the caller already read it.
 */
export async function chooseCopy(
  copies: BoardCopies,
  id: string,
  projectMeta?: CopyMeta,
): Promise<IncrementCopy | null> {
  const project = copies.projectIds.has(id)
    ? projectCopy(
        copies,
        projectMeta ?? (await readCopyMeta(copies.root, folderOf(copies.root, id))),
      )
    : null;
  const held = copies.remote?.increments.get(id);
  const remote = copies.remote !== null && held !== undefined ? remoteCopy(copies.remote, held) : null;
  // Settled between the project folder and the remote branch when the newer
  // of the two is closed: no worktree is asked.
  if (project !== null && remote !== null) {
    const order =
      remote.meta.reopened - project.meta.reopened ||
      Number(isClosed(remote.meta)) - Number(isClosed(project.meta));
    const lead = order > 0 ? remote : project;
    const other = lead === project ? remote : project;
    if (isClosed(lead.meta)) {
      // Both closed: the project folder's, whose files are at hand. A closed
      // copy against an open one must hold a spec to hide it.
      if (isClosed(other.meta)) return lead;
      return firstWithSpec(copies, id, [lead, other]);
    }
  } else {
    const only = project ?? remote;
    if (only !== null && isClosed(only.meta)) return only;
  }
  const candidates = [
    ...(project === null ? [] : [project]),
    ...(await worktreeCopiesOf(copies, id)),
    ...(remote === null ? [] : [remote]),
  ];
  if (candidates.length <= 1) return candidates[0] ?? null;
  const ranked = await Promise.all(
    candidates.map(async (copy, index) => ({
      copy,
      index,
      rank: {
        reopened: copy.meta.reopened,
        closed: isClosed(copy.meta),
        ledgerBytes: await ledgerBytes(copies, id, copy),
        updatedAt: copy.meta.updatedAt,
      } satisfies CopyRank,
    })),
  );
  ranked.sort((left, right) => rankCopies(left.rank, right.rank) || left.index - right.index);
  return firstWithSpec(
    copies,
    id,
    ranked.map((entry) => entry.copy),
  );
}

/**
 * Another copy that has a `spec.md`, for a chosen copy that turned out to
 * have none (a closed stub in the project folder): the remote branch's first,
 * then the worktrees'. Null when no copy has one.
 */
export async function copyWithSpec(
  copies: BoardCopies,
  id: string,
  chosen: IncrementCopy,
): Promise<IncrementCopy | null> {
  const held = copies.remote?.increments.get(id);
  const others = [
    ...(copies.remote !== null && held !== undefined ? [remoteCopy(copies.remote, held)] : []),
    ...(await worktreeCopiesOf(copies, id)),
  ].filter((copy) => copy.kind !== chosen.kind || copy.root !== chosen.root);
  for (const copy of others) if (await hasSpec(copies, id, copy)) return copy;
  return null;
}

/** The root holding a copy's folder; a remote copy is written to the cache first. Null when it cannot be. */
export async function copyRoot(
  copies: BoardCopies,
  id: string,
  copy: IncrementCopy,
): Promise<string | null> {
  return copy.root ?? remoteCopyRoot(copies, id);
}

/** Every increment folder name any copy holds, newest number first. */
export function copyIds(copies: BoardCopies): string[] {
  const ids = new Set(copies.projectIds);
  for (const id of copies.remote?.increments.keys() ?? []) ids.add(id);
  for (const worktree of copies.worktrees) for (const id of worktree.ids) ids.add(id);
  return [...ids].toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}
