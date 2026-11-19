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
 *   5. the project folder, then the remote branch, then worktrees by path.
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
/** A ref name Git accepts (`git check-ref-format`), within what this reader opens. */
const REF_NAME =
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  /^refs\/(?!.*(?:\.\.|@\{|\/\.|\.lock(?:\/|$)|\/\/))[^\x00-\x20\x7f~^:?*[\\]+(?<![./])$/u;
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
/** A served copy's folder time is renewed at most this often. */
const COPY_TOUCH_MS = 60_000;
/** The files a card and the view read task state from: a copy without them is not written. */
const STATE_FILES = ["metadata.json", "spec.md", "tasks.md", "ledger.jsonl"];
/** Above this a state file is not copied and the copy is not shown from its files. */
const STATE_FILE_BYTES = 8 * 1_048_576;
/** Blob bytes asked of one `git cat-file --batch`, under its 64 MiB output bound. */
const COPY_BATCH_BYTES = 56 * 1_048_576;
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

/** Git's own answer for origin/HEAD, when the files could not give one; by common directory. */
const resolvedDefaults = new Map<
  string,
  { readonly at: number; readonly value: { readonly ref: string; readonly commit: string } | null }
>();

/**
 * Asks Git for origin/HEAD (read-only, nothing fetched): for ref storage
 * the file reader does not know, such as reftable.
 */
async function resolvedDefault(
  git: BoardGitRun,
  top: string,
  common: string,
): Promise<{ readonly ref: string; readonly commit: string } | null> {
  // Remembered for REMOTE_RETRY_MS either way: a fetch shows within that time.
  const held = resolvedDefaults.get(common);
  if (held !== undefined && Date.now() - held.at < REMOTE_RETRY_MS) return held.value;
  const head = "refs/remotes/origin/HEAD";
  const [name, commit] = await Promise.all([
    git(top, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", head]),
    git(top, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`]),
  ]);
  const ref = name.ok ? name.stdout.toString("utf8").trim() : "";
  const sha = commit.ok ? commit.stdout.toString("utf8").trim() : "";
  const value =
    ref.startsWith(REMOTE_PREFIX) && REF_NAME.test(ref) && COMMIT.test(sha)
      ? { ref: ref.slice(REMOTE_PREFIX.length), commit: sha }
      : null;
  remember(resolvedDefaults, common, { at: Date.now(), value }, 64);
  return value;
}

/** The remote's default branch as last fetched: its short name and commit. */
async function remoteDefault(
  git: BoardGitRun,
  top: string,
  common: string,
): Promise<{ readonly ref: string; readonly commit: string } | null> {
  const head = (await readText(NodePath.join(common, "refs", "remotes", "origin", "HEAD")))?.trim();
  const target = /^ref:\s*(refs\/remotes\/origin\/\S+)$/u.exec(head ?? "")?.[1];
  const named = target !== undefined && REF_NAME.test(target) ? target : undefined;
  // A stale origin/HEAD (a renamed default branch) falls back to main, then master.
  const candidates = [
    ...new Set([
      ...(named === undefined ? [] : [named]),
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
    ]),
  ];
  for (const ref of candidates) {
    const commit = await refCommit(common, ref);
    if (commit !== null) return { ref: ref.slice(REMOTE_PREFIX.length), commit };
  }
  // Only when origin/HEAD exists in some form the files did not answer for.
  const known =
    head !== undefined ||
    (await NodeFSP.stat(NodePath.join(common, "reftable")).catch(() => null)) !== null;
  return known ? resolvedDefault(git, top, common) : null;
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
  const named = await remoteDefault(git, top, common);
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
/** When each cache folder was last pruned, and at which remote commit. */
const pruned = new Map<string, { readonly commit: string; readonly at: number }>();
/** When this process last served each cached copy, by its root. */
const served = new Map<string, number>();
/** Copies Git could not give, by root: not asked for again for REMOTE_RETRY_MS. */
const unwritable = new Map<string, number>();
let temporary = 0;

const repositoryKey = (common: string) =>
  NodeCrypto.createHash("sha256").update(common).digest("hex").slice(0, 16);

/**
 * Removes cached copies the branch no longer holds once nothing has served
 * them for COPY_KEPT_MS, so a view that is still open keeps its files. Use is
 * read from this process's own record, checked right before the removal, and
 * from the folder time a served copy renews (for another process). Runs on
 * any read with a remote branch, at most once per commit and COPY_KEPT_MS.
 * A copy removed under a reader that still holds the older branch is written
 * again on its next read.
 */
async function pruneCopies(branch: RemoteBranch, folder: string): Promise<void> {
  const now = Date.now();
  const last = pruned.get(folder);
  if (last?.commit === branch.commit && now - last.at < COPY_KEPT_MS) return;
  remember(pruned, folder, { commit: branch.commit, at: now }, 64);
  const keep = new Set<string>();
  for (const increment of branch.increments.values()) keep.add(increment.key);
  for (const name of await NodeFSP.readdir(folder).catch(() => [] as string[])) {
    if (keep.has(name)) continue;
    const path = NodePath.join(folder, name);
    const stat = await NodeFSP.stat(path).catch(() => null);
    if (stat === null || Date.now() - stat.mtimeMs < COPY_KEPT_MS) continue;
    // No await between this check and the removal starting.
    if (Date.now() - (served.get(path) ?? 0) < COPY_KEPT_MS || writing.has(path)) continue;
    served.delete(path);
    await NodeFSP.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface CopyPlan {
  readonly id: string;
  readonly root: string;
  readonly entries: ReadonlyArray<{
    readonly target: ReadonlyArray<string>;
    readonly oid: string;
    readonly size: number;
    readonly state: boolean;
  }>;
}

/**
 * What one remote copy writes: every task-state file whole (or nothing at
 * all, when one is too big: a ledger cut short would read as no work done),
 * then the rest within the bounds, then the branch's config.
 */
function planCopy(
  branch: RemoteBranch,
  id: string,
  increment: RemoteIncrement,
  root: string,
): CopyPlan | null {
  const entries: Array<CopyPlan["entries"][number]> = [];
  const target = (path: string) => [...INCREMENTS_DIR.split("/"), id, ...path.split("/")];
  for (const path of STATE_FILES) {
    const file = increment.files.get(path);
    if (file === undefined) continue;
    if (!(file.size <= STATE_FILE_BYTES)) return null;
    entries.push({ target: target(path), oid: file.oid, size: file.size, state: true });
  }
  let total = 0;
  for (const path of [...increment.files.keys()]
    .filter((name) => !STATE_FILES.includes(name))
    .toSorted()) {
    const file = increment.files.get(path)!;
    if (entries.length >= COPY_FILES) break;
    if (!(file.size <= COPY_FILE_BYTES) || total + file.size > COPY_TOTAL_BYTES) continue;
    total += file.size;
    entries.push({ target: target(path), oid: file.oid, size: file.size, state: false });
  }
  if (branch.config !== null && branch.config.size <= SMALL_BYTES) {
    entries.push({
      target: CONFIG_PATH.split("/"),
      oid: branch.config.oid,
      size: branch.config.size,
      state: false,
    });
  }
  return { id, root, entries };
}

async function writePlanned(
  plan: CopyPlan,
  blobs: ReadonlyMap<string, Buffer>,
  commit: string,
): Promise<string | null> {
  // A task-state file Git did not answer for: nothing is written, so the
  // card shows its status alone rather than "no work done".
  if (plan.entries.some((entry) => entry.state && !blobs.has(entry.oid))) return null;
  temporary += 1;
  const staging = `${plan.root}.tmp-${process.pid}-${temporary}`;
  try {
    await NodeFSP.mkdir(NodePath.join(staging, ...INCREMENTS_DIR.split("/"), plan.id), {
      recursive: true,
      mode: 0o700,
    });
    for (const entry of plan.entries) {
      const blob = blobs.get(entry.oid);
      if (blob === undefined) continue;
      const file = NodePath.join(staging, ...entry.target);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      // Read-only: this is a view of the branch, and an edit here would be lost.
      await NodeFSP.writeFile(file, blob, { mode: 0o400 });
    }
    await NodeFSP.writeFile(NodePath.join(staging, COMPLETE_MARK), `${commit}\n`);
    await NodeFSP.rename(staging, plan.root);
    return plan.root;
  } catch {
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // Another reader may have written the same content first.
    const done = await NodeFSP.stat(NodePath.join(plan.root, COMPLETE_MARK)).catch(() => null);
    return done === null ? null : plan.root;
  }
}

/** The cache folder of one increment's remote copy, and whether it is already written. */
async function cachedRoot(
  copies: BoardCopies,
  id: string,
): Promise<{ readonly root: string; readonly folder: string; readonly done: boolean } | null> {
  const branch = copies.remote;
  const increment = branch?.increments.get(id);
  if (branch === null || increment === undefined || copies.cacheDir === null) return null;
  const folder = NodePath.join(copies.cacheDir, repositoryKey(branch.common));
  const root = NodePath.join(folder, increment.key);
  const done = await NodeFSP.stat(NodePath.join(root, COMPLETE_MARK)).catch(() => null);
  if (done !== null) {
    remember(served, root, Date.now(), 4_096);
    // Served now: renew the folder's time so a prune keeps it while in use.
    const stat = await NodeFSP.stat(root).catch(() => null);
    if (stat !== null && Date.now() - stat.mtimeMs > COPY_TOUCH_MS) {
      const now = new Date();
      await NodeFSP.utimes(root, now, now).catch(() => undefined);
    }
  }
  return { root, folder, done: done !== null };
}

/**
 * Groups copies (by index) so that the blobs one batch asks Git for, with
 * room for each header line, stay under `limit`. A blob two copies share is
 * counted once per batch. A copy is never split.
 */
export function copyBatches(
  copies: ReadonlyArray<ReadonlyArray<{ readonly oid: string; readonly size: number }>>,
  limit: number,
): number[][] {
  const cost = (entries: ReadonlyArray<{ readonly size: number }>) =>
    entries.reduce((sum, entry) => sum + entry.size + 128, 0);
  const batches: number[][] = [];
  let batch: number[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  copies.forEach((entries, index) => {
    let size = cost(entries.filter((entry) => !seen.has(entry.oid)));
    if (batch.length > 0 && bytes + size > limit) {
      batches.push(batch);
      batch = [];
      bytes = 0;
      seen.clear();
      size = cost(entries);
    }
    for (const entry of entries) seen.add(entry.oid);
    batch.push(index);
    bytes += size;
  });
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Writes the remote branch's copies of these increments to the cache, with
 * one `git cat-file --batch` per COPY_BATCH_BYTES of blobs (one for a usual
 * board). Increments already written cost a stat; a copy Git could not give
 * is not asked for again for REMOTE_RETRY_MS. Never rejects: a copy that
 * cannot be written is shown from its status alone.
 */
export async function prepareRemoteCopies(
  copies: BoardCopies,
  ids: ReadonlyArray<string>,
): Promise<void> {
  const branch = copies.remote;
  if (branch === null || copies.cacheDir === null) return;
  const folder = NodePath.join(copies.cacheDir, repositoryKey(branch.common));
  void pruneCopies(branch, folder).catch(() => undefined);
  const plans: CopyPlan[] = [];
  const settles: Array<(root: string | null) => void> = [];
  try {
    for (const id of ids) {
      const cached = await cachedRoot(copies, id);
      if (cached === null || cached.done || writing.has(cached.root)) continue;
      if (Date.now() - (unwritable.get(cached.root) ?? -REMOTE_RETRY_MS) < REMOTE_RETRY_MS)
        continue;
      const plan = planCopy(branch, id, branch.increments.get(id)!, cached.root);
      if (plan === null) {
        remember(unwritable, cached.root, Date.now(), 4_096);
        continue;
      }
      let settle!: (root: string | null) => void;
      const promise = new Promise<string | null>((resolve) => (settle = resolve));
      writing.set(cached.root, promise);
      plans.push(plan);
      settles.push(settle);
    }
    if (plans.length === 0) return;
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    const batches = copyBatches(
      plans.map((plan) => plan.entries),
      COPY_BATCH_BYTES,
    );
    for (const members of batches) {
      const oids = [
        ...new Set(members.flatMap((index) => plans[index]!.entries.map((entry) => entry.oid))),
      ];
      const read = await readBlobs(copies.git, branch.top, oids);
      const blobs = new Map<string, Buffer>();
      oids.forEach((oid, index) => {
        const blob = read?.[index];
        if (blob !== null && blob !== undefined) blobs.set(oid, blob);
      });
      await Promise.all(
        members.map(async (index) => {
          const plan = plans[index]!;
          const root = await writePlanned(plan, blobs, branch.commit).catch(() => null);
          if (root === null) remember(unwritable, plan.root, Date.now(), 4_096);
          settles[index]!(root);
        }),
      );
    }
  } catch {
    // The cache folder could not be made: these copies show their status alone.
  } finally {
    for (const [index, plan] of plans.entries()) {
      settles[index]!(null);
      writing.delete(plan.root);
    }
  }
}

/**
 * The root of a folder holding the remote branch's copy of one increment
 * (`<root>/.specweave/increments/<id>`), written on first use; null when it
 * cannot be written or there is no cache folder.
 */
async function remoteCopyRoot(copies: BoardCopies, id: string): Promise<string | null> {
  const cached = await cachedRoot(copies, id);
  if (cached === null) return null;
  if (cached.done) return cached.root;
  const running = writing.get(cached.root);
  if (running !== undefined) return running;
  await prepareRemoteCopies(copies, [id]);
  // Another reader may have started this copy while this one looked.
  const joined = writing.get(cached.root);
  if (joined !== undefined) return joined;
  const done = await NodeFSP.stat(NodePath.join(cached.root, COMPLETE_MARK)).catch(() => null);
  return done === null ? null : cached.root;
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
      remote === null ? null : await behindCount(git, top, common, remote.commit).catch(() => null);
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
  if (copy.root === null)
    return copies.remote?.increments.get(id)?.files.get("ledger.jsonl")?.size ?? 0;
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

const isDropped = (copy: IncrementCopy) => boardStatus(copy.meta.status) === "dropped";

/** The first copy with a `spec.md`, in the order given; null when none has one. */
async function firstWithSpec(
  copies: BoardCopies,
  id: string,
  ordered: ReadonlyArray<IncrementCopy>,
): Promise<IncrementCopy | null> {
  for (const copy of ordered) if (await hasSpec(copies, id, copy)) return copy;
  return null;
}

async function worktreeCopiesOf(copies: BoardCopies, id: string): Promise<IncrementCopy[]> {
  const holding = copies.worktrees.filter((worktree) => worktree.ids.has(id));
  return Promise.all(
    holding.map(async (worktree): Promise<IncrementCopy> => ({
      kind: "worktree",
      name: worktree.name,
      meta: await readCopyMeta(worktree.root, folderOf(worktree.root, id)),
      root: worktree.root,
    })),
  );
}

/**
 * The newest copy of one increment, or null when no copy exists. `projectMeta`
 * is the project folder's metadata when the caller already read it. The copy
 * returned is final: the board counts, searches and builds its card from it.
 * A dropped copy among those read is returned as it is, so the increment
 * stays off the board.
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
  const remote =
    copies.remote !== null && held !== undefined ? remoteCopy(copies.remote, held) : null;
  const settled = [project, remote].filter((copy): copy is IncrementCopy => copy !== null);
  const droppedEarly = settled.find(isDropped);
  if (droppedEarly !== undefined) return droppedEarly;
  // Settled between the project folder and the remote branch, with no
  // worktree asked, when the newer of the two is closed and a closed copy
  // with a spec is at hand. A drop or reopen made only in a worktree of an
  // increment closed here shows once it reaches either (D-02).
  if (settled.length > 0) {
    const ordered = settled.toSorted(
      (left, right) =>
        right.meta.reopened - left.meta.reopened ||
        Number(isClosed(right.meta)) - Number(isClosed(left.meta)),
    );
    const lead = ordered[0]!;
    if (isClosed(lead.meta)) {
      const closed = ordered.filter(
        (copy) => isClosed(copy.meta) && copy.meta.reopened === lead.meta.reopened,
      );
      const withSpec = await firstWithSpec(copies, id, closed);
      if (withSpec !== null) return withSpec;
    }
  }
  // Remote before worktrees: a worktree that merely holds what the remote
  // branch holds does not stand in for it (the rule's last step).
  const candidates = [...settled, ...(await worktreeCopiesOf(copies, id))];
  const dropped = candidates.find(isDropped);
  if (dropped !== undefined) return dropped;
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
  const order = ranked.map((entry) => entry.copy);
  // A stub never hides a copy that has a spec.
  return (await firstWithSpec(copies, id, order)) ?? order[0]!;
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
  return [...ids].toSorted((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  );
}
