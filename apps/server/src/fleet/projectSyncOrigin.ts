// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like ProjectSync.ts.
/**
 * What `origin` listed to a Sync fetch (1390). Sync moves a checkout only to a
 * commit `origin` itself listed for the branch, by object id: never to a branch
 * by its name, and never to wherever a tracking ref reads later. One list is
 * taken per repository per fetch and kept as a record, bound to the checkout
 * (its real path and the identity of its Git folder) and to `origin`'s address.
 * A record is never handed on: not to another project on the same checkout,
 * not to a clone made again at the same path, not across a changed address.
 */
import * as NodeFSP from "node:fs/promises";

import type { GitResult } from "./folderTransfer/git.ts";

type Git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  },
) => Promise<GitResult>;

/** How long one ask of `origin` for its branches may take. */
export const ORIGIN_ASK_MS = 10_000;
/** How long the asks of one fast-forward call may take together (they run one at a time). */
export const ORIGIN_ASK_RUN_TOTAL_MS = 30_000;
/**
 * How long the asks of one fetch call that got no list may take together. An ask that is
 * answered is not counted there: a project with many repositories is not cut short for
 * having many, and each answer still comes within the limit of one ask.
 */
export const ORIGIN_ASK_FETCH_FAILED_TOTAL_MS = 30_000;

const LOCAL_MS = 30_000;
const LISTED = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(refs\/heads\/\S.*)$/;

export interface OriginRecord {
  /** The checkout's real path. */
  readonly checkout: string;
  /** Its Git folder: device, inode and time of birth. A clone made again has another. */
  readonly identity: string;
  /** `origin`'s address as the repository's settings had it at the fetch. */
  readonly url: string;
  /** Every branch `origin` listed, `refs/heads/…` to the commit it listed it at. */
  readonly heads: ReadonlyMap<string, string>;
  readonly atMs: number;
}

/** The records of one project on this server, by the checkout's real path. */
export type OriginRecords = Map<string, OriginRecord>;

const byProject = new Map<string, OriginRecords>();
/** One project's records, kept for as long as the server runs. Another project has its own. */
export function originRecordsOf(projectId: string): OriginRecords {
  let records = byProject.get(projectId);
  if (records === undefined) {
    records = new Map();
    byProject.set(projectId, records);
  }
  return records;
}

/**
 * The time the asks of one call may take together. An ask is charged what it
 * took (with `failedOnly`, only one that got no list); when the time is used
 * up no further ask is made, so a call never waits on `origin` for longer
 * than its total plus the asks under way.
 */
export interface AskBudget {
  /** The limit for the next ask in ms: 0 when the time is used up. */
  readonly next: () => number;
  readonly spend: (ms: number, answered: boolean) => void;
}
export function askBudget(
  totalMs: number,
  options: { readonly failedOnly?: boolean } = {},
): AskBudget {
  let left = totalMs;
  return {
    next: () => Math.max(0, Math.min(ORIGIN_ASK_MS, left)),
    spend: (ms, answered) => {
      if (!(answered && options.failedOnly === true)) left -= Math.max(0, ms);
    },
  };
}

export type Listed =
  | { readonly ok: true; readonly heads: Map<string, string> }
  /** `reason` is Git's own words, or null when the ask did not end in time or was not made. */
  | { readonly ok: false; readonly reason: string | null };

/**
 * The branches `origin` lists right now, each with its commit: all of them, or
 * the one `ref` names. A read of the remote; it writes nothing here. One
 * request, under a short limit.
 */
export async function listOrigin(
  git: Git,
  cwd: string,
  options: {
    readonly ref?: string;
    readonly budget?: AskBudget;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Listed> {
  const timeoutMs = options.budget === undefined ? ORIGIN_ASK_MS : options.budget.next();
  if (timeoutMs <= 0) return { ok: false, reason: null };
  const started = Date.now();
  const listed = await git(
    cwd,
    ["ls-remote", "--heads", "origin", ...(options.ref === undefined ? [] : [options.ref])],
    {
      allowFailure: true,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  ).catch(() => null);
  options.budget?.spend(Date.now() - started, listed !== null && listed.code === 0);
  if (listed === null) return { ok: false, reason: null };
  if (listed.code !== 0) return { ok: false, reason: listed.stderr };
  const heads = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    if (line.length === 0) continue;
    const match = LISTED.exec(line);
    // A list that is not one is no list: nothing is planned on a guess.
    if (match === null) return { ok: false, reason: null };
    heads.set(match[2]!, match[1]!);
  }
  return { ok: true, heads };
}

/** The checkout's real path and what tells its Git folder from one made again there. */
async function identityOf(
  git: Git,
  cwd: string,
): Promise<{ readonly checkout: string; readonly identity: string } | null> {
  const [checkout, gitDir] = await Promise.all([
    NodeFSP.realpath(cwd).catch(() => null),
    git(cwd, ["rev-parse", "--absolute-git-dir"], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
    }).catch(() => null),
  ]);
  if (checkout === null || gitDir === null || gitDir.code !== 0) return null;
  const stat = await NodeFSP.lstat(gitDir.stdout.trim(), { bigint: true }).catch(() => null);
  if (stat === null || !stat.isDirectory()) return null;
  return { checkout, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` };
}

/** Keeps what `origin` just listed for this checkout, in place of what was kept before. */
export async function noteOrigin(
  records: OriginRecords | undefined,
  git: Git,
  cwd: string,
  url: string,
  heads: ReadonlyMap<string, string>,
): Promise<void> {
  if (records === undefined) return;
  const at = await identityOf(git, cwd);
  if (at === null) return dropOrigin(records, cwd);
  records.set(at.checkout, { ...at, url, heads, atMs: Date.now() });
}

/**
 * The record of this checkout, only while it is still that checkout and still
 * has that `origin`: one that no longer fits is dropped here and never used.
 */
export async function originRecord(
  records: OriginRecords | undefined,
  git: Git,
  cwd: string,
  url: string,
): Promise<OriginRecord | undefined> {
  if (records === undefined || records.size === 0) return undefined;
  const at = await identityOf(git, cwd);
  if (at === null) return undefined;
  const record = records.get(at.checkout);
  if (record === undefined) return undefined;
  if (record.identity !== at.identity || record.url !== url) {
    records.delete(at.checkout);
    return undefined;
  }
  return record;
}

export async function dropOrigin(records: OriginRecords | undefined, cwd: string): Promise<void> {
  if (records === undefined) return;
  records.delete(cwd);
  const real = await NodeFSP.realpath(cwd).catch(() => null);
  if (real !== null) records.delete(real);
}
