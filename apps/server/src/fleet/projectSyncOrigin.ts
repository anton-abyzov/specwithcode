// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like ProjectSync.ts.
/**
 * What a Sync fetch brought (1390). Sync moves a checkout only to the commit
 * one named fetch of its own brought for the branch, by object id. A fetch
 * writes `origin`'s branches twice: into the usual tracking refs, and into a
 * namespace of refs nothing but Sync writes. What it reads back from that
 * namespace is the record of the fetch, so no other fetch can supply it; the
 * namespace is emptied again before the fetch returns. A record is bound to
 * the checkout (its real path and the identity of its Git folder) and to the
 * address Git fetches `origin` from. It is kept in memory under the fetch's
 * id, for a time and up to a count, and nothing else ever stands in for it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { PROJECT_SYNC_FETCH_KEPT_MS, PROJECT_SYNC_FETCHES_KEPT } from "@specweave-studio/contracts";

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

/** How long one ask of `origin` before a move may take. */
export const ORIGIN_ASK_MS = 10_000;
/** How long the asks of one `run` may take together; past it, the rest is not tried. */
export const ORIGIN_ASK_TOTAL_MS = 60_000;
const LOCAL_MS = 30_000;
const FETCH_MS = 5 * 60_000;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The refs only Sync writes: one folder per fetch under way, gone when the fetch returns. */
export const SYNC_REFS = "refs/specwithcode/sync/";
const TRACKING = "refs/remotes/origin/";
const HEADS = "refs/heads/";

/** One checkout as one fetch left it. */
export interface RepositoryRecord {
  /** The checkout's real path. */
  readonly checkout: string;
  /** Its Git folder: device, inode and time of birth. A clone made again has another. */
  readonly identity: string;
  /** False where the file system keeps no time of birth: the identity is then no proof. */
  readonly sure: boolean;
  /** The address Git fetched `origin` from, with every rewrite applied. */
  readonly fetchUrl: string;
  /** Every branch the fetch brought, `refs/heads/…` on `origin` to its commit. */
  readonly heads: ReadonlyMap<string, string>;
  /** Branches learned since to be gone from `origin`, or elsewhere: never moved to by this record. */
  readonly revoked: Map<string, "gone" | "moved">;
}

/** One fetch call: what it brought, per checkout. */
export interface FetchRecord {
  readonly id: string;
  readonly projectId: string;
  readonly atMs: number;
  readonly repositories: Map<string, RepositoryRecord>;
}

export function newFetchRecord(projectId: string): FetchRecord {
  return {
    id: NodeCrypto.randomUUID(),
    projectId,
    // @effect-diagnostics-next-line globalDate:off - a plain helper; a fetch's age is wall-clock time.
    atMs: Date.now(),
    repositories: new Map(),
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

/** The fetch a `run` names, only when it is this project's and still kept. */
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

/**
 * What the newest kept fetch of the project brought for a checkout. For the
 * list of work Git does not carry only: it never permits a move.
 */
export function latestHeads(
  projectId: string,
  checkout: string,
): ReadonlyMap<string, string> | undefined {
  let newest: FetchRecord | undefined;
  for (const record of kept.values())
    if (
      record.projectId === projectId &&
      record.repositories.has(checkout) &&
      (newest === undefined || record.atMs >= newest.atMs)
    )
      newest = record;
  return newest?.repositories.get(checkout)?.heads;
}

/**
 * Takes a branch out of every kept record of a checkout that has it at another
 * commit than `origin` is now known to (`now`; undefined when it is gone
 * there). Permission is per fetch; what the server learned of `origin` holds
 * for all of them.
 */
export function revokeElsewhere(checkout: string, ref: string, now: string | undefined): void {
  for (const record of kept.values()) {
    const repository = record.repositories.get(checkout);
    if (repository !== undefined) revoke(repository, ref, now);
  }
}
/** Every branch any kept record of a checkout holds. */
export function everKnown(checkout: string): Set<string> {
  const out = new Set<string>();
  for (const record of kept.values())
    for (const ref of record.repositories.get(checkout)?.heads.keys() ?? []) out.add(ref);
  return out;
}
export function revoke(repository: RepositoryRecord, ref: string, now: string | undefined): void {
  const had = repository.heads.get(ref);
  if (had !== undefined && had !== now)
    repository.revoked.set(ref, now === undefined ? "gone" : "moved");
}

/**
 * The time one `run` has for asking `origin`. Each ask has its own short
 * limit and is charged what it took; once the total is used up no further
 * ask is made, and a checkout that was not asked for is not moved.
 */
export interface AskBudget {
  /** The limit for the next ask in ms: 0 when the time is used up. */
  readonly next: () => number;
  readonly spend: (ms: number) => void;
}
export function askBudget(totalMs: number = ORIGIN_ASK_TOTAL_MS): AskBudget {
  let left = totalMs;
  return {
    next: () => (left <= 0 ? 0 : ORIGIN_ASK_MS),
    spend: (ms) => {
      left -= Math.max(0, ms);
    },
  };
}

export type Asked =
  /** `tip` is where `origin` has the branch now; undefined when it has none of that name. */
  | { readonly kind: "answered"; readonly tip: string | undefined }
  /** `origin` did not answer in time, or Git could not reach it. */
  | { readonly kind: "unreachable" }
  /** The call's time for asking was used up: nothing was asked. */
  | { readonly kind: "not-tried" };

/**
 * Where `origin` has one branch right now. A read of the remote; it writes
 * nothing here. One request, under a short limit.
 */
export async function askOrigin(
  git: Git,
  cwd: string,
  ref: string,
  options: { readonly budget?: AskBudget; readonly signal?: AbortSignal } = {},
): Promise<Asked> {
  const timeoutMs = options.budget === undefined ? ORIGIN_ASK_MS : options.budget.next();
  if (timeoutMs <= 0) return { kind: "not-tried" };
  // @effect-diagnostics-next-line globalDate:off - a plain helper; the time an ask took is wall-clock time.
  const started = Date.now();
  const listed = await git(cwd, ["ls-remote", "--heads", "origin", ref], {
    allowFailure: true,
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).catch(() => null);
  // @effect-diagnostics-next-line globalDate:off - a plain helper; the time an ask took is wall-clock time.
  options.budget?.spend(Date.now() - started);
  if (listed === null || listed.code !== 0) return { kind: "unreachable" };
  let tip: string | undefined;
  for (const line of listed.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [oid, name, ...rest] = line.split("\t");
    // An answer that is not a list of branches is no answer.
    if (oid === undefined || name === undefined || rest.length > 0 || !OID.test(oid))
      return { kind: "unreachable" };
    if (name === ref) tip = oid;
  }
  return { kind: "answered", tip };
}

/** The address Git fetches `origin` from, every `insteadOf` rewrite applied; null when Git gives none. */
export async function fetchAddress(git: Git, cwd: string): Promise<string | null> {
  const url = await git(cwd, ["ls-remote", "--get-url", "origin"], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  const text = url === null || url.code !== 0 ? "" : url.stdout.trim();
  // Without an `origin`, Git echoes the name back.
  return text.length === 0 || text === "origin" || text.includes("\n") ? null : text;
}

type Stat = (path: string) => Promise<{
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
  readonly isDirectory: () => boolean;
} | null>;
const lstat: Stat = (path) => NodeFSP.lstat(path, { bigint: true }).catch(() => null);

/** The checkout's real path and what tells its Git folder from one made again there. */
export async function checkoutIdentity(
  git: Git,
  cwd: string,
  stat: Stat = lstat,
): Promise<{
  readonly checkout: string;
  readonly identity: string;
  readonly sure: boolean;
} | null> {
  const [checkout, gitDir] = await Promise.all([
    NodeFSP.realpath(cwd).catch(() => null),
    git(cwd, ["rev-parse", "--absolute-git-dir"], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
    }).catch(() => null),
  ]);
  if (checkout === null || gitDir === null || gitDir.code !== 0) return null;
  const found = await stat(gitDir.stdout.trim());
  if (found === null || !found.isDirectory()) return null;
  return {
    checkout,
    identity: `${found.dev}:${found.ino}:${found.birthtimeNs}`,
    sure: found.birthtimeNs > 0n,
  };
}

export type Upstream =
  /** A branch of `origin`, kept here where Sync's own fetch writes it. `ref` is its name there. */
  | {
      readonly kind: "origin";
      readonly name: string;
      readonly ref: string;
      readonly tracking: string;
    }
  /** A local branch, or a branch of another remote: `name` is for the reason only. */
  | { readonly kind: "other"; readonly name: string }
  /** A branch of `origin` kept here under another name than its own. */
  | { readonly kind: "mapped"; readonly name: string; readonly source: string };

/**
 * The branch's upstream as Git itself names it: the remote, the branch on
 * that remote, and the ref it is kept in here. Never rebuilt from the name of
 * the tracking ref. Null without an upstream; `undefined` when Git did not say.
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
      `${HEADS}${branch}`,
    ],
    { allowFailure: true, timeoutMs: LOCAL_MS },
  );
  if (listed.code !== 0) return undefined;
  for (const line of listed.stdout.split("\n")) {
    const [refname, tracking, remote, source] = line.split("\0");
    if (refname !== `${HEADS}${branch}`) continue;
    if (tracking === undefined || tracking.length === 0) return null;
    // For the reader only: the ref without its folder, whatever else is named like it.
    const name = tracking.replace(/^refs\/(heads|remotes)\//, "");
    if (remote !== "origin" || source === undefined) return { kind: "other", name };
    if (!source.startsWith(HEADS) || tracking !== `${TRACKING}${source.slice(HEADS.length)}`)
      return { kind: "mapped", name, source: source.replace(HEADS, "") };
    return { kind: "origin", name, ref: source, tracking };
  }
  return undefined;
}

const deleteRefs = async (git: Git, cwd: string, prefix: string): Promise<void> => {
  const listed = await git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", prefix], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  });
  if (listed.code !== 0) return;
  const lines: Array<string> = [];
  for (const line of listed.stdout.split("\n")) {
    const at = line.indexOf(" ");
    const ref = line.slice(at + 1);
    // Only ever a ref of Sync's own namespace, and only where it was read to be.
    if (at > 0 && ref.startsWith(SYNC_REFS)) lines.push(`delete ${ref} ${line.slice(0, at)}`);
  }
  if (lines.length > 0)
    await git(cwd, ["update-ref", "--no-deref", "--stdin"], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
      input: `${lines.join("\n")}\n`,
    });
};

export type Fetched =
  | { readonly ok: true; readonly heads: Map<string, string> }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetches `origin`'s branches: one network step. They go into the tracking
 * refs (never the destinations the repository's settings name, never pruned)
 * and into a folder of Sync's own refs made for this fetch; that folder is
 * read for what the fetch brought, and removed again whatever happened, also
 * when the call was cancelled. Call it with the checkout held.
 */
export async function fetchOrigin(
  git: Git,
  cwd: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Fetched> {
  const mine = `${SYNC_REFS}${NodeCrypto.randomUUID()}/`;
  try {
    // What a server that stopped mid-fetch left behind goes first: nothing else writes here.
    await deleteRefs(git, cwd, SYNC_REFS);
    const fetched = await git(cwd, fetchArgs(mine), {
      allowFailure: true,
      timeoutMs: FETCH_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).catch((cause: unknown) => ({
      code: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : "The fetch did not finish.",
    }));
    if (fetched.code !== 0) return { ok: false, reason: fetched.stderr };
    const listed = await git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", mine], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
    });
    if (listed.code !== 0) return { ok: false, reason: listed.stderr };
    const heads = new Map<string, string>();
    for (const line of listed.stdout.split("\n")) {
      if (line.length === 0) continue;
      const at = line.indexOf(" ");
      const oid = line.slice(0, at);
      const ref = line.slice(at + 1);
      if (at < 0 || !OID.test(oid) || !ref.startsWith(mine))
        return { ok: false, reason: "What the fetch brought could not be read." };
      heads.set(`${HEADS}${ref.slice(mine.length)}`, oid);
    }
    return { ok: true, heads };
  } finally {
    await deleteRefs(git, cwd, mine).catch(() => undefined);
  }
}

/**
 * The fetch names its own destinations (`--refmap=` switches the configured
 * ones off) and never prunes, whatever `fetch.prune`, `fetch.pruneTags` or
 * `remote.origin.prune` say. Tags come as Git brings them by default: new ones
 * that point into the fetched history, and none that would replace a tag here.
 */
export const fetchArgs = (namespace: string): Array<string> => [
  "fetch",
  "--quiet",
  "--no-prune",
  "--no-prune-tags",
  "--no-recurse-submodules",
  "--refmap=",
  "origin",
  `+${HEADS}*:${TRACKING}*`,
  `+${HEADS}*:${namespace}*`,
];
