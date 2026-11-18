// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Sync for a project that exists on two machines (1390). Each machine fetches
 * `origin` for its own repositories and fast-forwards a clean checkout that is
 * only behind; a repository it lacks is cloned. This module runs exactly these
 * Git commands that change anything: a fetch of `origin`'s branches into
 * `refs/remotes/origin/` (never the destinations the repository's settings
 * name), `merge --ff-only` and `clone`. It never resets, rebases, merges with a merge commit, stashes,
 * switches a branch, deletes, pushes or commits, and it never calls the folder
 * copy's reconcile paths, which can stash and reset.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  planProjectSyncRepository,
  type ProjectId,
  ProjectSyncError,
  type ProjectSyncFetchResult,
  type ProjectSyncProjectInput,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncRepositoryStatus,
  type ProjectSyncRunInput,
  type ProjectSyncRunResult,
  type ProjectSyncStatusResult,
  type ProjectSyncStepResult,
  PROJECT_SYNC_MAX_REPOSITORIES,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { UNFINISHED_OPERATION_MARKS } from "../handoff/bundleGit.ts";
import { type GitResult, runGit } from "./folderTransfer/git.ts";
import * as HandoffGit from "./handoffGit.ts";
import { canonicalOrigin, safeRelativePath } from "./handoffGitTypes.ts";

const LOCAL_MS = 30_000;
const FETCH_MS = 5 * 60_000;
const CLONE_MS = 30 * 60_000;
const PARALLEL = 4;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** How Sync runs Git. Tests pass a recording runner to assert on every command. */
export type SyncGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  },
) => Promise<GitResult>;

export interface SyncContext {
  readonly git: SyncGit;
  /**
   * The title of a running thread that works in this very checkout, or null.
   * Asked each time it matters, never remembered: a thread may start between
   * two reads.
   */
  readonly inUse: (checkout: string) => Promise<string | null>;
  /** Stops a fetch or a clone that is under way when the call is cancelled. A merge is never stopped. */
  readonly signal?: AbortSignal;
}

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
  readonly mirror: string;
  readonly refspecs: ReadonlyArray<string>;
}): string | null {
  if (/^(true|yes|on|1|fetch|push)$/iu.test(input.mirror.trim()))
    return "origin is set up as a mirror (remote.origin.mirror).";
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
const isLocalAddress = (canonical: string) => {
  if (canonical.startsWith("file://")) return true;
  const host = (canonical.split("/")[0] ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
};

/**
 * The marks of an unfinished operation, plus the one Git keeps while a
 * cherry-pick or revert of several commits is part way through with nothing
 * left to resolve: no head mark, a clean tree, and commits still to pick.
 */
const UNFINISHED_MARKS = [...UNFINISHED_OPERATION_MARKS, "sequencer"];

export interface SyncRepository {
  /** Relative to the project folder with `/` separators; "." is the folder itself. */
  readonly path: string;
  readonly cwd: string;
}

const read = async (git: SyncGit, cwd: string, args: ReadonlyArray<string>) => {
  const result = await git(cwd, args, { allowFailure: true, timeoutMs: LOCAL_MS });
  return { ok: result.code === 0, text: result.stdout.trim(), stderr: result.stderr.trim() };
};

const gitReason = (stderr: string) =>
  (
    stderr
      .split("\n")
      .map((line) => line.replace(/^(fatal|error):\s*/u, "").trim())
      .filter((line) => line.length > 0)
      .join(" ") || "Git gave no reason."
  ).slice(0, 1900);

/** A linked worktree: its Git directory differs from the repository's common one. */
export async function isLinkedWorktree(git: SyncGit, cwd: string): Promise<boolean> {
  const dirs = await read(git, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, common] = dirs.text.split("\n");
  return dirs.ok && gitDir !== undefined && common !== undefined && gitDir !== common;
}

/**
 * The repositories Sync lists: the scan's, minus every linked worktree inside
 * the project folder. Such a folder is a thread's checkout of a repository
 * already named, so it is not listed and never moved, whether or not its
 * thread is running. The project folder itself always stays.
 */
export async function syncRepositories(
  git: SyncGit,
  root: string,
  relativePaths: ReadonlyArray<string>,
): Promise<Array<SyncRepository>> {
  const out: Array<SyncRepository> = [];
  for (const path of relativePaths.slice(0, PROJECT_SYNC_MAX_REPOSITORIES)) {
    const cwd = path === "." ? root : NodePath.join(root, ...path.split("/"));
    if (path !== "." && (await isLinkedWorktree(git, cwd))) continue;
    out.push({ path, cwd });
  }
  return out;
}

async function branchAndHead(git: SyncGit, cwd: string) {
  const [symbolic, head] = await Promise.all([
    read(git, cwd, ["symbolic-ref", "-q", "--short", "HEAD"]),
    read(git, cwd, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]),
  ]);
  return {
    branch: symbolic.ok && symbolic.text.length > 0 ? symbolic.text : null,
    head: head.ok && SHA.test(head.text) ? head.text : null,
  };
}

async function uncommittedCount(git: SyncGit, cwd: string): Promise<number | null> {
  const status = await read(git, cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (!status.ok) return null;
  const files = status.text.length === 0 ? 0 : status.text.split("\n").length;
  // An unfinished merge, rebase, cherry-pick, revert or bisect is not clean, also with no file changed.
  return files === 0 && (await operationUnfinished(git, cwd)) ? 1 : files;
}

async function operationUnfinished(git: SyncGit, cwd: string): Promise<boolean> {
  const gitDir = await read(git, cwd, ["rev-parse", "--absolute-git-dir"]);
  // A Git folder that cannot be found is never taken for a finished state.
  if (!gitDir.ok || gitDir.text.length === 0) return true;
  for (const mark of UNFINISHED_MARKS) {
    if ((await NodeFSP.lstat(NodePath.join(gitDir.text, mark)).catch(() => null)) !== null)
      return true;
  }
  return false;
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
      read(git, cwd, ["config", "--get-all", "remote.origin.mirror"]),
    ]);
    const unusual = unusualFetchConfig({
      mirror: mirror.ok ? (mirror.text.split("\n").at(-1) ?? "") : "",
      refspecs: refspecs.ok ? refspecs.text.split("\n") : [],
    });
    if (unusual !== null) {
      fetch = "unusual-config";
      fetchError = unusual;
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
  const { branch, head } = await branchAndHead(git, cwd);
  const upstream =
    branch === null
      ? { ok: false, text: "" }
      : await read(git, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let ahead = 0;
  let behind = 0;
  let upstreamName: string | null = null;
  if (upstream.ok && upstream.text.length > 0 && head !== null) {
    const counted = await read(git, cwd, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ]);
    const [left, right] = counted.text.split(/\s+/).map(Number);
    if (counted.ok && Number.isInteger(left) && Number.isInteger(right)) {
      upstreamName = upstream.text.slice(0, 512);
      ahead = left!;
      behind = right!;
    }
  }
  const uncommitted = await uncommittedCount(git, cwd);
  return {
    path,
    branch,
    head,
    upstream: upstreamName,
    ahead,
    behind,
    // A status Git could not read is never treated as clean.
    uncommitted: uncommitted ?? 1,
    // Read last, after the status read above.
    inUseBy: await context.inUse(cwd),
    remote: cloneAddress(address),
    fetch,
    fetchError,
  };
}

/** The address when another machine can clone from it: no credential, no folder of this machine. */
function cloneAddress(address: string): string | null {
  if (address.length === 0 || address.startsWith("-")) return null;
  const canonical = canonicalOrigin(address);
  return canonical === null || isLocalAddress(canonical) ? null : address;
}

const result = (
  facts: ProjectSyncRepositoryFacts,
  otherBranch: string | null | undefined,
  change: Partial<ProjectSyncStepResult> = {},
): ProjectSyncStepResult => ({
  ...planProjectSyncRepository(facts, otherBranch === undefined ? null : { branch: otherBranch }),
  moved: 0,
  downgraded: false,
  ...change,
});

/**
 * Moves one checkout forward. The plan was a proposal: the repository is read
 * again here, immediately before the merge, and when it is no longer clean,
 * only behind, on its branch and free of running work, nothing moves and the
 * result carries the reason.
 */
export async function fastForwardRepository(
  context: SyncContext,
  repository: SyncRepository,
  otherBranch: string | null,
): Promise<ProjectSyncStepResult> {
  const { git } = context;
  if (repository.path !== "." && (await isLinkedWorktree(git, repository.cwd))) {
    const facts = await readRepositoryFacts(context, repository, { fetch: false });
    return result(facts, otherBranch, {
      action: "none",
      reason: "refused",
      detail: "A thread's worktree is never moved by Sync.",
      downgraded: true,
    });
  }
  const facts = await readRepositoryFacts(context, repository, { fetch: false });
  const planned = result(facts, otherBranch);
  if (planned.action !== "fast-forward") return { ...planned, downgraded: true };
  const target = await read(git, repository.cwd, [
    "rev-parse",
    "-q",
    "--verify",
    "@{upstream}^{commit}",
  ]);
  if (!target.ok || !SHA.test(target.text)) {
    return { ...planned, action: "fetch", reason: "no-upstream", downgraded: true };
  }
  // Asked once more, with nothing but the merge left to run: a thread that started
  // working here during the reads above keeps the checkout as it is.
  const startedHere = await context.inUse(repository.cwd);
  if (startedHere !== null) {
    return {
      ...planned,
      action: "fetch",
      reason: "in-use",
      inUseBy: startedHere,
      downgraded: true,
    };
  }
  const merged = await git(
    repository.cwd,
    // Ignored files in the way stop the merge instead of being written over.
    ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", "--quiet", target.text],
    { allowFailure: true, timeoutMs: FETCH_MS },
  );
  const after = await branchAndHead(git, repository.cwd);
  if (merged.code !== 0 || after.head !== target.text) {
    return {
      ...planned,
      action: "fetch",
      reason: "refused",
      detail: gitReason(merged.stderr),
      downgraded: true,
    };
  }
  return { ...planned, moved: facts.behind };
}

/**
 * Clones a repository this machine lacks into its place in the project folder.
 * The folder must not exist: it is created exclusively, so nothing there is
 * ever written over. A remote that carries a credential, names a transport
 * other than https, ssh or git, or is a folder or `file://` address (a place
 * on one machine only) is refused. A clone that fails or is cancelled leaves
 * no folder behind.
 */
export async function cloneRepository(
  context: SyncContext,
  root: string,
  input: { readonly path: string; readonly remote: string },
): Promise<ProjectSyncStepResult> {
  const step = (change: Partial<ProjectSyncStepResult>): ProjectSyncStepResult => ({
    path: input.path,
    action: "clone",
    reason: "missing",
    branch: null,
    otherBranch: null,
    ahead: 0,
    behind: 0,
    uncommitted: 0,
    inUseBy: null,
    remote: input.remote,
    detail: null,
    moved: 0,
    downgraded: false,
    ...change,
  });
  const refuse = (detail: string) =>
    step({ action: "none", reason: "refused", detail, downgraded: true });
  if (
    input.path === "." ||
    !safeRelativePath(input.path) ||
    input.path.split("/").some(isGitFolderName)
  )
    return refuse("The repository's folder is not a path inside the project.");
  if (cloneAddress(input.remote) === null)
    return refuse("The remote is not an address Sync clones from.");
  const realRoot = await NodeFSP.realpath(root).catch(() => null);
  if (realRoot === null) return refuse("The project folder is missing.");
  const target = NodePath.join(realRoot, ...input.path.split("/"));
  if ((await NodeFSP.lstat(target).catch(() => null)) !== null)
    return refuse('A folder is already there. Use "Compare all files…".');
  /** The folders this call made on the way, innermost last: removed again when nothing is cloned. */
  const made: Array<string> = [];
  const undo = async () => {
    for (const folder of made.toReversed()) await NodeFSP.rmdir(folder).catch(() => undefined);
  };
  try {
    // One folder at a time, creating nothing past a link: a link on the way would
    // put the clone, or an empty folder, outside the project folder.
    let folder = realRoot;
    for (const part of input.path.split("/").slice(0, -1)) {
      folder = NodePath.join(folder, part);
      let entry = await NodeFSP.lstat(folder).catch(() => null);
      if (entry === null) {
        await NodeFSP.mkdir(folder);
        made.push(folder);
        entry = await NodeFSP.lstat(folder);
      }
      if (!entry.isDirectory()) {
        await undo();
        return refuse("The folder's path leaves the project folder.");
      }
    }
    await NodeFSP.mkdir(target);
  } catch {
    await undo();
    return refuse("The folder could not be created.");
  }
  const cloned = await context
    // The remote is always named origin, whatever `clone.defaultRemoteName` says.
    .git(
      target,
      [
        "clone",
        "--quiet",
        "--origin",
        "origin",
        "--no-recurse-submodules",
        "--",
        input.remote,
        ".",
      ],
      {
        allowFailure: true,
        timeoutMs: CLONE_MS,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
    )
    .catch((cause: unknown) => ({
      code: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : "The clone did not finish.",
    }));
  if (cloned.code !== 0) {
    // The folder this call created exclusively: all that is in it is this clone's.
    await NodeFSP.rm(target, { recursive: true, force: true }).catch(() => undefined);
    await undo();
    return refuse(
      context.signal?.aborted === true ? "The clone was cancelled." : gitReason(cloned.stderr),
    );
  }
  const { branch } = await branchAndHead(context.git, target);
  return step({ branch });
}

/**
 * A folder name a file system may read as `.git`: another case, a trailing dot
 * or space, a character it ignores, or a short name. A clone into such a folder
 * would put a remote's files where Git reads its own settings.
 */
export function isGitFolderName(name: string): boolean {
  const plain = name
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g, "")
    .replace(/[. ]+$/, "")
    .toLowerCase();
  return plain === ".git" || /^git~\d+$/.test(plain);
}

/**
 * Whether a thread working in `threadFolder` works in `checkout`: it runs in
 * that folder, in a folder above it (a thread in the project folder reaches
 * every nested repository), or in a subfolder that belongs to that checkout.
 * A thread in its own worktree works in another checkout, so it never blocks
 * the repository its worktree was cut from.
 */
export function threadUsesCheckout(input: {
  readonly threadFolder: string;
  /** `git rev-parse --show-toplevel` of the thread's folder, when it is inside a checkout. */
  readonly threadCheckout: string | null;
  readonly checkout: string;
}): boolean {
  const { threadFolder, checkout } = input;
  if (threadFolder === checkout) return true;
  if (checkout.startsWith(`${threadFolder}${NodePath.sep}`)) return true;
  return threadFolder.startsWith(`${checkout}${NodePath.sep}`) && input.threadCheckout === checkout;
}

async function inParallel<A, B>(items: ReadonlyArray<A>, run: (item: A) => Promise<B>) {
  const out: Array<B> = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]!);
      }
    }),
  );
  return out;
}

export async function statusOf(
  git: SyncGit,
  repositories: ReadonlyArray<SyncRepository>,
): Promise<Array<ProjectSyncRepositoryStatus>> {
  return inParallel(repositories, (repository) => readRepositoryStatus(git, repository));
}

/** Fetches `origin` in every repository. One that fails is reported; the others continue. */
export async function fetchAll(
  context: SyncContext,
  repositories: ReadonlyArray<SyncRepository>,
): Promise<Array<ProjectSyncRepositoryFacts>> {
  return inParallel(repositories, (repository) =>
    readRepositoryFacts(context, repository, { fetch: true }),
  );
}

/** Fast-forwards and clones, one repository at a time, each rechecked as it is reached. */
export async function runSync(
  context: SyncContext,
  root: string,
  repositories: ReadonlyArray<SyncRepository>,
  input: Pick<ProjectSyncRunInput, "fastForward" | "clone">,
): Promise<Array<ProjectSyncStepResult>> {
  const known = new Map(repositories.map((repository) => [repository.path, repository]));
  const out: Array<ProjectSyncStepResult> = [];
  for (const wanted of input.fastForward) {
    const repository = known.get(wanted.path);
    if (repository === undefined) {
      out.push({
        path: wanted.path,
        action: "none",
        reason: "refused",
        branch: null,
        otherBranch: wanted.otherBranch,
        ahead: 0,
        behind: 0,
        uncommitted: 0,
        inUseBy: null,
        remote: null,
        detail: "Sync does not list this folder as a repository of the project.",
        moved: 0,
        downgraded: true,
      });
      continue;
    }
    out.push(await fastForwardRepository(context, repository, wanted.otherBranch));
  }
  for (const wanted of input.clone) out.push(await cloneRepository(context, root, wanted));
  return out;
}

const defaultGit: SyncGit = (cwd, args, options) => runGit(cwd, args, options);

export class ProjectSync extends Context.Service<
  ProjectSync,
  {
    /** The project's folder and the repositories Sync lists in it. */
    readonly repositories: (projectId: ProjectId) => Effect.Effect<
      {
        readonly root: string;
        readonly repositories: ReadonlyArray<SyncRepository>;
        readonly scanLimited: boolean;
      },
      ProjectSyncError
    >;
    readonly status: (
      input: ProjectSyncProjectInput,
    ) => Effect.Effect<ProjectSyncStatusResult, ProjectSyncError>;
    readonly fetch: (
      input: ProjectSyncProjectInput,
    ) => Effect.Effect<ProjectSyncFetchResult, ProjectSyncError>;
    readonly run: (
      input: ProjectSyncRunInput,
    ) => Effect.Effect<ProjectSyncRunResult, ProjectSyncError>;
  }
>()("specweave-studio/fleet/ProjectSync") {}

const failed = (reason: string, code: ProjectSyncError["code"] = "failed") =>
  new ProjectSyncError({ code, reason });

const gitFailure = (cause: unknown) =>
  failed(cause instanceof Error ? cause.message.slice(0, 1900) : "Git did not finish.");

/**
 * Git work that is never cut short: a cancelled call waits for it, so the
 * project's lock is not released while Git still writes. Each Git command
 * ends by itself, under its own time limit.
 */
export const untilGitEnds = <A>(run: () => Promise<A>): Effect.Effect<A, ProjectSyncError> =>
  Effect.tryPromise({ try: run, catch: gitFailure }).pipe(Effect.uninterruptible);

/**
 * Git work a cancelled call stops (a fetch, a clone): the signal is aborted,
 * and the call still waits until `run` has ended, so whoever holds the
 * project's lock keeps it until Git is gone and `run` has cleaned up.
 */
export const stoppedWhenCancelled = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ProjectSyncError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const settled = run(controller.signal).then(
        (value) => ({ ok: true as const, value }),
        (cause: unknown) => ({ ok: false as const, cause }),
      );
      return { controller, settled };
    }),
    ({ settled }) =>
      Effect.promise(() => settled).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(gitFailure(outcome.cause)),
        ),
      ),
    ({ controller, settled }) =>
      Effect.promise(() => {
        // After `run` has ended this changes nothing; before, it stops Git and waits for it.
        controller.abort();
        return settled;
      }),
  );

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const handoffGit = yield* HandoffGit.HandoffGit;
  const sql = yield* SqlClient.SqlClient;

  const attempt = untilGitEnds;

  const repositories = Effect.fn("ProjectSync.repositories")(function* (projectId: ProjectId) {
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(() => failed("Could not read this machine's projects.")),
    );
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined)
      return yield* failed("This machine does not have that project.", "not_found");
    if (isPersonalAssistantProject(project))
      return yield* failed("A personal project is not synced between machines.", "personal");
    const root = yield* attempt(() => NodeFSP.realpath(project.workspaceRoot));
    // A tree the scan cannot finish (past its limits, a link to a folder, a nested folder
    // whose Git data is broken) lists its root alone, marked as such: today's fallback of a
    // Git sync move. The root itself must be a repository.
    const scanned = yield* handoffGit.discover({ workspaceRoot: root }).pipe(
      Effect.map((paths) => ({ paths, scanLimited: false })),
      Effect.catchTags({
        HandoffGitError: () =>
          attempt(async () => {
            const top = await read(defaultGit, root, ["rev-parse", "--show-toplevel"]);
            const real = top.ok ? await NodeFSP.realpath(top.text).catch(() => null) : null;
            return real === root;
          }).pipe(
            Effect.flatMap((isRepository) =>
              isRepository
                ? Effect.succeed({ paths: ["."] as ReadonlyArray<string>, scanLimited: true })
                : Effect.fail(failed("The project folder is not a Git repository.", "invalid")),
            ),
          ),
      }),
    );
    return {
      root,
      repositories: yield* attempt(() => syncRepositories(defaultGit, root, scanned.paths)),
      scanLimited: scanned.scanLimited,
    };
  });

  /** Threads with a run or a provider session going, and the folder each works in. */
  const runningThreads = sql<{
    title: string | null;
    workspaceRoot: string;
    worktreePath: string | null;
  }>`
    SELECT t.title AS "title", p.workspace_root AS "workspaceRoot",
      json_extract(t.payload_json, '$.worktreePath') AS "worktreePath"
    FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
    WHERE EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id AND r.status NOT IN ('completed','interrupted','failed','cancelled','rolled_back'))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_sessions s WHERE s.thread_id=t.thread_id AND s.status IN ('running','working','connecting','starting'))
    ORDER BY t.updated_at DESC, t.thread_id
  `;

  /**
   * Which running thread works in a checkout, read from the database each time
   * it is asked: before a plan, and again immediately before a merge. A list
   * that cannot be read counts as in use, so nothing moves on a guess.
   */
  const inUse: SyncContext["inUse"] = async (checkout) => {
    const rows = await Effect.runPromise(runningThreads).catch(() => null);
    if (rows === null) return "a thread (the list of running threads could not be read)";
    for (const row of rows) {
      const folder = row.worktreePath ?? row.workspaceRoot;
      const real = await NodeFSP.realpath(folder).catch(() => NodePath.resolve(folder));
      // A thread in a folder outside the checkout and not above it cannot work in it.
      if (
        real !== checkout &&
        !checkout.startsWith(`${real}${NodePath.sep}`) &&
        !real.startsWith(`${checkout}${NodePath.sep}`)
      )
        continue;
      const top = await read(defaultGit, real, ["rev-parse", "--show-toplevel"]).catch(() => null);
      const threadCheckout =
        top?.ok === true
          ? await NodeFSP.realpath(top.text).catch(() => NodePath.resolve(top.text))
          : null;
      if (threadUsesCheckout({ threadFolder: real, threadCheckout, checkout }))
        return row.title ?? "a thread";
    }
    return null;
  };
  const syncContext = (signal?: AbortSignal): SyncContext => ({
    git: defaultGit,
    inUse,
    ...(signal === undefined ? {} : { signal }),
  });

  return ProjectSync.of({
    repositories,
    status: Effect.fn("ProjectSync.status")(function* (input) {
      const found = yield* repositories(input.projectId);
      return {
        repositories: yield* attempt(() => statusOf(defaultGit, found.repositories)),
        scanLimited: found.scanLimited,
      };
    }),
    fetch: (input) =>
      admission.withLock(
        input.projectId,
        Effect.gen(function* () {
          const found = yield* repositories(input.projectId);
          return {
            // A cancelled fetch is stopped; the lock is held until Git has ended.
            repositories: yield* stoppedWhenCancelled((signal) =>
              fetchAll(syncContext(signal), found.repositories),
            ),
            scanLimited: found.scanLimited,
          };
        }),
      ),
    run: (input) =>
      admission.withLock(
        input.projectId,
        Effect.gen(function* () {
          const found = yield* repositories(input.projectId);
          const out: Array<ProjectSyncStepResult> = [];
          // A merge is never cut short. A cancelled call ends between two repositories.
          for (const wanted of input.fastForward) {
            out.push(
              ...(yield* attempt(() =>
                runSync(syncContext(), found.root, found.repositories, {
                  fastForward: [wanted],
                  clone: [],
                }),
              )),
            );
          }
          // A cancelled clone is stopped and its folder removed before the lock is released.
          for (const wanted of input.clone) {
            out.push(
              ...(yield* stoppedWhenCancelled((signal) =>
                runSync(syncContext(signal), found.root, found.repositories, {
                  fastForward: [],
                  clone: [wanted],
                }),
              )),
            );
          }
          return { repositories: out };
        }),
      ),
  });
});

export const layer = Layer.effect(ProjectSync, make).pipe(
  Layer.provide(ProjectAdmission.layer),
  Layer.provide(HandoffGit.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
