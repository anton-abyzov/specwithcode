// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Sync for a project that exists on two machines (1390). Each machine fetches
 * `origin` for its own repositories and fast-forwards a clean checkout that is
 * only behind; a repository it lacks is cloned. This module runs exactly these
 * Git commands that change anything: `fetch origin`, `merge --ff-only` and
 * `clone`. It never resets, rebases, merges with a merge commit, stashes,
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

import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
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
  options?: { readonly allowFailure?: boolean; readonly timeoutMs?: number },
) => Promise<GitResult>;

export interface SyncContext {
  readonly git: SyncGit;
  /** The title of a running thread that works in this very checkout, or null. */
  readonly inUse: (checkout: string) => Promise<string | null>;
}

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
  return status.text.length === 0 ? 0 : status.text.split("\n").length;
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
 * A repository as the plan needs it. `fetch: true` runs `git fetch origin`
 * first; the recheck before a fast-forward passes false and reads local Git.
 */
export async function readRepositoryFacts(
  context: SyncContext,
  repository: SyncRepository,
  options: { readonly fetch: boolean },
): Promise<ProjectSyncRepositoryFacts> {
  const { git } = context;
  const { cwd, path } = repository;
  const origin = await read(git, cwd, ["remote", "get-url", "origin"]);
  const hasOrigin = origin.ok && origin.text.length > 0;
  let fetch: ProjectSyncRepositoryFacts["fetch"] = hasOrigin ? "not-run" : "no-remote";
  let fetchError: string | null = null;
  if (hasOrigin && options.fetch) {
    const fetched = await git(cwd, ["fetch", "--quiet", "origin"], {
      allowFailure: true,
      timeoutMs: FETCH_MS,
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
    inUseBy: await context.inUse(cwd),
    remote: hasOrigin && canonicalOrigin(origin.text) !== null ? origin.text : null,
    fetch,
    fetchError,
  };
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
 * ever written over. A remote that carries a credential or names a transport
 * other than https, ssh, git or a local path is refused.
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
  if (input.path === "." || !safeRelativePath(input.path))
    return refuse("The repository's folder is not a path inside the project.");
  if (input.remote.startsWith("-") || canonicalOrigin(input.remote) === null)
    return refuse("The remote is not an address Sync clones from.");
  const realRoot = await NodeFSP.realpath(root).catch(() => null);
  if (realRoot === null) return refuse("The project folder is missing.");
  const target = NodePath.join(realRoot, ...input.path.split("/"));
  if ((await NodeFSP.lstat(target).catch(() => null)) !== null)
    return refuse('A folder is already there. Use "Compare all files…".');
  const parent = NodePath.dirname(target);
  try {
    await NodeFSP.mkdir(parent, { recursive: true });
    const realParent = await NodeFSP.realpath(parent);
    // A link on the way would put the clone outside the project folder.
    if (realParent !== parent) return refuse("The folder's path leaves the project folder.");
    await NodeFSP.mkdir(target);
  } catch {
    return refuse("The folder could not be created.");
  }
  const cloned = await context
    .git(target, ["clone", "--quiet", "--", input.remote, "."], {
      allowFailure: true,
      timeoutMs: CLONE_MS,
    })
    .catch((cause: unknown) => ({
      code: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : "The clone did not finish.",
    }));
  if (cloned.code !== 0) {
    // Only the folder this call made, and only while Git left nothing in it.
    await NodeFSP.rmdir(target).catch(() => undefined);
    return refuse(gitReason(cloned.stderr));
  }
  const { branch } = await branchAndHead(context.git, target);
  return step({ branch });
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

/** `git fetch origin` in every repository. One that fails is reported; the others continue. */
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

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const handoffGit = yield* HandoffGit.HandoffGit;
  const sql = yield* SqlClient.SqlClient;

  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        failed(cause instanceof Error ? cause.message.slice(0, 1900) : "Git did not finish."),
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
  `.pipe(Effect.mapError(() => failed("Could not read which threads are running.")));

  const context = Effect.gen(function* () {
    const rows = yield* runningThreads;
    const threads = yield* attempt(() =>
      Promise.all(
        rows.map(async (row) => {
          const folder = row.worktreePath ?? row.workspaceRoot;
          const real = await NodeFSP.realpath(folder).catch(() => NodePath.resolve(folder));
          const top = await read(defaultGit, real, ["rev-parse", "--show-toplevel"]).catch(
            () => null,
          );
          const checkout =
            top?.ok === true
              ? await NodeFSP.realpath(top.text).catch(() => NodePath.resolve(top.text))
              : null;
          return { title: row.title ?? "a thread", folder: real, checkout };
        }),
      ),
    );
    const syncContext: SyncContext = {
      git: defaultGit,
      inUse: async (checkout) =>
        threads.find((thread) =>
          threadUsesCheckout({
            threadFolder: thread.folder,
            threadCheckout: thread.checkout,
            checkout,
          }),
        )?.title ?? null,
    };
    return syncContext;
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
          const syncContext = yield* context;
          return {
            repositories: yield* attempt(() => fetchAll(syncContext, found.repositories)),
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
          // Which threads run is read again for each repository, right before it moves.
          for (const wanted of input.fastForward) {
            const syncContext = yield* context;
            out.push(
              ...(yield* attempt(() =>
                runSync(syncContext, found.root, found.repositories, {
                  fastForward: [wanted],
                  clone: [],
                }),
              )),
            );
          }
          if (input.clone.length > 0) {
            const syncContext = yield* context;
            out.push(
              ...(yield* attempt(() =>
                runSync(syncContext, found.root, found.repositories, {
                  fastForward: [],
                  clone: input.clone,
                }),
              )),
            );
          }
          return { repositories: out };
        }),
      ),
  });
});

export const layer = Layer.effect(ProjectSync, make);
