import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * Sync for a project that exists on two machines. Each machine runs
 * `git fetch origin` for its own repositories and fast-forwards a clean
 * checkout that is only behind. Nothing is fetched from the other machine and
 * nothing is pushed. Work Git does not carry (commits not pushed, branches
 * only on one machine, uncommitted and untracked files) is an extra: it
 * travels only when asked for, machine to machine, and always arrives as a
 * branch `swc/from-{machine}/…`, never in a working folder.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));
/** A repository's place in the project folder with `/` separators; "." is the folder itself. */
const repositoryPath = bounded(1024);
const branchName = bounded(255);
const operationId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);

export const PROJECT_SYNC_MAX_REPOSITORIES = 128;
export const PROJECT_SYNC_MAX_LISTED = 200;
/** Bytes of an untracked file the snapshot's secret check reads. */
export const PROJECT_SYNC_CONTENT_CHECK_BYTES = 64 * 1024;
/** Files whose content one snapshot's secret check reads. */
export const PROJECT_SYNC_CONTENT_CHECK_FILES = 2000;

/** Everything Sync can do to a repository on one machine. There is no fifth action. */
export const ProjectSyncAction = Schema.Literals(["none", "fetch", "fast-forward", "clone"]);
export type ProjectSyncAction = typeof ProjectSyncAction.Type;

/** Why a repository got its action: one value per state Sync tells apart. */
export const ProjectSyncReason = Schema.Literals([
  /** Clean, behind its upstream, no commits of its own: moved forward `behind` commits. */
  "behind",
  "up-to-date",
  /** Clean, has `ahead` commits its upstream lacks, not behind. They are listed as an extra. */
  "not-pushed",
  /** Has `ahead` commits of its own and is `behind` behind. Not moved. */
  "diverged",
  /** `uncommitted` files keep it from moving forward. */
  "uncommitted",
  /** A running thread (`inUseBy`) works in this very checkout. */
  "in-use",
  /** On another branch than the other machine. Nothing is checked out. */
  "other-branch",
  "detached",
  "no-upstream",
  /** The fetch failed; `detail` is Git's reason. The other repositories continue. */
  "fetch-failed",
  /** The repository is here but has no `origin`. */
  "no-remote",
  /** Missing here and the other machine names a remote: cloned from it. */
  "missing",
  /** Missing here and not in Git on a remote. Only the full compare can bring it. */
  "missing-no-remote",
  /** The clone or the fast-forward was refused by Git or by the folder; `detail` says why. */
  "refused",
]);
export type ProjectSyncReason = typeof ProjectSyncReason.Type;

/** What `projectSync.status` returns per repository, from local Git alone. Nothing else. */
export const ProjectSyncRepositoryStatus = Schema.Struct({
  path: repositoryPath,
  branch: Schema.NullOr(branchName),
  head: Schema.NullOr(sha),
  clean: Schema.Boolean,
});
export type ProjectSyncRepositoryStatus = typeof ProjectSyncRepositoryStatus.Type;

export const ProjectSyncProjectInput = Schema.Struct({ projectId: ProjectId });
export type ProjectSyncProjectInput = typeof ProjectSyncProjectInput.Type;

export const ProjectSyncStatusResult = Schema.Struct({
  repositories: Schema.Array(ProjectSyncRepositoryStatus).check(
    Schema.isMaxLength(PROJECT_SYNC_MAX_REPOSITORIES),
  ),
  /**
   * The folder could not be scanned in full (past the scan limits, a link to a folder, or a
   * nested folder whose Git data is broken): only the root repository is listed.
   */
  scanLimited: Schema.Boolean,
});
export type ProjectSyncStatusResult = typeof ProjectSyncStatusResult.Type;

/** A repository after this machine's own `git fetch origin`: what a plan is made from. */
export const ProjectSyncRepositoryFacts = Schema.Struct({
  path: repositoryPath,
  branch: Schema.NullOr(branchName),
  head: Schema.NullOr(sha),
  /** The branch's upstream, such as `origin/main`; null without one or off a branch. */
  upstream: Schema.NullOr(bounded(512)),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  /** Changed and untracked files, as `git status` counts them. */
  uncommitted: NonNegativeInt,
  /** The title of a running thread that works in this very checkout. */
  inUseBy: Schema.NullOr(bounded(500)),
  /** `origin`'s address, only when it carries no credential; a missing copy clones from it. */
  remote: Schema.NullOr(bounded(2048)),
  fetch: Schema.Literals(["ok", "failed", "no-remote", "not-run"]),
  /** Git's reason for a failed fetch. */
  fetchError: Schema.NullOr(bounded(2000)),
});
export type ProjectSyncRepositoryFacts = typeof ProjectSyncRepositoryFacts.Type;

export const ProjectSyncFetchResult = Schema.Struct({
  repositories: Schema.Array(ProjectSyncRepositoryFacts).check(
    Schema.isMaxLength(PROJECT_SYNC_MAX_REPOSITORIES),
  ),
  scanLimited: Schema.Boolean,
});
export type ProjectSyncFetchResult = typeof ProjectSyncFetchResult.Type;

/** One repository on one machine: the single thing Sync does there, and why. */
export const ProjectSyncStep = Schema.Struct({
  path: repositoryPath,
  action: ProjectSyncAction,
  reason: ProjectSyncReason,
  branch: Schema.NullOr(branchName),
  /** The other machine's branch, for "other-branch". */
  otherBranch: Schema.NullOr(branchName),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  uncommitted: NonNegativeInt,
  inUseBy: Schema.NullOr(bounded(500)),
  remote: Schema.NullOr(bounded(2048)),
  detail: Schema.NullOr(bounded(2000)),
});
export type ProjectSyncStep = typeof ProjectSyncStep.Type;

/**
 * The one action for a repository that exists on this machine. States overlap,
 * so the first that matches wins: a failed fetch, no remote, not on a branch,
 * another branch than the other machine, no upstream; then, when nothing is
 * behind, up to date or commits not pushed; then, when behind, commits of its
 * own, uncommitted files, a thread at work, and only then a fast-forward.
 */
export function planProjectSyncRepository(
  facts: ProjectSyncRepositoryFacts,
  other: { readonly branch: string | null } | null,
): ProjectSyncStep {
  const step = (
    action: ProjectSyncAction,
    reason: ProjectSyncReason,
    detail: string | null = null,
  ): ProjectSyncStep => ({
    path: facts.path,
    action,
    reason,
    branch: facts.branch,
    otherBranch: other?.branch ?? null,
    ahead: facts.ahead,
    behind: facts.behind,
    uncommitted: facts.uncommitted,
    inUseBy: facts.inUseBy,
    remote: facts.remote,
    detail,
  });
  if (facts.fetch === "failed") return step("none", "fetch-failed", facts.fetchError);
  if (facts.fetch === "no-remote") return step("none", "no-remote");
  if (facts.branch === null) return step("fetch", "detached");
  if (other !== null && other.branch !== null && other.branch !== facts.branch)
    return step("fetch", "other-branch");
  if (facts.upstream === null) return step("none", "no-upstream");
  if (facts.behind === 0) return step("none", facts.ahead > 0 ? "not-pushed" : "up-to-date");
  if (facts.ahead > 0) return step("fetch", "diverged");
  if (facts.uncommitted > 0) return step("fetch", "uncommitted");
  if (facts.inUseBy !== null) return step("fetch", "in-use");
  return step("fast-forward", "behind");
}

/**
 * The plan for one machine: a step per repository it has, and a step per
 * repository only the other machine has (`clone` when that one names a remote).
 */
export function planProjectSync(
  here: ReadonlyArray<ProjectSyncRepositoryFacts>,
  there: ReadonlyArray<ProjectSyncRepositoryFacts>,
): Array<ProjectSyncStep> {
  const others = new Map(there.map((facts) => [facts.path, facts]));
  const steps = here.map((facts) =>
    planProjectSyncRepository(facts, others.get(facts.path) ?? null),
  );
  const held = new Set(here.map((facts) => facts.path));
  for (const facts of there) {
    if (held.has(facts.path)) continue;
    steps.push({
      path: facts.path,
      action: facts.remote === null ? "none" : "clone",
      reason: facts.remote === null ? "missing-no-remote" : "missing",
      branch: null,
      otherBranch: facts.branch,
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      inUseBy: null,
      remote: facts.remote,
      detail: null,
    });
  }
  return steps;
}

/**
 * What the window asks this machine to do. It is a proposal: the server reads
 * each repository again immediately before it moves it, and does less when
 * the repository changed since the plan.
 */
export const ProjectSyncRunInput = Schema.Struct({
  projectId: ProjectId,
  fastForward: Schema.Array(
    Schema.Struct({
      path: repositoryPath,
      /** The other machine's branch, so "other-branch" is judged again. */
      otherBranch: Schema.NullOr(branchName),
    }),
  ).check(Schema.isMaxLength(PROJECT_SYNC_MAX_REPOSITORIES)),
  clone: Schema.Array(Schema.Struct({ path: repositoryPath, remote: bounded(2048) })).check(
    Schema.isMaxLength(PROJECT_SYNC_MAX_REPOSITORIES),
  ),
});
export type ProjectSyncRunInput = typeof ProjectSyncRunInput.Type;

export const ProjectSyncStepResult = Schema.Struct({
  ...ProjectSyncStep.fields,
  /** Commits a fast-forward moved the checkout by. */
  moved: NonNegativeInt,
  /** The plan asked for more than was safe by the time it ran. */
  downgraded: Schema.Boolean,
});
export type ProjectSyncStepResult = typeof ProjectSyncStepResult.Type;

export const ProjectSyncRunResult = Schema.Struct({
  repositories: Schema.Array(ProjectSyncStepResult),
});
export type ProjectSyncRunResult = typeof ProjectSyncRunResult.Type;

/** A file a snapshot leaves out, and why. */
export const ProjectSyncLeftOutFile = Schema.Struct({
  path: bounded(4096),
  /**
   * `name`: a secret by its file name; it travels only sealed. `content`: a
   * well-known token in its first 64 KB. `not-checked`: past the files one
   * snapshot reads. The last two travel when sent anyway.
   */
  reason: Schema.Literals(["name", "content", "not-checked"]),
  /** The kind of token found, such as "GitHub token". */
  kind: Schema.NullOr(bounded(80)),
  /** When the file last changed, in milliseconds, so the newer side of a secret can be named. */
  modifiedAtMs: Schema.NullOr(NonNegativeInt),
});
export type ProjectSyncLeftOutFile = typeof ProjectSyncLeftOutFile.Type;

export const ProjectSyncBranchExtra = Schema.Struct({
  branch: branchName,
  head: sha,
  /** Commits the upstream lacks; for a branch only here, commits no remote branch holds. */
  commits: NonNegativeInt,
});
export type ProjectSyncBranchExtra = typeof ProjectSyncBranchExtra.Type;

/** Work in one repository that Git does not carry. Nothing here travels unless asked for. */
export const ProjectSyncRepositoryExtras = Schema.Struct({
  path: repositoryPath,
  /** Branches with an upstream that have commits it lacks: one line per branch. */
  notPushed: Schema.Array(ProjectSyncBranchExtra).check(
    Schema.isMaxLength(PROJECT_SYNC_MAX_LISTED),
  ),
  /** Branches with no upstream and no branch of that name on `origin`. */
  onlyHere: Schema.Array(ProjectSyncBranchExtra).check(Schema.isMaxLength(PROJECT_SYNC_MAX_LISTED)),
  /** Branches left off either list because it was full. */
  branchesNotListed: NonNegativeInt,
  changedFiles: NonNegativeInt,
  untrackedFiles: NonNegativeInt,
  /** Stashes stay; they are listed and cannot be sent. */
  stashes: NonNegativeInt,
  /** Files a snapshot of the uncommitted work would leave out. */
  leftOut: Schema.Array(ProjectSyncLeftOutFile).check(Schema.isMaxLength(PROJECT_SYNC_MAX_LISTED)),
  leftOutNotListed: NonNegativeInt,
});
export type ProjectSyncRepositoryExtras = typeof ProjectSyncRepositoryExtras.Type;

export const ProjectSyncInventoryResult = Schema.Struct({
  repositories: Schema.Array(ProjectSyncRepositoryExtras).check(
    Schema.isMaxLength(PROJECT_SYNC_MAX_REPOSITORIES),
  ),
  scanLimited: Schema.Boolean,
});
export type ProjectSyncInventoryResult = typeof ProjectSyncInventoryResult.Type;

export const ProjectSyncExtraItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("branch"),
    path: repositoryPath,
    branch: branchName,
  }),
  Schema.Struct({
    kind: Schema.Literal("uncommitted"),
    path: repositoryPath,
    /** Left-out files to send anyway. A secret by name is never sent this way. */
    sendAnyway: Schema.Array(bounded(4096)).check(Schema.isMaxLength(PROJECT_SYNC_MAX_LISTED)),
  }),
]);
export type ProjectSyncExtraItem = typeof ProjectSyncExtraItem.Type;

export const ProjectSyncSendExtrasInput = Schema.Struct({
  projectId: ProjectId,
  /** The machine the extras go to. */
  targetEnvironmentId: EnvironmentId,
  operationId,
  items: Schema.Array(ProjectSyncExtraItem).check(Schema.isMaxLength(PROJECT_SYNC_MAX_LISTED)),
});
export type ProjectSyncSendExtrasInput = typeof ProjectSyncSendExtrasInput.Type;

export const ProjectSyncExtraResult = Schema.Struct({
  kind: Schema.Literals(["branch", "uncommitted"]),
  path: repositoryPath,
  /** The branch asked for; null for uncommitted work. */
  branch: Schema.NullOr(branchName),
  status: Schema.Literals(["sent", "stays"]),
  /** The branch it arrived as on the other machine. */
  arrivedAs: Schema.NullOr(bounded(512)),
  /**
   * `created`, `moved-forward` and `unchanged` name the plain branch.
   * `beside` means the plain name was taken by other work, `checked-out` that
   * it is checked out there; both arrive under a name ending in the operation's id.
   */
  landed: Schema.NullOr(
    Schema.Literals(["created", "moved-forward", "unchanged", "beside", "checked-out"]),
  ),
  /** Why it stays. */
  stays: Schema.NullOr(
    Schema.Literals([
      "nothing-to-send",
      "missing-branch",
      "file-too-large",
      "too-many-files",
      "bundle-too-large",
      /** The other machine runs a version without Sync. */
      "needs-update",
      "refused",
      "unreachable",
      "failed",
    ]),
  ),
  /** The file or the count that exceeded a limit, or the other machine's reason. */
  detail: Schema.NullOr(bounded(2000)),
  /** Size of the bundle that travelled. */
  bytes: NonNegativeInt,
  /** Commits not pushed that travelled with uncommitted work, and the branch they are on. */
  includedCommits: NonNegativeInt,
  includedBranch: Schema.NullOr(branchName),
  /** Files the snapshot left out. */
  leftOut: Schema.Array(ProjectSyncLeftOutFile).check(Schema.isMaxLength(PROJECT_SYNC_MAX_LISTED)),
  leftOutNotListed: NonNegativeInt,
});
export type ProjectSyncExtraResult = typeof ProjectSyncExtraResult.Type;

export const ProjectSyncSendExtrasResult = Schema.Struct({
  items: Schema.Array(ProjectSyncExtraResult),
});
export type ProjectSyncSendExtrasResult = typeof ProjectSyncSendExtrasResult.Type;

export class ProjectSyncError extends Schema.TaggedError<ProjectSyncError>()("ProjectSyncError", {
  code: Schema.Literals(["not_found", "personal", "invalid", "busy", "failed"]),
  reason: bounded(2000),
}) {
  override get message(): string {
    return this.reason;
  }
}

export const PROJECT_SYNC_RPC_METHODS = {
  projectSyncStatus: "projectSync.status",
  projectSyncInventory: "projectSync.inventory",
  projectSyncFetch: "projectSync.fetch",
  projectSyncRun: "projectSync.run",
  projectSyncSendExtras: "projectSync.sendExtras",
} as const;

const M = PROJECT_SYNC_RPC_METHODS;
const error = Schema.Union([ProjectSyncError, EnvironmentAuthorizationError]);

/** Project sync calls, registered as their own group (see `WsProjectSyncRpcGroup`). */
export const projectSyncRpcs = [
  Rpc.make(M.projectSyncStatus, {
    payload: ProjectSyncProjectInput,
    success: ProjectSyncStatusResult,
    error,
  }),
  Rpc.make(M.projectSyncInventory, {
    payload: ProjectSyncProjectInput,
    success: ProjectSyncInventoryResult,
    error,
  }),
  Rpc.make(M.projectSyncFetch, {
    payload: ProjectSyncProjectInput,
    success: ProjectSyncFetchResult,
    error,
  }),
  Rpc.make(M.projectSyncRun, {
    payload: ProjectSyncRunInput,
    success: ProjectSyncRunResult,
    error,
  }),
  Rpc.make(M.projectSyncSendExtras, {
    payload: ProjectSyncSendExtrasInput,
    success: ProjectSyncSendExtrasResult,
    error,
  }),
] as const;
