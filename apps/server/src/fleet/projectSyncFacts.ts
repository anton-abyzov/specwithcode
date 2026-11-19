// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/** A repository as Sync (1390) plans from it: its fetch of `origin` and the facts read after. */
import * as NodeFSP from "node:fs/promises";

import {
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  projectSyncUpstreamMappingDetail,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncRepositoryStatus,
} from "@specweave-studio/contracts";

import { withCheckout } from "./checkoutLock.ts";
import { canonicalOrigin } from "./handoffGitTypes.ts";
import {
  branchAndHead,
  gitReason,
  LOCAL_MS,
  read,
  SHA,
  type SyncContext,
  type SyncGit,
  type SyncRepository,
  uncommittedCount,
} from "./projectSyncGit.ts";
import {
  checkoutIdentity,
  everKnown,
  fetchAddress,
  fetchOrigin,
  type RepositoryRecord,
  revokeElsewhere,
  upstreamOf,
} from "./projectSyncOrigin.ts";

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

/** Path, branch, head commit, clean or not: a local Git read, no network. */
export async function readRepositoryStatus(
  git: SyncGit,
  repository: SyncRepository,
): Promise<ProjectSyncRepositoryStatus> {
  const [{ branch, head }, uncommitted] = await Promise.all([
    branchAndHead(git, repository.cwd),
    uncommittedCount(git, repository.cwd),
  ]);
  return { path: repository.path, branch, head, clean: uncommitted === 0 };
}

/** The commit a ref of this repository is at, or null. */
export async function commitAt(git: SyncGit, cwd: string, ref: string): Promise<string | null> {
  const commit = await read(git, cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  return commit.ok && SHA.test(commit.text) ? commit.text : null;
}

/** `origin`'s address as it is written in the repository's settings; empty without one. */
export async function writtenAddress(git: SyncGit, cwd: string): Promise<string> {
  const urls = await read(git, cwd, ["config", "--get-all", "remote.origin.url"]);
  return urls.ok ? (urls.text.split("\n")[0] ?? "").trim() : "";
}

/**
 * A repository as the plan needs it. `fetch: true` fetches `origin` first and
 * writes what the fetch brought into the call's record; the recheck before a
 * fast-forward passes false and reads local Git. Either way `origin`'s fetch
 * settings are read, and a repository they make unsafe to fetch is reported as
 * `unusual-config` and never fetched. Ahead and behind are counted against the
 * commit the record holds for the branch's upstream on `origin`; without a
 * record (a failed fetch), against the tracking ref, for the reader only.
 */
export async function readRepositoryFacts(
  context: SyncContext,
  repository: SyncRepository,
  options: { readonly fetch: boolean },
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  // The address as written: another machine applies its own rewrites to it.
  const address = await writtenAddress(git, cwd);
  const hasOrigin = address.length > 0;
  let fetch: ProjectSyncRepositoryFacts["fetch"] = hasOrigin ? "not-run" : "no-remote";
  let fetchError: string | null = null;
  if (hasOrigin) {
    const [refspecs, mirror] = await Promise.all([
      read(git, cwd, ["config", "--get-all", "remote.origin.fetch"]),
      // As Git reads it: any true value, also a bare key. Exit 1 means it is not set.
      git(cwd, ["config", "--get-all", "--bool", "remote.origin.mirror"], {
        allowFailure: true,
        timeoutMs: LOCAL_MS,
      }),
    ]);
    const unusual = unusualFetchConfig({
      mirror:
        mirror.code === 0 ? mirror.stdout.trim().split("\n").at(-1) !== "false" : mirror.code !== 1,
      refspecs: refspecs.ok ? refspecs.text.split("\n") : [],
    });
    if (unusual !== null) {
      fetch = "unusual-config";
      fetchError = unusual;
    }
  }
  const realPath = await NodeFSP.realpath(cwd).catch(() => cwd);
  let record: RepositoryRecord | undefined;
  if (options.fetch) {
    context.fetched?.repositories.delete(realPath);
    if (fetch === "not-run") {
      // One writer of the app at a time in a checkout, whatever project asks.
      const brought = await withCheckout(realPath, async () => {
        const fetchUrl = await fetchAddress(git, cwd);
        const fetched = await fetchOrigin(
          git,
          cwd,
          context.signal === undefined ? {} : { signal: context.signal },
        );
        if (!fetched.ok) return fetched;
        const identity = await checkoutIdentity(git, cwd);
        return { ok: true as const, heads: fetched.heads, fetchUrl, identity };
      });
      fetch = brought.ok ? "ok" : "failed";
      if (!brought.ok) fetchError = gitReason(brought.reason);
      else if (brought.identity !== null && brought.fetchUrl !== null) {
        // Published only now, the fetch having gone through: this, and nothing a listing
        // or another fetch says, is what a move may go by.
        record = {
          ...brought.identity,
          fetchUrl: brought.fetchUrl,
          heads: brought.heads,
          revoked: new Map(),
        };
        // What older fetches of this checkout hold for a branch that is elsewhere now, or
        // gone, is not moved to any more.
        for (const ref of everKnown(record.checkout))
          revokeElsewhere(record.checkout, ref, brought.heads.get(ref));
        context.fetched?.repositories.set(record.checkout, record);
      }
    }
  } else record = context.fetched?.repositories.get(realPath);
  try {
    return await checkoutFacts(context, repository, { address, fetch, fetchError, record });
  } catch (cause) {
    // The fetch went through; it is the read after it that failed. Said as that.
    if (fetch !== "ok") throw cause;
    return {
      ...unreadFacts(path, PROJECT_SYNC_FETCHED_UNREAD_DETAIL),
      remote: cloneAddress(address),
      fetch,
    };
  }
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

/** The local reads of the facts: branch, upstream, counts, files, running work. */
async function checkoutFacts(
  context: SyncContext,
  repository: SyncRepository,
  known: {
    readonly address: string;
    readonly fetch: ProjectSyncRepositoryFacts["fetch"];
    readonly fetchError: string | null;
    readonly record: RepositoryRecord | undefined;
  },
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  const { record } = known;
  const { branch, head } = await branchAndHead(git, cwd);
  const upstream = branch === null ? null : ((await upstreamOf(git, cwd, branch)) ?? null);
  const origin = upstream?.kind === "origin" ? upstream : null;
  const tracking = origin === null ? null : await commitAt(git, cwd, origin.tracking);
  // What this very fetch brought for the branch, by its hash. The fetch never prunes, so
  // a branch deleted on `origin` keeps its tracking ref here: it is gone when the fetch
  // did not bring it, so nothing is planned to move to it and it is never called up to
  // date. A tracking ref that is elsewhere than the fetch left it is another fetch's doing.
  const brought =
    record === undefined || origin === null ? undefined : record.heads.get(origin.ref);
  const revoked = origin === null ? undefined : record?.revoked.get(origin.ref);
  const gone =
    record !== undefined && origin !== null && (brought === undefined || revoked === "gone");
  const target = record === undefined ? tracking : (brought ?? null);
  let ahead = 0;
  let behind = 0;
  let upstreamName: string | null = null;
  const against = target ?? tracking;
  if (origin !== null && head !== null && against !== null) {
    // Counted against a commit, by its hash.
    const counted = await read(git, cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${head}...${against}`,
    ]);
    const [left, right] = counted.text.split(/\s+/).map(Number);
    if (counted.ok && Number.isInteger(left) && Number.isInteger(right)) {
      upstreamName = origin.name.slice(0, 512);
      ahead = left!;
      behind = right!;
    }
  }
  const movedSince = !gone && brought !== undefined && tracking !== brought;
  const uncommitted = await uncommittedCount(git, cwd);
  return {
    path,
    branch,
    head,
    upstream: upstreamName,
    otherUpstream: upstream?.kind === "other" ? upstream.name.slice(0, 512) : null,
    ...(upstream?.kind === "mapped"
      ? { upstreamUnusual: projectSyncUpstreamMappingDetail(upstream.name, upstream.source) }
      : {}),
    ...(gone ? { upstreamGone: true } : {}),
    ...(movedSince ? { upstreamMoved: true } : {}),
    ahead,
    behind,
    // A status Git could not read is never treated as clean, and never given a count
    // of files nobody saw: the plan holds the checkout on `stateUnread`.
    uncommitted: uncommitted ?? 0,
    ...(uncommitted === null ? { stateUnread: true } : {}),
    // Read last, after the status read above.
    inUseBy: await context.inUse(cwd),
    remote: cloneAddress(known.address),
    fetch: known.fetch,
    fetchError: known.fetchError,
  };
}

/** The address when another machine can clone from it: no credential, no folder of this machine. */
export function cloneAddress(address: string): string | null {
  if (address.length === 0 || address.startsWith("-")) return null;
  const canonical = canonicalOrigin(address);
  return canonical === null || isLocalAddress(canonical) ? null : address;
}
