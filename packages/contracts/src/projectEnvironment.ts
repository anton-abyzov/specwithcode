import * as Schema from "effect/Schema";
import { CommandId, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

export const ProjectKind = Schema.Literals(["code", "personal"]);
export type ProjectKind = typeof ProjectKind.Type;
/** Who a project is for; see `@specweave-studio/shared/projectOrigin`. */
export const ProjectOrigin = Schema.Literals(["user", "automated"]);
export type ProjectOrigin = typeof ProjectOrigin.Type;
export const ProjectRepositoryId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
);
const SafePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[^\x00-\x1f\x7f]+$/),
);

/** Only credential-free Git transports. Local paths are separate, explicitly approved fields. */
export function projectRepositoryIdentity(value: string): string | null {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  const scp = /^git@([a-zA-Z0-9.-]+):([^?#]+)$/.exec(value);
  let url: URL;
  try {
    url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
  } catch {
    return null;
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    /[%\\]/.test(url.pathname) ||
    value.includes("\\") ||
    (url.protocol === "https:" && url.username) ||
    (url.protocol === "ssh:" && url.username !== "git") ||
    !/^[a-zA-Z0-9.-]+$/.test(url.hostname)
  )
    return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const segments = pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (s) => !s || s === "." || s === ".." || !/^[a-zA-Z0-9_.-]+$/.test(s) || s.startsWith("-"),
    )
  )
    return null;
  // URL parsing normalizes dot segments, so also reject them in the supplied spelling.
  if (/(?:\/|:)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)) return null;
  const port =
    url.port &&
    !(
      (url.protocol === "ssh:" && url.port === "22") ||
      (url.protocol === "https:" && url.port === "443")
    )
      ? `:${url.port}`
      : "";
  const host = url.hostname.toLowerCase();
  const repository = segments.join("/").replace(/\.git$/i, "");
  return `${host}${port}/${host === "github.com" ? repository.toLowerCase() : repository}`;
}
export const ProjectRepositoryUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => projectRepositoryIdentity(value) !== null),
);
export const ProjectRepository = Schema.Struct({
  id: ProjectRepositoryId,
  url: ProjectRepositoryUrl,
  localPath: Schema.NullOr(SafePath),
});
export type ProjectRepository = typeof ProjectRepository.Type;
export const ProjectEnvironmentSettings = Schema.Struct({
  additionalFolders: Schema.Array(SafePath).check(Schema.isMaxLength(16)),
  repositories: Schema.Array(ProjectRepository).check(Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.additionalFolders).size === value.additionalFolders.length &&
      new Set(value.repositories.map((r) => r.id)).size === value.repositories.length &&
      new Set(
        value.repositories.map((r) =>
          JSON.stringify([projectRepositoryIdentity(r.url), r.localPath]),
        ),
      ).size === value.repositories.length,
  ),
);
export type ProjectEnvironmentSettings = typeof ProjectEnvironmentSettings.Type;
export const DEFAULT_PROJECT_ENVIRONMENT: ProjectEnvironmentSettings = {
  additionalFolders: [],
  repositories: [],
};
/**
 * Providers whose native runtime receives approved project folders as enforced
 * roots under any policy: Codex writable roots, Claude additional directories
 * and Muse Code workspace roots.
 */
export function providerEnforcesProjectFolders(driver: string | undefined): boolean {
  return driver === "codex" || driver === "claudeAgent" || driver === "muse";
}
/** ACP folder context preserves existing unrestricted access; it never broadens permissions. */
export function fullAccessAcpProjectFolders(policy: {
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}): boolean {
  const sandbox = policy.sandboxPolicy;
  return (
    policy.runtimeMode === "full-access" &&
    policy.interactionMode === "default" &&
    (policy.approvalPolicy === undefined || policy.approvalPolicy === "never") &&
    (sandbox === undefined ||
      (typeof sandbox === "object" &&
        sandbox !== null &&
        !Array.isArray(sandbox) &&
        "type" in sandbox &&
        sandbox.type === "dangerFullAccess"))
  );
}
export const ProjectEnvironmentReadInput = Schema.Struct({
  projectId: ProjectId,
  /** Ask for the repositories found in the project folder. Older servers ignore it. */
  discover: Schema.optionalKey(Schema.Boolean),
  /** With `discover`: walk the folder again instead of using the cached list. */
  refresh: Schema.optionalKey(Schema.Boolean),
  /** Also read the repositories this thread of the project holds. Older servers ignore it. */
  threadId: Schema.optionalKey(ThreadId),
});
export type ProjectEnvironmentReadInput = typeof ProjectEnvironmentReadInput.Type;
/** At most this many found repositories are listed; the rest are counted. */
export const PROJECT_FOUND_REPOSITORIES_MAX = 50;
/** A thread holds at most this many repositories. */
export const THREAD_REPOSITORIES_MAX = 8;
/**
 * One repository a project's threads can use: a clone found in the project folder, a saved
 * Environment repository, or one SpecWeave lists, joined by real path. Nothing here is saved;
 * it is read from the folder at use.
 */
export const ProjectFoundRepository = Schema.Struct({
  /** Path relative to the project folder ("." is the folder's own repository); the name a launch uses. */
  relativePath: Schema.String,
  path: Schema.String,
  name: Schema.String,
  /** The clone's origin as `owner/name`, or null when it has no usable remote. */
  origin: Schema.NullOr(Schema.String),
  /** The checked-out branch, or null when no branch is checked out. */
  branch: Schema.NullOr(Schema.String),
  /** The default branch on origin, when Git knows it. */
  defaultBranch: Schema.NullOr(Schema.String),
  inSpecweave: Schema.Boolean,
  /** `available`: a clone is here. `absent`: saved or listed, never cloned. `missing`: its folder is gone. */
  state: Schema.Literals(["available", "absent", "missing"]),
  noRemote: Schema.Boolean,
  threadWorktrees: NonNegativeInt,
  repositoryId: Schema.optionalKey(ProjectRepositoryId),
});
export type ProjectFoundRepository = typeof ProjectFoundRepository.Type;
/** A saved entry the found list makes redundant; removing it is always the user's click. */
export const ProjectRedundantRepositoryEntry = Schema.Struct({
  repositoryId: ProjectRepositoryId,
  reason: Schema.Literals(["found_clone", "no_folder"]),
});
export type ProjectRedundantRepositoryEntry = typeof ProjectRedundantRepositoryEntry.Type;
/** One repository a thread holds: its worktree inside the thread's folder. */
export const ThreadRepository = Schema.Struct({
  /** Its path inside the thread's folder, the same as in the project folder; "" is the folder itself. */
  relativePath: Schema.String,
  name: Schema.String,
  path: Schema.String,
  /** The repository's own checkout, which the worktree shares Git objects with. */
  repository: Schema.String,
  /** What the worktree was cut from, such as `origin/main`; null when the app did not record it. */
  baseRef: Schema.NullOr(Schema.String),
  /** Who added it to the running thread; null for one made at launch. */
  addedBy: Schema.NullOr(Schema.Literals(["agent", "user"])),
  addedAt: Schema.NullOr(Schema.String),
  dependencies: Schema.Literals(["installed", "not_installed"]),
  changed: Schema.Boolean,
});
export type ThreadRepository = typeof ThreadRepository.Type;
/**
 * The repositories of a thread that has its own folder (none for one that
 * started with no repository). A thread in the project folder, or in a single
 * worktree, has no such list.
 */
export const ThreadRepositories = Schema.Struct({
  folder: Schema.String,
  branch: Schema.NullOr(Schema.String),
  repositories: Schema.Array(ThreadRepository),
  /** A thread holds at most this many. */
  limit: NonNegativeInt,
});
export type ThreadRepositories = typeof ThreadRepositories.Type;
/**
 * A saved folder or repository checkout that runs skip, with the server's sentence naming
 * it and the fix. `updatePath` is offered only when a moved folder (or checkout) now
 * resolves to a checkout of the same repository; saving it is still an explicit approval.
 */
export const ProjectEnvironmentProblem = Schema.Struct({
  kind: Schema.Literals(["folder", "repository"]),
  path: Schema.String,
  reason: Schema.Literals(["missing", "moved", "protected", "duplicate", "outside"]),
  message: Schema.String,
  resolvedPath: Schema.optionalKey(Schema.String),
  repositoryId: Schema.optionalKey(ProjectRepositoryId),
  updatePath: Schema.optionalKey(SafePath),
});
export type ProjectEnvironmentProblem = typeof ProjectEnvironmentProblem.Type;
export const ProjectEnvironmentReadResult = Schema.Struct({
  revision: NonNegativeInt,
  workspaceRoot: SafePath,
  additionalFolders: Schema.Array(SafePath),
  repositories: Schema.Array(
    Schema.Struct({
      ...ProjectRepository.fields,
      status: Schema.Literals(["unprepared", "ready", "missing", "mismatch"]),
      /**
       * For a mismatch: the checkout's own origin, when it is a valid credential-free
       * repository URL (the repository was renamed or moved). Older servers omit it.
       */
      origin: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Entries left out above because they cannot be used as saved. Older servers omit it. */
  problems: Schema.optionalKey(Schema.Array(ProjectEnvironmentProblem)),
  /**
   * The repositories threads can use, when the read asked with `discover`. Its presence is
   * how a client knows the server finds repositories; older servers omit it.
   */
  found: Schema.optionalKey(Schema.Array(ProjectFoundRepository)),
  /** How many found repositories were left out of `found` (the list stops at 50). */
  foundMore: Schema.optionalKey(NonNegativeInt),
  /** True when the folder walk stopped at its limits before reading every folder. */
  foundTruncated: Schema.optionalKey(Schema.Boolean),
  /** True when the project folder is itself a Git repository ("." in a launch). */
  rootIsRepository: Schema.optionalKey(Schema.Boolean),
  /**
   * True when the folder holds clones of their own, so a launch that names no
   * repository starts in its own folder with the ones its message names.
   */
  separateClones: Schema.optionalKey(Schema.Boolean),
  /**
   * Links left out of `found`, relative to the project folder: `target` is the listed
   * repository the link leads to, or null when it leads outside the project folder.
   */
  skippedLinks: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, target: Schema.NullOr(Schema.String) })),
  ),
  redundantEntries: Schema.optionalKey(Schema.Array(ProjectRedundantRepositoryEntry)),
  /** With `threadId`: that thread's repositories, when it has its own folder. */
  thread: Schema.optionalKey(ThreadRepositories),
});
export type ProjectEnvironmentReadResult = typeof ProjectEnvironmentReadResult.Type;
export const ProjectEnvironmentPrepareInput = Schema.Struct({
  projectId: ProjectId,
  repositoryId: ProjectRepositoryId,
  expectedRevision: NonNegativeInt,
  commandId: CommandId,
  /**
   * `thread_add` adds `repository` to thread `threadId` (the thread's "Add repository"),
   * through the same action as the agent's tool; `repositoryId` and `expectedRevision`
   * are not read then. Older servers refuse the mode.
   */
  mode: Schema.Literals(["clone", "match", "thread_add"]),
  threadId: Schema.optionalKey(ThreadId),
  repository: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ),
});
export type ProjectEnvironmentPrepareInput = typeof ProjectEnvironmentPrepareInput.Type;
/** Import only describes existing checkouts. It never grants folder access or changes plan authority. */
export const ProjectEnvironmentImportPreviewInput = Schema.Struct({
  projectId: ProjectId,
  root: SafePath,
});
export type ProjectEnvironmentImportPreviewInput = typeof ProjectEnvironmentImportPreviewInput.Type;
export const ProjectEnvironmentImportPreview = Schema.Struct({
  revision: NonNegativeInt,
  root: SafePath,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  repositories: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      url: Schema.NullOr(ProjectRepositoryUrl),
      status: Schema.Literals(["add", "existing", "blocked"]),
      reason: Schema.String,
    }),
  ).check(Schema.isMaxLength(256)),
  environment: ProjectEnvironmentSettings,
  canApply: Schema.Boolean,
});
export type ProjectEnvironmentImportPreview = typeof ProjectEnvironmentImportPreview.Type;
export const ProjectEnvironmentImportInput = Schema.Struct({
  ...ProjectEnvironmentImportPreviewInput.fields,
  expectedRevision: NonNegativeInt,
  fingerprint: ProjectEnvironmentImportPreview.fields.fingerprint,
  commandId: CommandId,
});
export type ProjectEnvironmentImportInput = typeof ProjectEnvironmentImportInput.Type;
/** One approved folder or repository entry, named so Settings can show its error beside it. */
export const ProjectEnvironmentEntryRef = Schema.Struct({
  kind: Schema.Literals(["folder", "repository"]),
  path: Schema.String,
  repositoryId: Schema.optionalKey(ProjectRepositoryId),
});
export type ProjectEnvironmentEntryRef = typeof ProjectEnvironmentEntryRef.Type;
export class ProjectEnvironmentError extends Schema.TaggedError<ProjectEnvironmentError>()(
  "ProjectEnvironmentError",
  {
    projectId: ProjectId,
    code: Schema.Literals([
      "not_found",
      "inactive",
      "conflict",
      "invalid",
      "path_not_approved",
      "folder_changed",
      "destination_exists",
      "repository_mismatch",
      "outcome_unknown",
      "preparation_failed",
      "unsupported_provider",
      "import_changed",
      "import_blocked",
    ]),
    /** Which entry failed and how to fix it, when one entry is to blame. */
    detail: Schema.optional(Schema.String),
    /** The entry to blame, so Settings can show the error beside it. Older servers omit it. */
    entry: Schema.optional(ProjectEnvironmentEntryRef),
  },
) {
  override get message(): string {
    if (this.detail !== undefined && this.detail.length > 0) return this.detail;
    return {
      not_found: "The project or repository is no longer available.",
      inactive: "Resume or restore this project before preparing a repository.",
      conflict: "Project settings changed. Reload before preparing a repository.",
      invalid: "Use a credential-free HTTPS or SSH Git URL and valid approved folders.",
      path_not_approved: "The repository path must stay inside an approved project folder.",
      folder_changed:
        "A folder this project is approved to use was moved, renamed or replaced by a link, so the agent did not start. Put the folder back, or update it in Project settings > Environment.",
      destination_exists:
        "The destination already exists. Match its repository or choose an unused path.",
      repository_mismatch: "The existing checkout does not match this repository URL.",
      outcome_unknown:
        "This preparation was already started. Inspect the destination before a new action.",
      preparation_failed:
        "Repository preparation failed. Check this host's Git access and inspect the destination.",
      unsupported_provider: "This provider cannot enforce additional project folder access.",
      import_changed: "The workspace or project changed. Preview the import again.",
      import_blocked: "Resolve the blocked repositories before importing this workspace.",
    }[this.code];
  }
}
