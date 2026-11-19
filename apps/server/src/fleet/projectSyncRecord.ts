// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like ProjectSync.ts.
/**
 * What a Sync fetch showed (1390). Each `fetch` call is one record under its
 * own id: per checkout, the row the answer showed (branch, commit, upstream as
 * Git reports it, readable or not) and the commit that very fetch brought for
 * the upstream, read from the fetch's own machine-readable output. A `run`
 * moves a checkout only by its row, and only to that commit. Records live in
 * memory for `PROJECT_SYNC_FETCH_KEPT_MS`, the newest `PROJECT_SYNC_FETCHES_KEPT`
 * of the server, and nothing else ever stands in for one: not a newer record,
 * not a tracking ref, not a row that became readable later.
 */
import * as NodeCrypto from "node:crypto";

import {
  PROJECT_SYNC_FETCH_KEPT_MS,
  PROJECT_SYNC_FETCHES_KEPT,
  type ProjectSyncStep,
} from "@specweave-studio/contracts";

import type { GitResult } from "./folderTransfer/git.ts";

type Git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly input?: string;
  },
) => Promise<GitResult>;

const LOCAL_MS = 30_000;
const FETCH_MS = 5 * 60_000;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TRACKING = "refs/remotes/origin/";
const HEADS = "refs/heads/";

/** A branch's upstream exactly as `for-each-ref` reports it; compared as a whole. */
export interface UpstreamTuple {
  /** `%(upstream)`: the ref it is kept in here, such as `refs/remotes/origin/main`. */
  readonly tracking: string;
  /** `%(upstream:remotename)`. */
  readonly remote: string;
  /** `%(upstream:remoteref)`: the branch on that remote, such as `refs/heads/main`. */
  readonly source: string;
}

/** One checkout as one fetch showed it. Never changed once published. */
export interface Row {
  readonly path: string;
  /** The checkout's real path and Git folder at the fetch: a move uses these and no others. */
  readonly cwd: string;
  readonly gitDir: string;
  /** False when any read of the row failed: such a row moves nothing. */
  readonly readable: boolean;
  /** The branch in full (`refs/heads/main`), or null on Git's "detached". */
  readonly branch: string | null;
  readonly head: string | null;
  /** Null without an upstream. */
  readonly upstream: UpstreamTuple | null;
  /** The commit this fetch brought for the upstream's branch on `origin`. */
  readonly target: string | null;
  /** Every branch of `origin` this fetch listed, `refs/heads/…` to its commit. */
  readonly originHeads: ReadonlyMap<string, string>;
  readonly ahead: number;
  readonly behind: number;
  /** The step this machine showed for the row, by its own facts alone. */
  readonly planned: ProjectSyncStep;
}

/** One fetch call. */
export interface FetchRecord {
  readonly id: string;
  readonly projectId: string;
  readonly atMs: number;
  /** By the checkout's path in the project. */
  readonly rows: Map<string, Row>;
}

export function newFetchRecord(projectId: string): FetchRecord {
  return {
    id: NodeCrypto.randomUUID(),
    projectId,
    // @effect-diagnostics-next-line globalDate:off - a plain helper; a fetch's age is wall-clock time.
    atMs: Date.now(),
    rows: new Map(),
  };
}

const kept = new Map<string, FetchRecord>();
const fresh = (record: FetchRecord, nowMs: number) =>
  nowMs - record.atMs <= PROJECT_SYNC_FETCH_KEPT_MS;

/** Keeps a finished fetch for the moves that name it. The oldest go when there are too many. */
export function keepFetch(record: FetchRecord, nowMs: number = record.atMs): void {
  for (const [id, other] of kept) if (!fresh(other, nowMs)) kept.delete(id);
  kept.set(record.id, record);
  while (kept.size > PROJECT_SYNC_FETCHES_KEPT) {
    const oldest = kept.keys().next();
    if (oldest.done === true) break;
    kept.delete(oldest.value);
  }
}

/** The fetch a call names, only when it is this project's and still kept. */
export function keptFetch(
  projectId: string,
  id: string | undefined,
  // @effect-diagnostics-next-line globalDate:off - a plain helper; a fetch's age is wall-clock time.
  nowMs: number = Date.now(),
): FetchRecord | undefined {
  if (id === undefined) return undefined;
  const record = kept.get(id);
  if (record === undefined) return undefined;
  if (!fresh(record, nowMs)) {
    kept.delete(id);
    return undefined;
  }
  return record.projectId === projectId ? record : undefined;
}

/** Drops a kept fetch. For tests: a record evicted while a move runs. */
export function dropFetch(id: string): void {
  kept.delete(id);
}

export type Upstream =
  /** A branch of `origin`, kept here where Sync's own fetch writes it. `ref` is its name there. */
  | {
      readonly kind: "origin";
      readonly name: string;
      readonly ref: string;
      readonly tracking: string;
      readonly tuple: UpstreamTuple;
    }
  /** A local branch, or a branch of another remote: `name` is for the reason only. */
  | { readonly kind: "other"; readonly name: string; readonly tuple: UpstreamTuple }
  /** A branch of `origin` kept here under another name than its own. */
  | {
      readonly kind: "mapped";
      readonly name: string;
      readonly source: string;
      readonly tuple: UpstreamTuple;
    };

/**
 * The branch's upstream as Git itself names it: the remote, the branch on
 * that remote, and the ref it is kept in here. Never rebuilt from the name of
 * the tracking ref. Null without an upstream; `undefined` when Git did not say.
 * `branch` is the branch in full.
 */
export async function upstreamOf(
  git: Git,
  cwd: string,
  branch: string,
): Promise<Upstream | null | undefined> {
  const listed = await git(
    cwd,
    [
      "for-each-ref",
      "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
      branch,
    ],
    { allowFailure: true, timeoutMs: LOCAL_MS },
  ).catch(() => null);
  if (listed === null || listed.code !== 0) return undefined;
  for (const line of listed.stdout.split("\n")) {
    const [refname, tracking, remote, source] = line.split("\0");
    if (refname !== branch) continue;
    if (tracking === undefined || remote === undefined || source === undefined) return undefined;
    if (tracking.length === 0) return null;
    const tuple = { tracking, remote, source };
    // For the reader only: the ref without its folder, whatever else is named like it.
    const name = tracking.replace(/^refs\/(heads|remotes)\//, "");
    if (remote !== "origin") return { kind: "other", name, tuple };
    // Sync's fetch writes origin's `refs/heads/X` to `refs/remotes/origin/X` and nowhere else:
    // a tracking ref of another name is not what the fetch line for the source says.
    if (!source.startsWith(HEADS) || tracking !== `${TRACKING}${source.slice(HEADS.length)}`)
      return { kind: "mapped", name, source: source.replace(HEADS, ""), tuple };
    return { kind: "origin", name, ref: source, tracking, tuple };
  }
  return undefined;
}

export const sameTuple = (a: UpstreamTuple | null, b: UpstreamTuple | null) =>
  a === null || b === null
    ? a === b
    : a.tracking === b.tracking && a.remote === b.remote && a.source === b.source;

export type Fetched =
  /** The fetch went through. `heads` is null when its output could not be read as proof. */
  | { readonly ok: true; readonly heads: Map<string, string> | null; readonly porcelain: boolean }
  | { readonly ok: false; readonly reason: string };

/** Whether the Git that fetches here has `fetch --porcelain` (2.41 and newer). Asked per fetch. */
export async function gitHasFetchPorcelain(git: Git, cwd: string): Promise<boolean> {
  const version = await git(cwd, ["version"], { allowFailure: true, timeoutMs: LOCAL_MS }).catch(
    () => null,
  );
  const found = /git version (\d+)\.(\d+)/.exec(version?.stdout ?? "");
  if (version === null || version.code !== 0 || found === null) return false;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  return major > 2 || (major === 2 && minor >= 41);
}

/**
 * Reads `fetch --porcelain -v` output: one line per ref the refspec matched,
 * `<flag> <old> <new> <ref>`, the flag a space for a fast-forward. Returns
 * origin's branches by their name there, or null when any line is not of that
 * form or names a ref Sync's refspec does not write. Tag lines are passed over.
 */
export function parseFetchPorcelain(stdout: string): Map<string, string> | null {
  const heads = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const flag = line[0];
    const [old, next, ref, ...rest] = line.slice(2).split(" ");
    if (
      line[1] !== " " ||
      flag === undefined ||
      !" +-t*=".includes(flag) ||
      old === undefined ||
      next === undefined ||
      ref === undefined ||
      rest.length > 0 ||
      !OID.test(old) ||
      !OID.test(next)
    )
      return null;
    if (ref.startsWith("refs/tags/")) continue;
    if (!ref.startsWith(TRACKING) || flag === "-") return null;
    heads.set(`${HEADS}${ref.slice(TRACKING.length)}`, next);
  }
  return heads;
}

/**
 * Fetches `origin`'s branches in one network step, into the tracking refs only
 * (never the destinations the repository's settings name, never pruned). Its
 * own output is the record of what it wrote. On a Git without `--porcelain` the
 * same fetch runs, and nothing it brought may be moved to.
 */
export async function fetchOrigin(
  git: Git,
  cwd: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Fetched> {
  const porcelain = await gitHasFetchPorcelain(git, cwd);
  const fetched = await git(cwd, fetchArgs(porcelain), {
    allowFailure: true,
    timeoutMs: FETCH_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).catch((cause: unknown) => ({
    code: -1,
    stdout: "",
    stderr: cause instanceof Error ? cause.message : "The fetch did not finish.",
  }));
  if (fetched.code !== 0) return { ok: false, reason: fetched.stderr };
  return {
    ok: true,
    porcelain,
    heads: porcelain ? parseFetchPorcelain(fetched.stdout) : null,
  };
}

/**
 * The fetch names its own destinations (`--refmap=` switches the configured
 * ones off) and never prunes, whatever `fetch.prune`, `fetch.pruneTags` or
 * `remote.origin.prune` say. Tags come as Git brings them by default.
 */
export const fetchArgs = (porcelain: boolean): Array<string> => [
  "fetch",
  ...(porcelain ? ["--porcelain", "--verbose"] : ["--quiet"]),
  "--no-prune",
  "--no-prune-tags",
  "--no-recurse-submodules",
  "--refmap=",
  "origin",
  `+${HEADS}*:${TRACKING}*`,
];
