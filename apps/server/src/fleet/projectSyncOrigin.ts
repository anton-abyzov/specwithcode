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
import { canonicalOrigin } from "./handoffGitTypes.ts";

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
 * The hosts one call has found silent. An ask that does not come back within
 * its limit closes its host for the rest of the call: the other repositories
 * of that host are not asked, so a host that is down costs a call one round
 * of asks and not one per repository. Another host is never closed by it, and
 * an ask that is answered (also with an error) closes nothing.
 */
export interface AskBudget {
  /** The limit for the next ask of this host in ms: 0 once the host is closed. */
  readonly next: (host: string) => number;
  readonly close: (host: string) => void;
}
export function askBudget(): AskBudget {
  const closed = new Set<string>();
  return {
    next: (host) => (closed.has(host) ? 0 : ORIGIN_ASK_MS),
    close: (host) => void closed.add(host),
  };
}

/** What tells one origin's host from another's: its name, or the whole address of a folder. */
export function originHost(address: string): string {
  const canonical = canonicalOrigin(address);
  if (canonical === null || canonical.startsWith("file://")) return address;
  return canonical.split("/")[0] ?? address;
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
    /** The call's silent hosts, and the host this ask goes to. */
    readonly budget?: AskBudget;
    readonly host?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Listed> {
  const host = options.host ?? cwd;
  const timeoutMs = options.budget === undefined ? ORIGIN_ASK_MS : options.budget.next(host);
  if (timeoutMs <= 0) return { ok: false, reason: null };
  const listed = await git(
    cwd,
    ["ls-remote", "--heads", "origin", ...(options.ref === undefined ? [] : [options.ref])],
    {
      allowFailure: true,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  ).catch(() => null);
  if (listed === null) {
    // It did not come back in time (or Git could not be started): the host is not asked again.
    options.budget?.close(host);
    return { ok: false, reason: null };
  }
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
  // @effect-diagnostics-next-line globalDate:off - a plain async helper; when origin listed is wall-clock time.
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
