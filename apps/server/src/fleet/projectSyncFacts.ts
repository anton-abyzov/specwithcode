// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/** A repository as Sync (1390) plans from it: its fetch of `origin` and the facts read after. */
import {
  PROJECT_SYNC_NOT_LISTED_DETAIL,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncRepositoryStatus,
} from "@specweave-studio/contracts";

import { canonicalOrigin } from "./handoffGitTypes.ts";
import {
  branchAndHead,
  FETCH_MS,
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
  dropOrigin,
  listOrigin,
  noteOrigin,
  originHost,
  originRecord,
} from "./projectSyncOrigin.ts";

/** What Sync fetches, and where to: `origin`'s branches into its remote-tracking refs. */
const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/**
 * The fetch names its own destinations (`--refmap=` switches the configured
 * ones off) and never prunes, whatever `fetch.prune`, `fetch.pruneTags` or
 * `remote.origin.prune` say. Tags come as Git brings them by default: new ones
 * that point into the fetched history, and none that would replace a tag here.
 */
const FETCH_ARGS = [
  "fetch",
  "--quiet",
  "--no-prune",
  "--no-prune-tags",
  "--no-recurse-submodules",
  "--refmap=",
  "origin",
  FETCH_REFSPEC,
];

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

/**
 * A repository as the plan needs it. `fetch: true` fetches `origin` first; the
 * recheck before a fast-forward passes false and reads local Git. Either way
 * `origin`'s fetch settings are read, and a repository they make unsafe to
 * fetch is reported as `unusual-config` and never fetched.
 */
export async function readRepositoryFacts(
  context: SyncContext,
  repository: SyncRepository,
  options: { readonly fetch: boolean },
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  // The address as written: another machine applies its own rewrites to it.
  const urls = await read(git, cwd, ["config", "--get-all", "remote.origin.url"]);
  const address = urls.ok ? (urls.text.split("\n")[0] ?? "").trim() : "";
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
  /** What origin listed to this very call. */
  let fresh: ReadonlyMap<string, string> | undefined;
  // What origin lists is asked first, once, for all its branches: the fetch that follows is
  // planned and moved by that list. An origin that does not answer the ask is not fetched,
  // so it holds the call for the ask's short limit and not for a fetch's long one.
  if (fetch === "not-run" && options.fetch) {
    const listed = await listOrigin(git, cwd, {
      host: originHost(address),
      ...(context.asks === undefined ? {} : { budget: context.asks }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (listed.ok) {
      fresh = listed.heads;
      await noteOrigin(context.origin, git, cwd, address, listed.heads);
    } else {
      fetch = "failed";
      fetchError =
        listed.reason === null ? PROJECT_SYNC_NOT_LISTED_DETAIL : gitReason(listed.reason);
    }
  }
  if (fetch === "not-run" && options.fetch) {
    const fetched = await git(cwd, FETCH_ARGS, {
      allowFailure: true,
      timeoutMs: FETCH_MS,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }).catch((cause: unknown) => ({
      code: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : "The fetch did not finish.",
    }));
    fetch = fetched.code === 0 ? "ok" : "failed";
    if (fetched.code !== 0) fetchError = gitReason(fetched.stderr);
  }
  // A fetch that did not go through leaves nothing to go by.
  if (options.fetch && fetch !== "ok") await dropOrigin(context.origin, cwd);
  // This call's own list, or what an earlier fetch of this project kept for this checkout.
  const heads =
    fetch === "ok" && fresh !== undefined
      ? fresh
      : hasOrigin && !(options.fetch && fetch !== "ok")
        ? (await originRecord(context.origin, git, cwd, address))?.heads
        : undefined;
  const { branch, head } = await branchAndHead(git, cwd);
  const upstream = branch === null ? null : await originUpstream(git, cwd);
  let ahead = 0;
  let behind = 0;
  let upstreamName: string | null = null;
  if (upstream?.commit != null && head !== null) {
    // Counted against the commit `origin`'s branch is at, by its hash.
    const counted = await read(git, cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${head}...${upstream.commit}`,
    ]);
    const [left, right] = counted.text.split(/\s+/).map(Number);
    if (counted.ok && Number.isInteger(left) && Number.isInteger(right)) {
      upstreamName = upstream.name.slice(0, 512);
      ahead = left!;
      behind = right!;
    }
  }
  // The fetch never prunes, so a branch deleted on `origin` still reads as it last did,
  // behind or level: it is gone when origin's list does not name it, so nothing is
  // planned to move to it and it is never called up to date. A tracking ref that is not
  // at the commit origin listed (the branch moved right after, or something else fetched)
  // is not what this Sync fetched, and is not moved to either.
  const listedAt =
    heads === undefined || upstream?.ref == null ? undefined : heads.get(upstream.ref);
  const gone = heads !== undefined && upstream?.ref != null && listedAt === undefined;
  const movedSince = listedAt !== undefined && listedAt !== upstream?.commit;
  const uncommitted = await uncommittedCount(git, cwd);
  return {
    path,
    branch,
    head,
    upstream: upstreamName,
    otherUpstream: upstream?.commit === null ? upstream.name.slice(0, 512) : null,
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
    remote: cloneAddress(address),
    fetch,
    fetchError,
  };
}

const ORIGIN_REFS = "refs/remotes/origin/";

/**
 * The branch's upstream, only when it is a branch of `origin`: the one remote
 * Sync fetches. `commit` is where that branch is now. An upstream that is a
 * local branch (`branch.x.remote=.`) or a branch of another remote was not
 * fetched by Sync, so it has no `commit` here and is never moved forward to;
 * its name is kept for the step's reason.
 */
export async function originUpstream(
  git: SyncGit,
  cwd: string,
): Promise<{
  readonly name: string;
  readonly commit: string | null;
  /** The branch's name on `origin`, as `refs/heads/…`; null when the upstream is not origin's. */
  readonly ref: string | null;
} | null> {
  const full = await read(git, cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (!full.ok || !full.text.startsWith("refs/") || full.text.includes("\n")) return null;
  if (!full.text.startsWith(ORIGIN_REFS))
    return { name: full.text.replace(/^refs\/(heads|remotes)\//, ""), commit: null, ref: null };
  const commit = await read(git, cwd, ["rev-parse", "-q", "--verify", `${full.text}^{commit}`]);
  return commit.ok && SHA.test(commit.text)
    ? {
        name: full.text.slice("refs/remotes/".length),
        commit: commit.text,
        ref: `refs/heads/${full.text.slice(ORIGIN_REFS.length)}`,
      }
    : null;
}

/** The address when another machine can clone from it: no credential, no folder of this machine. */
export function cloneAddress(address: string): string | null {
  if (address.length === 0 || address.startsWith("-")) return null;
  const canonical = canonicalOrigin(address);
  return canonical === null || isLocalAddress(canonical) ? null : address;
}
