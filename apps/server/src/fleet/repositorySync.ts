// @effect-diagnostics nodeBuiltinImport:off - Plain promises over real Git, like folderTransfer/git.ts.
/**
 * Fetches remote-tracking branches before a turn and reports the checkout's state.
 * A checkout may also be used by a terminal or another Git client. Leave its
 * branch, index and working files to explicit Git actions.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { discoverCopyScopes } from "./folderCopyScope.ts";
import { originCandidates, remoteEnv, runGit } from "./folderTransfer/git.ts";
import { readFolderLayout } from "../project/FolderLayout.ts";

/** Two attempts, SSH then HTTPS, still fit inside a turn's 30 seconds. */
const FETCH_MS = 13_000;
const LOCAL_MS = 15_000;
const PARALLEL = 4;
const MANAGED_REPOSITORIES = ".studio-repositories";
const MAX_REPOSITORIES = 50;
/** Threads started together share one fetch. */
const FETCH_FRESH_MS = 60_000;
/** A repository too large to fetch within a turn gets this long, away from any turn. */
const CATCH_UP_MS = 30 * 60_000;
/** A failed catch-up waits this long, so an origin that is down isn't asked at every start. */
const CATCH_UP_RETRY_MS = 10 * 60_000;

/** Coordinators that just moved here: their next turn on this machine syncs even if not its first. */
const moved = new Set<string>();
export const markProjectMoved = (projectId: string) => void moved.add(projectId);
export const takeProjectMoved = (projectId: string) => moved.delete(projectId);

export type RepositorySyncOutcome =
  | { readonly kind: "behind"; readonly commits: number }
  | { readonly kind: "current" }
  | { readonly kind: "no-remote" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "uncommitted"; readonly changes: number }
  | { readonly kind: "other-branch"; readonly branch: string | null; readonly main: string | null }
  | { readonly kind: "diverged"; readonly ahead: number; readonly behind: number }
  | { readonly kind: "in-use" }
  | { readonly kind: "failed" };

export interface RepositorySyncResult {
  readonly path: string;
  readonly name: string;
  readonly outcome: RepositorySyncOutcome;
}

interface GitOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

const local = async (cwd: string, args: ReadonlyArray<string>, options: GitOptions) => {
  const result = await runGit(cwd, args, {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
    // Status never rewrites the index of a checkout it only looks at.
    env: { GIT_OPTIONAL_LOCKS: "0" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { ok: result.code === 0, text: result.stdout.trim() };
};

const remote = (cwd: string, args: ReadonlyArray<string>, options: GitOptions) =>
  runGit(cwd, args, {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? FETCH_MS,
    env: { ...remoteEnv(), GIT_TERMINAL_PROMPT: "0" },
    ...(options.signal ? { signal: options.signal } : {}),
    // A killed fetch is an origin that didn't answer: the next address still gets its try.
  }).catch(() => ({ code: 1, stdout: "", stderr: "" }));

const FETCH = [
  "-c",
  "gc.auto=0",
  "fetch",
  "--quiet",
  "--no-tags",
  "--no-prune",
  "--no-prune-tags",
  "--refmap=",
  "--no-recurse-submodules",
  "--no-write-fetch-head",
] as const;
const ORIGIN_TRACKING_REFS = "+refs/heads/*:refs/remotes/origin/*";

/**
 * Updates the repository's view of origin and returns the address that answered, or null.
 * A machine without an SSH key reads the same repository over HTTPS with its existing Git
 * login; the remote itself stays as the person set it.
 */
export async function fetchOrigin(cwd: string, options: GitOptions = {}): Promise<string | null> {
  const origin = await local(cwd, ["remote", "get-url", "origin"], options);
  if (!origin.ok || origin.text === "") return null;
  const [first, ...others] = originCandidates(origin.text);
  if ((await remote(cwd, [...FETCH, "origin", ORIGIN_TRACKING_REFS], options)).code === 0)
    return first ?? origin.text;
  for (const candidate of others) {
    const fetched = await remote(cwd, [...FETCH, candidate, ORIGIN_TRACKING_REFS], options);
    if (fetched.code === 0) return candidate;
  }
  return null;
}

async function defaultBranch(
  cwd: string,
  /** "origin" where it answered, so an address holding a token stays off the command line. */
  address: string | null,
  options: GitOptions,
): Promise<string | null> {
  const known = await local(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    options,
  );
  if (known.ok && known.text.startsWith("origin/")) return known.text.slice("origin/".length);
  if (address === null) return null;
  const asked = await remote(cwd, ["ls-remote", "--symref", address, "HEAD"], options);
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked.stdout);
  return asked.code === 0 && match ? (match[1] ?? null) : null;
}

/** Commits on the checkout and on `target` that the other lacks. */
async function counts(cwd: string, target: string, options: GitOptions) {
  const read = await local(
    cwd,
    ["rev-list", "--left-right", "--count", `HEAD...${target}`],
    options,
  );
  const [ahead, behind] = read.text.split(/\s+/).map(Number);
  return read.ok && ahead !== undefined && behind !== undefined ? { ahead, behind } : null;
}

export async function syncRepository(input: {
  readonly path: string;
  /** Fetched moments ago by another thread starting: its answer is reused. */
  readonly address?: string | null | undefined;
  readonly inUse: (path: string) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}): Promise<RepositorySyncOutcome> {
  const { path: cwd } = input;
  const options = { signal: input.signal };
  const hasOrigin = await local(cwd, ["remote", "get-url", "origin"], options);
  if (!hasOrigin.ok || hasOrigin.text === "") return { kind: "no-remote" };
  const address = input.address !== undefined ? input.address : await fetchOrigin(cwd, options);
  if (address === null) return { kind: "unreachable" };
  const main = await defaultBranch(cwd, address === hasOrigin.text ? "origin" : address, options);
  if (main === null) return { kind: "failed" };
  const head = await local(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  const branch = head.ok ? head.text : null;
  if (branch !== main) {
    const wanted = await local(
      cwd,
      ["rev-parse", "--verify", `refs/remotes/origin/${main}`],
      options,
    );
    const lacking = wanted.ok ? await counts(cwd, wanted.text, options) : null;
    return lacking?.behind === 0 ? { kind: "current" } : { kind: "other-branch", branch, main };
  }
  const target = await local(
    cwd,
    ["rev-parse", "--verify", `refs/remotes/origin/${main}`],
    options,
  );
  if (!target.ok) return { kind: "failed" };
  const lacking = await counts(cwd, target.text, options);
  if (lacking === null) return { kind: "failed" };
  if (lacking.behind === 0) return { kind: "current" };
  if (lacking.ahead > 0) return { kind: "diverged", ...lacking };
  const status = await local(
    cwd,
    ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"],
    options,
  );
  if (!status.ok) return { kind: "failed" };
  const changes = changeCount(status.text);
  if (changes > 0) return { kind: "uncommitted", changes };
  if (await input.inUse(cwd)) return { kind: "in-use" };
  return { kind: "behind", commits: lacking.behind };
}

/** A repository's own checkout, never a linked worktree: a thread owns those. */
async function mainCheckout(folder: string, options: GitOptions): Promise<string | null> {
  const real = await NodeFSP.realpath(folder).catch(() => null);
  if (real === null) return null;
  const top = await local(real, ["rev-parse", "--show-toplevel"], options).catch(() => null);
  if (!top?.ok || (await NodeFSP.realpath(top.text).catch(() => null)) !== real) return null;
  const parts = await local(
    real,
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    options,
  );
  const [gitDir, common] = parts.text.split("\n");
  return parts.ok && gitDir === common ? real : null;
}

/**
 * Every repository of a project: its own folder, the verified workspace that contains it,
 * the checkouts nested in either, and the repositories saved in its environment.
 */
export async function repositoriesOf(
  workspaceRoot: string,
  saved: ReadonlyArray<string> = [],
  options: GitOptions = {},
): Promise<ReadonlyArray<string>> {
  const folders = new Set<string>([workspaceRoot, ...saved]);
  const scopes = await discoverCopyScopes(workspaceRoot).catch(() => null);
  const roots = scopes ? scopes.scopes.map((scope) => scope.copyRoot) : [workspaceRoot];
  for (const root of roots) {
    folders.add(root);
    const layout = await readFolderLayout(root).catch(() => null);
    for (const nested of layout?.repositories ?? []) folders.add(NodePath.join(root, nested));
  }
  const found = new Set<string>();
  for (const folder of folders) {
    if (found.size >= MAX_REPOSITORIES) break;
    const checkout = await mainCheckout(folder, options).catch(() => null);
    if (checkout !== null) found.add(checkout);
  }
  return [...found];
}

/** Where a project's saved repository lives: its own folder, or one the project manages. */
export const savedRepositoryFolder = (
  workspaceRoot: string,
  repository: { readonly id: string; readonly localPath?: string | null | undefined },
) => repository.localPath ?? NodePath.join(workspaceRoot, MANAGED_REPOSITORIES, repository.id);

/** Changes in `git status` output. The folder of managed clones is the project's, not work. */
const changeCount = (status: string) =>
  status.split("\n").filter((line) => line !== "" && line !== `?? ${MANAGED_REPOSITORIES}/`).length;

/** `repositoriesOf` for a registered project, with the repositories saved in its environment. */
export const projectRepositories = (
  project: {
    readonly workspaceRoot: string;
    readonly workspaceSettings?:
      | {
          readonly environment?: {
            readonly repositories: ReadonlyArray<{
              readonly id: string;
              readonly localPath?: string | null | undefined;
            }>;
          } | null;
        }
      | null
      | undefined;
  },
  options: GitOptions = {},
) =>
  repositoriesOf(
    project.workspaceRoot,
    (project.workspaceSettings?.environment?.repositories ?? []).map((repository) =>
      savedRepositoryFolder(project.workspaceRoot, repository),
    ),
    options,
  );

const fetchedAt = new Map<string, { readonly at: number; readonly address: string }>();

const catchingUp = new Set<string>();
const catchUpFailedAt = new Map<string, number>();

/**
 * Git keeps nothing from a killed fetch, so a repository that needs longer than a turn allows
 * would never get current. This fetch has no turn to hold up. A few run at a time; the rest
 * start from a later thread.
 */
export function startCatchUp(
  path: string,
  now: () => number = Date.now,
  fetch: (path: string) => Promise<string | null> = (cwd) =>
    fetchOrigin(cwd, { timeoutMs: CATCH_UP_MS }),
): void {
  const failedAt = catchUpFailedAt.get(path);
  if (
    catchingUp.has(path) ||
    catchingUp.size >= PARALLEL ||
    (failedAt !== undefined && now() - failedAt < CATCH_UP_RETRY_MS)
  )
    return;
  catchingUp.add(path);
  void fetch(path)
    .catch(() => null)
    .then((address) => {
      catchingUp.delete(path);
      if (address === null) catchUpFailedAt.set(path, now());
      else catchUpFailedAt.delete(path);
    });
}

/** Syncs the repositories a few at a time. One that throws is reported, the rest carry on. */
export async function syncRepositories(input: {
  readonly paths: ReadonlyArray<string>;
  readonly inUse: (path: string) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
  readonly now?: () => number;
}): Promise<ReadonlyArray<RepositorySyncResult>> {
  const now = input.now ?? Date.now;
  const results: Array<RepositorySyncResult> = [];
  const queue = [...input.paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const fresh = fetchedAt.get(path);
      let outcome: RepositorySyncOutcome;
      try {
        let address: string | null;
        if (fresh && now() - fresh.at < FETCH_FRESH_MS) address = fresh.address;
        // A catch-up already running will answer for the next thread; this one doesn't wait.
        else if (catchingUp.has(path)) address = null;
        else {
          address = await fetchOrigin(path, { signal: input.signal });
          if (address !== null) fetchedAt.set(path, { at: now(), address });
          else if (!input.signal?.aborted) startCatchUp(path, now);
        }
        outcome = await syncRepository({
          path,
          address,
          inUse: input.inUse,
          signal: input.signal,
        });
      } catch {
        outcome = { kind: "failed" };
      }
      results.push({ path, name: NodePath.basename(path), outcome });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * True when a checkout shares files with a folder a running thread works in. A path that
 * no longer resolves is compared as written.
 */
export async function foldersOverlap(
  checkout: string,
  folders: ReadonlyArray<string>,
): Promise<boolean> {
  const real = async (value: string) =>
    NodeFSP.realpath(value).catch(() => NodePath.resolve(value));
  const left = await real(checkout);
  for (const folder of folders) {
    const right = await real(folder);
    if (
      left === right ||
      left.startsWith(`${right}${NodePath.sep}`) ||
      right.startsWith(`${left}${NodePath.sep}`)
    )
      return true;
  }
  return false;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function skipReason(outcome: RepositorySyncOutcome): string | null {
  switch (outcome.kind) {
    case "uncommitted":
      return `it has ${plural(outcome.changes, "uncommitted change")}`;
    case "other-branch":
      return outcome.branch
        ? `it's on ${outcome.branch}, not ${outcome.main}`
        : `it isn't on a branch, and origin uses ${outcome.main}`;
    case "diverged":
      return `it has ${plural(outcome.ahead, "local commit")} and origin has ${plural(outcome.behind, "other commit")}`;
    case "in-use":
      return "another thread is working in it";
    case "behind":
      return `origin has ${plural(outcome.commits, "new commit")}. Pull when you are ready`;
    case "unreachable":
      return "this machine can't reach its origin";
    case "failed":
      return "Git couldn't update it";
    default:
      return null;
  }
}

/** Starts every line about a repository left alone. */
export const NOT_UPDATED = "Didn't update";

export interface RepositorySyncNotice {
  readonly title: string;
  readonly message: string;
  /** The skipped part alone, so repeating it can be told apart from new updates. */
  readonly skipped: string;
}

/** The short notice for a thread; null when every repository was already current. */
export function repositorySyncNotice(
  results: ReadonlyArray<RepositorySyncResult>,
): RepositorySyncNotice | null {
  const skipped = results.flatMap((result) => {
    const reason = skipReason(result.outcome);
    return reason === null ? [] : [`${NOT_UPDATED} ${result.name}: ${reason}.`];
  });
  if (skipped.length === 0) return null;
  return {
    title: "Repositories not updated",
    message: skipped.join("\n"),
    skipped: skipped.join("\n"),
  };
}

export interface RepositoryLeftBehind {
  readonly name: string;
  readonly path: string;
  readonly branch: string | null;
  /** Commits on the current branch origin does not have; null when it has no upstream. */
  readonly unpushedCommits: number | null;
  readonly uncommittedChanges: number;
  readonly branchesAhead: number;
  readonly branchesWithoutUpstream: number;
}

const NOTHING_TO_LEAVE = (entry: RepositoryLeftBehind) =>
  (entry.unpushedCommits ?? 1) === 0 &&
  entry.uncommittedChanges === 0 &&
  entry.branchesAhead === 0 &&
  entry.branchesWithoutUpstream === 0;

async function leftBehindIn(
  path: string,
  name: string,
  linked: boolean,
): Promise<RepositoryLeftBehind | null> {
  const options = {};
  const status = await local(
    path,
    ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"],
    options,
  );
  if (!status.ok) return null;
  const head = await local(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  // A detached checkout has no upstream: what counts is whether any remote has its commits.
  const ahead = await local(
    path,
    head.ok
      ? ["rev-list", "--count", "@{upstream}..HEAD"]
      : ["rev-list", "--count", "HEAD", "--not", "--remotes"],
    options,
  );
  const refs = await local(
    path,
    [
      "for-each-ref",
      "--format=%(HEAD)|%(upstream)|%(upstream:track)|%(worktreepath)",
      "refs/heads",
    ],
    options,
  );
  // A checked-out branch counts on its own checkout's row; the rest on the repository's row.
  const others = linked
    ? []
    : refs.text
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("*|"))
        .map((line) => line.split("|"))
        .filter((line) => !line[3]);
  return {
    name,
    path,
    branch: head.ok ? head.text : null,
    unpushedCommits: ahead.ok ? Number(ahead.text) : null,
    uncommittedChanges: changeCount(status.text),
    branchesAhead: others.filter((line) => line[2]?.includes("ahead")).length,
    branchesWithoutUpstream: others.filter((line) => line[1] === "" || line[2] === "[gone]").length,
  };
}

/**
 * What stays on this machine if the project moves, in each repository and its worktrees.
 * Read from this machine's own view of origin, without any network, so opening the dialog
 * stays instant.
 */
export async function leftBehindOf(
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<RepositoryLeftBehind>> {
  const results: Array<RepositoryLeftBehind> = [];
  for (const path of paths) {
    const repository = NodePath.basename(path);
    const list = await local(path, ["worktree", "list", "--porcelain"], {}).catch(() => null);
    const linked = (list?.text ?? "")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      // The first entry is the main checkout.
      .slice(1, MAX_REPOSITORIES + 1);
    const folders = [
      { folder: path, name: repository, isLinked: false },
      ...linked.map((folder) => ({
        folder,
        name: `${repository} worktree ${NodePath.basename(folder)}`,
        isLinked: true,
      })),
    ];
    for (const { folder, name, isLinked } of folders) {
      // A worktree whose folder is gone, or a slow read, costs its own row only.
      const entry = await leftBehindIn(folder, name, isLinked).catch(() => null);
      if (entry !== null && !NOTHING_TO_LEAVE(entry)) results.push(entry);
    }
  }
  return results;
}
