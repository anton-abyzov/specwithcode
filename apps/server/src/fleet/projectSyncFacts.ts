// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/** A repository as Sync (1390) plans from it: its fetch of `origin` and the facts read after. */
import * as NodeFSP from "node:fs/promises";

import {
  planProjectSyncRepository,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_GIT_TOO_OLD_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_THREADS_UNREAD_DETAIL,
  projectSyncUpstreamMappingDetail,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncRepositoryStatus,
} from "@specweave-studio/contracts";

import { canonicalOrigin } from "./handoffGitTypes.ts";
import {
  commitOf,
  gitReason,
  headBranch,
  LOCAL_MS,
  read,
  shortBranch,
  type SyncContext,
  type SyncGit,
  type SyncRepository,
  uncommittedCount,
  branchAndHead,
} from "./projectSyncGit.ts";
import { fetchOrigin, type Row, upstreamOf } from "./projectSyncRecord.ts";

/**
 * Why `origin` is not fetched, or null: it is a mirror, or one of its fetch
 * lines writes outside `refs/remotes/`. Such a repository keeps its own
 * branches where a fetch writes, so Sync leaves it alone and says so.
 */
export function unusualFetchConfig(input: {
  /** `remote.origin.mirror` as Git reads it; a value Git cannot read as true or false counts as set. */
  readonly mirror: boolean;
  readonly refspecs: ReadonlyArray<string>;
}): string | null {
  if (input.mirror) return "origin is set up as a mirror (remote.origin.mirror).";
  for (const line of input.refspecs) {
    const refspec = line.trim();
    // `^refs/…` leaves refs out and has no destination.
    if (refspec.length === 0 || refspec.startsWith("^")) continue;
    const colon = refspec.indexOf(":");
    if (colon < 0) continue;
    const destination = refspec.slice(colon + 1);
    if (destination.length > 0 && !destination.startsWith("refs/remotes/"))
      return `origin fetches into refs outside refs/remotes/ (remote.origin.fetch ${refspec}).`.slice(
        0,
        1900,
      );
  }
  return null;
}

/**
 * A folder or `file://` address, or one whose host is the machine itself
 * (`localhost`, a loopback address), names a place on one machine only.
 */
export const isLocalAddress = (canonical: string) => {
  if (canonical.startsWith("file://")) return true;
  const host = normalHost(
    (canonical.split("/")[0] ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, ""),
  );
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    // 127.0.0.0/8 and 0.0.0.0/8, which a machine reads as itself.
    /^(127|0)(\.\d{1,3}){3}$/.test(host) ||
    // `::1`, `::`, and an IPv4 loopback address written inside an IPv6 one.
    /^::(1|(ffff:)?(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)|ffff:0:0)?$/.test(host)
  );
};

/**
 * A host as the network reads it: lower case, no trailing dot, and an address
 * in its one usual spelling, so `127.1`, `2130706433`, `0x7f000001` and
 * `0177.0.0.1` all read `127.0.0.1` and `0:0:0:0:0:0:0:1` reads `::1`.

/**
 * A host as the network reads it: lower case, no trailing dot, and an address
 * in its one usual spelling, so `127.1`, `2130706433`, `0x7f000001` and
 * `0177.0.0.1` all read `127.0.0.1` and `0:0:0:0:0:0:0:1` reads `::1`.
 */
function normalHost(written: string): string {
  const host = written.toLowerCase().replace(/\.+$/, "");
  try {
    return new URL(`http://${host.includes(":") ? `[${host}]` : host}/`).hostname.replace(
      /^\[|\]$|\.+$/g,
      "",
    );
  } catch {
    return host;
  }
}

/**
 * Path, branch, head commit, clean or not: a local Git read, no network. A
 * checkout any of whose reads failed is `unread`, with no branch, no commit
 * and not clean: none of those is a finding.
 */
export async function readRepositoryStatus(
  git: SyncGit,
  repository: SyncRepository,
): Promise<ProjectSyncRepositoryStatus> {
  const unread = { path: repository.path, branch: null, head: null, clean: false, unread: true };
  if (repository.unread === true) return unread;
  const [{ branch, head, unread: notRead }, uncommitted] = await Promise.all([
    branchAndHead(git, repository.cwd).catch(() => ({ branch: null, head: null, unread: true })),
    uncommittedCount(git, repository.cwd),
  ]);
  if (notRead || uncommitted === null) return unread;
  return { path: repository.path, branch, head, clean: uncommitted === 0 };
}

/** `origin`'s address as written in the settings: absent only on Git's "not set" (exit 1). */
async function writtenAddress(git: SyncGit, cwd: string) {
  const urls = await git(cwd, ["config", "--get-all", "remote.origin.url"], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  if (urls === null) return { kind: "unread" as const };
  if (urls.code === 1 && urls.stdout.trim().length === 0) return { kind: "absent" as const };
  if (urls.code !== 0) return { kind: "unread" as const };
  return { kind: "value" as const, value: (urls.stdout.split("\n")[0] ?? "").trim() };
}

/** Why `origin` is not fetched, null when it may be, undefined when its settings could not be read. */
async function fetchSettings(git: SyncGit, cwd: string): Promise<string | null | undefined> {
  const [refspecs, mirror] = await Promise.all([
    git(cwd, ["config", "--get-all", "remote.origin.fetch"], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
    }).catch(() => null),
    // As Git reads it: any true value, also a bare key. Exit 1 means it is not set.
    git(cwd, ["config", "--get-all", "--bool", "remote.origin.mirror"], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
    }).catch(() => null),
  ]);
  if (refspecs === null || mirror === null) return undefined;
  if (refspecs.code !== 0 && refspecs.code !== 1) return undefined;
  return unusualFetchConfig({
    mirror:
      mirror.code === 0 ? mirror.stdout.trim().split("\n").at(-1) !== "false" : mirror.code !== 1,
    refspecs: refspecs.code === 0 ? refspecs.stdout.split("\n") : [],
  });
}

/**
 * A repository after Sync's fetch of `origin`, and the row the fetch record
 * keeps for it. The outcome follows what actually ran:
 *
 * - `not-run`: a read before the fetch failed, so Git was never asked to fetch;
 * - `ok`: fetched, with the fetch's own output as the record of what it brought;
 * - `ok` with `stateUnread`: fetched, but its output, or the checkout after it,
 *   could not be read, so nothing may move;
 * - `failed`: Git's fetch failed, with Git's reason.
 *
 * The row is written into `context.fetched` (published by the caller once the
 * whole call has ended); an unreadable row is written too, and moves nothing.
 */
export async function readRepositoryFacts(
  context: SyncContext,
  repository: SyncRepository,
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  const notRun = (detail: string): ProjectSyncRepositoryFacts => ({
    ...unreadFacts(path, detail),
    fetch: "not-run",
  });
  const address = await writtenAddress(git, cwd);
  if (address.kind === "unread") return notRun(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  const remote = address.kind === "value" ? cloneAddress(address.value) : null;
  const where = await gitFolders(git, cwd);
  if (where === null) return notRun(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (address.kind === "absent") {
    return checkoutFacts(context, repository, where, {
      remote,
      fetch: "no-remote",
      fetchError: null,
      heads: null,
    });
  }
  const unusual = await fetchSettings(git, cwd);
  if (unusual === undefined) return notRun(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (unusual !== null)
    return checkoutFacts(context, repository, where, {
      remote,
      fetch: "unusual-config",
      fetchError: unusual,
      heads: null,
    });
  const fetched = await fetchOrigin(
    git,
    cwd,
    context.signal === undefined ? {} : { signal: context.signal },
  );
  if (!fetched.ok)
    return checkoutFacts(context, repository, where, {
      remote,
      fetch: "failed",
      fetchError: gitReason(fetched.reason),
      heads: null,
    });
  // The fetch went through. Without a readable record of what it wrote nothing moves; the
  // checkout's row says it is unread, so a run by this fetch says that too.
  if (fetched.heads === null)
    return unreadRow(context, path, where, {
      ...unreadFacts(
        path,
        fetched.tooOld ? PROJECT_SYNC_GIT_TOO_OLD_DETAIL : PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
      ),
      remote,
      fetch: "ok",
    });
  try {
    return await checkoutFacts(context, repository, where, {
      remote,
      fetch: "ok",
      fetchError: null,
      heads: fetched.heads,
    });
  } catch {
    // The read after the fetch failed: said as that, with nothing to move by.
    return unreadRow(context, path, where, {
      ...unreadFacts(path, PROJECT_SYNC_FETCHED_UNREAD_DETAIL),
      remote,
      fetch: "ok",
    });
  }
}

/** Writes the row of a checkout that could not be read, which moves nothing; returns `facts`. */
function unreadRow(
  context: SyncContext,
  path: string,
  where: { readonly cwd: string; readonly gitDir: string },
  facts: ProjectSyncRepositoryFacts,
): ProjectSyncRepositoryFacts {
  context.fetched?.rows.set(path, {
    path,
    cwd: where.cwd,
    gitDir: where.gitDir,
    readable: false,
    branch: null,
    head: null,
    upstream: null,
    target: null,
    originHeads: new Map(),
    ahead: 0,
    behind: 0,
    planned: planProjectSyncRepository(facts, null),
  });
  return facts;
}

/** The checkout's real path and Git folder, or null when either could not be read. */
export async function gitFolders(
  git: SyncGit,
  cwd: string,
): Promise<{ readonly cwd: string; readonly gitDir: string } | null> {
  const [real, dirs] = await Promise.all([
    NodeFSP.realpath(cwd).catch(() => null),
    read(git, cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--absolute-git-dir",
    ]).catch(() => null),
  ]);
  if (real === null || dirs === null || !dirs.ok) return null;
  const [top, gitDir] = dirs.text.split("\n");
  if (top === undefined || gitDir === undefined || gitDir.length === 0) return null;
  const realTop = await NodeFSP.realpath(top).catch(() => null);
  return realTop === real ? { cwd: real, gitDir } : null;
}

/** Facts for a folder nothing is known of: it is held, and `detail` says why. */
export const unreadFacts = (path: string, detail: string): ProjectSyncRepositoryFacts => ({
  path,
  branch: null,
  head: null,
  upstream: null,
  otherUpstream: null,
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  stateUnread: true,
  unreadDetail: detail,
  inUseBy: null,
  remote: null,
  fetch: "not-run",
  fetchError: null,
});

/**
 * The local reads after the fetch: branch, upstream, counts, files, running
 * work. Ahead and behind are counted against the commit the fetch brought for
 * the upstream, by its id. Any read that fails makes the row unreadable and
 * the facts `stateUnread`; it is never taken for detached, no upstream or a
 * count. Writes the row into the call's record.
 */
async function checkoutFacts(
  context: SyncContext,
  repository: SyncRepository,
  where: { readonly cwd: string; readonly gitDir: string },
  known: {
    readonly remote: string | null;
    readonly fetch: ProjectSyncRepositoryFacts["fetch"];
    readonly fetchError: string | null;
    readonly heads: ReadonlyMap<string, string> | null;
  },
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  const { heads } = known;
  let unread = false;
  const branchRead = await headBranch(git, cwd);
  const headRead = await commitOf(git, cwd, "HEAD");
  if (branchRead.kind === "unread" || headRead.kind === "unread") unread = true;
  const branch = branchRead.kind === "value" ? branchRead.value : null;
  const head = headRead.kind === "value" ? headRead.value : null;
  const upstream = branch === null ? null : await upstreamOf(git, cwd, branch);
  if (upstream === undefined) unread = true;
  const origin = upstream?.kind === "origin" ? upstream : null;
  // What this very fetch brought for the branch, by its id. The fetch never prunes, so a
  // branch deleted on `origin` keeps its tracking ref here: it is gone when the fetch did
  // not list it, and is never planned to move or called up to date.
  const target = heads === null || origin === null ? undefined : heads.get(origin.ref);
  const gone = heads !== null && origin !== null && target === undefined;
  let ahead = 0;
  let behind = 0;
  let upstreamName: string | null = null;
  if (origin !== null && head !== null && target !== undefined) {
    const counted = await read(git, cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${head}...${target}`,
    ]).catch(() => null);
    const [left, right] = (counted?.text ?? "").split(/\s+/).map(Number);
    if (counted?.ok === true && Number.isInteger(left) && Number.isInteger(right)) {
      ahead = left!;
      behind = right!;
    } else unread = true;
    upstreamName = origin.name.slice(0, 512);
  } else if (origin !== null) upstreamName = origin.name.slice(0, 512);
  const uncommitted = await uncommittedCount(git, cwd);
  if (uncommitted === null) unread = true;
  // Read last, after the status read above. A list that could not be read is no thread.
  const thread = await context.inUse(cwd);
  const threadsUnread = thread === undefined;
  const inUseBy = thread ?? null;
  const facts: ProjectSyncRepositoryFacts = {
    path,
    branch: branch === null ? null : shortBranch(branch),
    head,
    upstream: upstreamName,
    otherUpstream: upstream?.kind === "other" ? upstream.name.slice(0, 512) : null,
    ...(upstream?.kind === "mapped"
      ? { upstreamUnusual: projectSyncUpstreamMappingDetail(upstream.name, upstream.source) }
      : {}),
    ...(gone ? { upstreamGone: true } : {}),
    ...(target === undefined ? {} : { upstreamCommit: target }),
    ahead,
    behind,
    uncommitted: uncommitted ?? 0,
    ...(unread || threadsUnread
      ? {
          stateUnread: true,
          unreadDetail: unread
            ? known.fetch === "ok"
              ? PROJECT_SYNC_FETCHED_UNREAD_DETAIL
              : PROJECT_SYNC_STATE_UNREAD_DETAIL
            : PROJECT_SYNC_THREADS_UNREAD_DETAIL,
        }
      : {}),
    inUseBy,
    remote: known.remote,
    fetch: known.fetch,
    fetchError: known.fetchError,
  };
  {
    // Every checkout the fetch read has its row; only a readable one with the fetch's own
    // record of origin's branches can move.
    const row: Row = {
      path,
      cwd: where.cwd,
      gitDir: where.gitDir,
      readable: !unread && !threadsUnread && heads !== null,
      branch,
      head,
      upstream: upstream === null || upstream === undefined ? null : upstream.tuple,
      target: target ?? null,
      originHeads: heads ?? new Map(),
      ahead,
      behind,
      planned: planProjectSyncRepository(facts, null),
    };
    context.fetched?.rows.set(path, row);
  }
  return facts;
}

/** The address when another machine can clone from it: no credential, no folder of this machine. */
export function cloneAddress(address: string): string | null {
  if (address.length === 0 || address.startsWith("-")) return null;
  const canonical = canonicalOrigin(address);
  return canonical === null || isLocalAddress(canonical) ? null : address;
}
