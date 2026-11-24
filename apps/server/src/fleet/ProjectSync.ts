// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Sync for a project that exists on two machines (1390). Each machine fetches
 * `origin` for its own repositories and fast-forwards a clean checkout that is
 * only behind; a repository it lacks is cloned. This module runs exactly these
 * Git commands that change anything: a fetch of `origin`'s branches into
 * `refs/remotes/origin/` (never the destinations the repository's settings
 * name, never pruned); a guarded fast-forward (a ref transaction on HEAD and
 * the branch it names, held while `read-tree -m -u` moves the files); and
 * `clone`. It never merges, resets, rebases, stashes, switches a branch,
 * deletes a branch or a tag, pushes or commits, and it never calls the folder
 * copy's reconcile paths, which can stash and reset.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type ProjectId,
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  CLONE_STAGING_CLONE,
  CLONE_STAGING_PREFIX,
  cloneStagingIn,
  cloneStagingOwner,
  markCloneStaging,
  namedLikeCloneStaging,
  ownerState,
} from "./cloneStaging.ts";
import { runGit } from "./folderTransfer/git.ts";
import * as HandoffGit from "./handoffGit.ts";
import { safeRelativePath } from "./handoffGitTypes.ts";
import {
  cloneAddress,
  readRepositoryFacts,
  readRepositoryStatus,
  unreadFacts,
} from "./projectSyncFacts.ts";
import {
  branchAndHead,
  didNotFinish,
  gitReason,
  isLinkedWorktree,
  read,
  SYNC_ENV,
  type SyncContext,
  type SyncGit,
  type SyncRepository,
} from "./projectSyncGit.ts";
import { fastForwardRepository } from "./projectSyncMove.ts";
import { type FetchRecord, keepFetch, keptFetch, newFetchRecord } from "./projectSyncRecord.ts";

export {
  readRepositoryFacts,
  readRepositoryStatus,
  unusualFetchConfig,
} from "./projectSyncFacts.ts";
export { isLinkedWorktree } from "./projectSyncGit.ts";
export type { SyncContext, SyncGit, SyncRepository } from "./projectSyncGit.ts";
export { fastForwardRepository } from "./projectSyncMove.ts";

const CLONE_MS = 30 * 60_000;

/**
 * How long Sync waits for the repository walk of a project folder (1469 D-01). A walk that
 * takes longer ends as a scan-limited one: the root repository alone. Sync calls that hold
 * the project's lock then hold it for at most this plus their Git work.
 */
export const SYNC_SCAN_BUDGET = Duration.seconds(20);
/** A finished walk is reused for this long by the next Sync call on the same folder. */
export const SYNC_SCAN_REUSE = Duration.seconds(5);

interface Scanned {
  readonly paths: ReadonlyArray<string>;
  readonly scanLimited: boolean;
}
const PARALLEL = 4;

/** The staging folders of the clones under way in this server, by absolute path. */
const liveCloneStaging = new Set<string>();

/**
 * Removes the staging folders that clones which never finished left behind
 * (the server stopped mid-way). `paths` are relative to the project folder; of
 * each, the staging folder it names or lies in is removed once the process its
 * mark names is provably gone. A clone of this server that is filling it keeps
 * it; one whose owner may still be running keeps it too, and is said so
 * (`live`). Nothing else is touched: not a folder without the clone step's mark
 * (whatever its name), not a file, nothing reached through a link or outside
 * the project. `failed` are the folders that could not be removed.
 */
export async function sweepCloneLeftovers(
  root: string,
  paths: ReadonlyArray<string>,
): Promise<{ readonly failed: Array<string>; readonly live: Array<string> }> {
  const failed: Array<string> = [];
  const live: Array<string> = [];
  const realRoot = await NodeFSP.realpath(root).catch(() => null);
  if (realRoot === null) return { failed, live };
  const staging = cloneStagingIn(realRoot);
  const seen = new Set<string>();
  for (const path of paths) {
    if (!safeRelativePath(path)) continue;
    // Only a folder that carries the mark this server's clone step writes: a folder a
    // person merely named this way is theirs, and stays.
    const top = await staging.top(path);
    if (top === null || seen.has(top)) continue;
    seen.add(top);
    const folder = NodePath.join(realRoot, ...top.split("/"));
    if (liveCloneStaging.has(folder)) continue;
    // Only a real folder at that very place: nothing behind a link.
    if ((await NodeFSP.realpath(folder).catch(() => null)) !== folder) continue;
    const owner = await cloneStagingOwner(folder);
    if (owner === null) continue;
    // Another server process may be filling it: never removed on a guess.
    if (ownerState(owner) === "maybe-running") {
      live.push(top);
      continue;
    }
    await NodeFSP.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    if ((await NodeFSP.lstat(folder).catch(() => null)) !== null) failed.push(top);
  }
  return { failed, live };
}

/** Staging folders beside the places `clonePaths` name, relative to the project folder. */
export async function cloneStagingBeside(
  root: string,
  clonePaths: ReadonlyArray<string>,
): Promise<Array<string>> {
  const out: Array<string> = [];
  for (const path of clonePaths) {
    if (!safeRelativePath(path)) continue;
    const parent = path.split("/").slice(0, -1);
    const names = await NodeFSP.readdir(NodePath.join(root, ...parent)).catch(() => []);
    for (const name of names)
      if (name.startsWith(CLONE_STAGING_PREFIX)) out.push([...parent, name].join("/"));
  }
  return out;
}

/**
 * The repositories Sync lists: the scan's, minus every clone staging folder
 * (and what lies in one) and every linked worktree inside the project folder. Such a folder is a thread's checkout of a repository
 * already named, so it is not listed and never moved, whether or not its
 * thread is running. The project folder itself always stays.
 */
export async function syncRepositories(
  git: SyncGit,
  root: string,
  relativePaths: ReadonlyArray<string>,
): Promise<Array<SyncRepository>> {
  const out: Array<SyncRepository> = [];
  const staging = cloneStagingIn(root);
  const listed: Array<string> = [];
  for (const path of relativePaths) if (!(await staging.has(path))) listed.push(path);
  for (const path of listed.slice(0, PROJECT_SYNC_MAX_REPOSITORIES)) {
    const cwd = path === "." ? root : NodePath.join(root, ...path.split("/"));
    const linked = path === "." ? false : await isLinkedWorktree(git, cwd);
    if (linked === true) continue;
    // Git did not say what the folder is: it is neither dropped nor taken for a
    // repository to move. It is listed as unread, and the others are read as ever.
    out.push(linked === null ? { path, cwd, unread: true } : { path, cwd });
  }
  return out;
}

/**
 * Clones a repository this machine lacks into its place in the project folder.
 * The folder must not exist. The clone is made in a new folder beside it and
 * moved in when it is whole, so nothing at the target is ever written over or
 * deleted, also not what appears there while the clone runs. A remote that carries a credential, names a transport
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
  let staging = "";
  let published = false;
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
    // The clone is made beside its place, in a folder only this call knows, and moved
    // in when it is whole: nothing a person puts at the target meanwhile is ever touched.
    staging = await NodeFSP.mkdtemp(
      NodePath.join(
        NodePath.dirname(target),
        `${CLONE_STAGING_PREFIX}${NodePath.basename(target)}-`,
      ),
    );
    // Known as this server's live clone before its mark says it is a staging folder: a
    // sweep for another project that reads the mark from here on leaves it alone.
    liveCloneStaging.add(staging);
    // Marked before anything else goes in: the mark is what makes the folder Sync's.
    await markCloneStaging(staging);
    await NodeFSP.mkdir(NodePath.join(staging, CLONE_STAGING_CLONE));
    return await fill();
  } catch (cause) {
    // Past the point where the clone is in its place, nothing is undone or called refused.
    if (published) throw cause;
    // A folder that got no further than its name holds nothing and goes again.
    if (staging.length > 0)
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await undo();
    return refuse("The folder could not be created.");
  } finally {
    if (staging.length > 0) liveCloneStaging.delete(staging);
  }
  async function fill(): Promise<ProjectSyncStepResult> {
    const clone = NodePath.join(staging, CLONE_STAGING_CLONE);
    const discard = async () => {
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await undo();
    };
    const cloned = await context
      // The remote is always named origin, whatever `clone.defaultRemoteName` says.
      .git(
        clone,
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
      await discard();
      return refuse(
        context.signal?.aborted === true ? "The clone was cancelled." : gitReason(cloned.stderr),
      );
    }
    // Moved in only where nothing is. The target is made here first, exclusively: a folder
    // or file that appeared there, also an empty folder, makes that fail and stays. The
    // clone then takes the place of the empty folder this call just made. What is left
    // open: someone removing that folder and making an empty one of their own between
    // these two steps; an empty folder is all that could be replaced.
    const rename = () =>
      NodeFSP.rename(clone, target).then(
        () => true,
        () => false,
      );
    const moved = await NodeFSP.mkdir(target).then(
      async () =>
        (await rename()) ||
        // Where a rename never takes the place of a folder (Windows), the empty folder
        // goes first. A folder that gained a file meanwhile cannot be removed, and stays.
        ((await NodeFSP.rmdir(target).then(
          () => true,
          () => false,
        )) &&
          (await rename())),
      () => false,
    );
    if (!moved) {
      await discard();
      return refuse('A folder is already there. Use "Compare all files…".');
    }
    published = true;
    // The clone is in its place: what is left of the staging folder is its mark. From
    // here on the step is a clone that was made, whatever else fails: its branch is read
    // for the result when Git answers, and nothing kept of an earlier folder at this
    // path is gone by.
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    const branch = await branchAndHead(context.git, target).then(
      (read) => read.branch,
      () => null,
    );
    return step({ branch });
  }
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
  /** `git rev-parse --show-toplevel` of the thread's folder; null when Git could not read it. */
  readonly threadCheckout: string | null;
  readonly checkout: string;
}): boolean {
  const { threadFolder, checkout } = input;
  if (threadFolder === checkout) return true;
  if (checkout.startsWith(`${threadFolder}${NodePath.sep}`)) return true;
  // A subfolder whose checkout could not be read is taken for part of this one: nothing
  // moves on a guess.
  return (
    threadFolder.startsWith(`${checkout}${NodePath.sep}`) &&
    (input.threadCheckout === checkout || input.threadCheckout === null)
  );
}

/**
 * Runs `run` over the items, four at a time. When one fails no further item is
 * started, and the call ends only once every one that was started has ended:
 * whoever holds the project's lock never lets go of it while Git still runs.
 */
export async function inParallel<A, B>(items: ReadonlyArray<A>, run: (item: A) => Promise<B>) {
  const out: Array<B> = Array.from({ length: items.length });
  let next = 0;
  let failed = false;
  const ended = await Promise.allSettled(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length && !failed) {
        const index = next++;
        try {
          out[index] = await run(items[index]!);
        } catch (cause) {
          failed = true;
          throw cause;
        }
      }
    }),
  );
  for (const worker of ended) if (worker.status === "rejected") throw worker.reason;
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
  // A failure on one repository is that repository's facts: the others keep theirs.
  return inParallel(repositories, async (repository) =>
    repository.unread === true
      ? unreadFacts(repository.path, PROJECT_SYNC_PATH_UNREAD_DETAIL)
      : readRepositoryFacts(context, repository).catch(
          async (cause: unknown): Promise<ProjectSyncRepositoryFacts> => {
            // No row is written for it: nothing of this repository moves by this fetch.
            context.fetched?.rows.delete(repository.path);
            return {
              path: repository.path,
              branch: null,
              head: null,
              upstream: null,
              otherUpstream: null,
              ahead: 0,
              behind: 0,
              uncommitted: 0,
              stateUnread: true,
              inUseBy: null,
              remote: null,
              fetch: "failed",
              fetchError: didNotFinish(cause),
            };
          },
        ),
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
    // A failure on one repository is that repository's result: the others keep theirs.
    out.push(
      await fastForwardRepository(context, repository, wanted.otherBranch).catch((cause) =>
        failedStep(cause, { path: wanted.path, otherBranch: wanted.otherBranch, remote: null }),
      ),
    );
  }
  for (const wanted of input.clone)
    out.push(
      await cloneRepository(context, root, wanted).catch((cause) =>
        failedStep(cause, { path: wanted.path, otherBranch: null, remote: wanted.remote }),
      ),
    );
  return out;
}

/** The result of a repository whose step did not end: nothing is claimed about it but that. */
const failedStep = (
  cause: unknown,
  at: {
    readonly path: string;
    readonly otherBranch: string | null;
    readonly remote: string | null;
  },
): ProjectSyncStepResult => ({
  path: at.path,
  action: "none",
  reason: "refused",
  branch: null,
  otherBranch: at.otherBranch,
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: at.remote,
  detail: didNotFinish(cause),
  moved: 0,
  downgraded: true,
});

// Replacement objects never stand in for the commits Sync compares and moves to.
const defaultGit: SyncGit = (cwd, args, options) =>
  runGit(cwd, args, { ...options, env: { ...SYNC_ENV, ...options?.env } });

export class ProjectSync extends Context.Service<
  ProjectSync,
  {
    /** The project's folder and the repositories Sync lists in it. */
    readonly repositories: (projectId: ProjectId) => Effect.Effect<
      {
        readonly root: string;
        readonly repositories: ReadonlyArray<SyncRepository>;
        /** Paths the scan found under a folder named like a clone's staging folder; the sweep checks its mark. */
        readonly cloneStaging: ReadonlyArray<string>;
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

  /**
   * The repositories under a real project folder. A tree the scan cannot finish in its
   * budget or at all (past its limits, a link to a folder, a nested folder whose Git data
   * is broken) lists its root alone, marked as such: today's fallback of a Git sync move.
   * The root itself must be a repository.
   */
  const scan = Effect.fn("ProjectSync.scan")(function* (root: string, budget: Duration.Duration) {
    const found = yield* handoffGit
      .discover({ workspaceRoot: root })
      .pipe(
        Effect.timeoutOption(budget),
        Effect.catchTags({ HandoffGitError: () => Effect.succeedNone }),
      );
    if (Option.isSome(found)) return { paths: found.value, scanLimited: false };
    const isRepository = yield* attempt(async () => {
      const top = await read(defaultGit, root, ["rev-parse", "--show-toplevel"]);
      const real = top.ok ? await NodeFSP.realpath(top.text).catch(() => null) : null;
      return real === root;
    });
    if (!isRepository)
      return yield* failed("The project folder is not a Git repository.", "invalid");
    return { paths: ["."] as ReadonlyArray<string>, scanLimited: true };
  });

  /**
   * One walk per real folder: Sync calls that come while one runs (status, fetch,
   * inventory, run, from either window) wait for it, and one that finished a moment ago is
   * reused. The walk runs on its own, so a caller that is stopped (a cancelled fetch under
   * the project's lock) leaves at once; the walk itself ends within its budget. A failed
   * walk is not kept, and a run forgets the folder's walk, since a clone adds a repository.
   */
  const scans = new Map<
    string,
    { readonly done: Deferred.Deferred<Scanned, ProjectSyncError>; settledAt: number | null }
  >();
  const sharedScan = Effect.fn("ProjectSync.sharedScan")(function* (root: string) {
    const now = yield* Clock.currentTimeMillis;
    const existing = scans.get(root);
    if (
      existing &&
      (existing.settledAt === null || now - existing.settledAt < Duration.toMillis(SYNC_SCAN_REUSE))
    )
      return yield* Deferred.await(existing.done);
    const entry = {
      done: yield* Deferred.make<Scanned, ProjectSyncError>(),
      settledAt: null as number | null,
    };
    scans.set(root, entry);
    yield* scan(root, SYNC_SCAN_BUDGET).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) => {
            if (scans.get(root) === entry) {
              if (Exit.isSuccess(exit)) entry.settledAt = at;
              else scans.delete(root);
            }
            return Deferred.done(entry.done, exit);
          }),
        ),
      ),
      Effect.forkDetach,
    );
    return yield* Deferred.await(entry.done);
  });
  const forgetScan = (root: string) =>
    Effect.sync(() => {
      scans.delete(root);
    });

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
    const scanned = yield* sharedScan(root);
    return {
      root,
      repositories: yield* attempt(() => syncRepositories(defaultGit, root, scanned.paths)),
      cloneStaging: scanned.paths.filter((path) => path.split("/").some(namedLikeCloneStaging)),
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
   * it is asked: before a plan, and again immediately before the write. A list
   * that cannot be read is said as unread (undefined), so nothing moves on a guess
   * and no thread is made up.
   */
  const inUse: SyncContext["inUse"] = async (checkout) => {
    const rows = await Effect.runPromise(runningThreads).catch(() => null);
    if (rows === null) return undefined;
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
  /**
   * A call's context. A fetch writes its rows into `fetched`; a run looks the named
   * fetch up again on every read (`record`), so a record that expired or was dropped
   * meanwhile stops the move at its admission point.
   */
  const syncContext = (
    options: {
      readonly fetched?: FetchRecord;
      readonly record?: () => FetchRecord | undefined;
    },
    signal?: AbortSignal,
  ): SyncContext => ({
    git: defaultGit,
    inUse,
    ...(options.fetched === undefined ? {} : { fetched: options.fetched }),
    ...(options.record === undefined ? {} : { record: options.record }),
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
          // Every fetch call is its own record under its own id: a second window's fetch
          // never replaces what the first one's person approved.
          const record = newFetchRecord(input.projectId);
          // A cancelled fetch is stopped; the lock is held until Git has ended.
          const facts = yield* stoppedWhenCancelled((signal) =>
            fetchAll(syncContext({ fetched: record }, signal), found.repositories),
          );
          // Kept only now, every repository's fetch having ended.
          keepFetch(record);
          return {
            repositories: facts,
            scanLimited: found.scanLimited,
            fetchId: record.id,
            // This server moves a checkout only by a guarded fast-forward to what this
            // fetch brought: a window may offer "Sync" to it.
            guardedFastForward: true,
          };
        }),
      ),
    run: (input) =>
      admission.withLock(
        input.projectId,
        (() => {
          let ranIn: string | null = null;
          return Effect.gen(function* () {
            const found = yield* repositories(input.projectId);
            ranIn = found.root;
            const out: Array<ProjectSyncStepResult> = [];
            // The fetch the window names, when it is this project's and still kept, looked
            // up on every read. Nothing else is gone by: without it no checkout moves.
            const record = () => keptFetch(input.projectId, input.fetchId);
            // What a clone that never finished left behind goes first, under the lock: no
            // clone of this project is under way now. A folder that stays is said so.
            const { failed: kept, live } = yield* attempt(async () =>
              sweepCloneLeftovers(found.root, [
                ...found.cloneStaging,
                ...(await cloneStagingBeside(
                  found.root,
                  input.clone.map((wanted) => wanted.path),
                )),
              ]),
            ).pipe(Effect.uninterruptible);
            for (const path of kept)
              out.push({
                path: path.slice(0, 1024),
                action: "none",
                reason: "refused",
                branch: null,
                otherBranch: null,
                ahead: 0,
                behind: 0,
                uncommitted: 0,
                inUseBy: null,
                remote: null,
                detail:
                  "A clone that was stopped left this folder behind, and it could not be removed.",
                moved: 0,
                downgraded: false,
              });
            for (const path of live)
              out.push({
                path: path.slice(0, 1024),
                action: "none",
                reason: "refused",
                branch: null,
                otherBranch: null,
                ahead: 0,
                behind: 0,
                uncommitted: 0,
                inUseBy: null,
                remote: null,
                detail:
                  "Another SpecWithCode process may still be cloning into this folder, so it was left alone.",
                moved: 0,
                downgraded: false,
              });
            // A move is never cut short once Git holds its locks. A cancelled call ends
            // between two repositories.
            for (const wanted of input.fastForward) {
              out.push(
                ...(yield* attempt(() =>
                  runSync(syncContext({ record }), found.root, found.repositories, {
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
                  runSync(syncContext({ record }, signal), found.root, found.repositories, {
                    fastForward: [],
                    clone: [wanted],
                  }),
                )),
              );
            }
            return { repositories: out };
          }).pipe(
            // What a run cloned is listed by the next walk, not by one from before it.
            Effect.ensuring(Effect.suspend(() => (ranIn ? forgetScan(ranIn) : Effect.void))),
          );
        })(),
      ),
  });
});

/** Over services the caller gives: its project lock, the repository walk, the projects. */
export const layerOnServices = Layer.effect(ProjectSync, make);
export const layer = layerOnServices.pipe(
  Layer.provide(ProjectAdmission.layer),
  Layer.provide(HandoffGit.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
