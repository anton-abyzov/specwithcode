import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The Git repositories a project folder holds besides its own root, wherever
 * they sit in it: an umbrella's `repositories/<owner>/<name>`, `apps/api`, or
 * any other layout. The list is kept as the project note `repositories.md`,
 * which travels to every linked copy. Another machine keeps its clones
 * wherever it likes and clones one a task needs from its remote: code moves
 * only through Git, never copied from another machine.
 */

/**
 * A path inside the project folder, with forward slashes: never absolute, and
 * no hidden segment, so never `..` and never into a `.git` folder. The scan
 * that lists checkouts skips hidden folders too.
 */
export const ProjectRelativePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.makeFilter(isProjectRelativePath),
);

export function isProjectRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

export const ProjectNestedRepository = Schema.Struct({
  /** Where the checkout sits inside the project folder. */
  path: ProjectRelativePath,
  /** The URL another machine clones: credential-free. */
  remoteUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  /** The repository both checkouts must be, compared by remote, never by folder name. */
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  /** "owner/name" when the remote names it, else the folder name. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type ProjectNestedRepository = typeof ProjectNestedRepository.Type;

export const PROJECT_NESTED_REPOSITORY_LIMIT = 64;

export const ProjectRepositoriesReadInput = Schema.Struct({ projectId: ProjectId });
export type ProjectRepositoriesReadInput = typeof ProjectRepositoriesReadInput.Type;

export const ProjectRepositoriesReadResult = Schema.Struct({
  projectId: ProjectId,
  repositories: Schema.Array(ProjectNestedRepository).check(
    Schema.isMaxLength(PROJECT_NESTED_REPOSITORY_LIMIT),
  ),
  /** Checkouts with no remote: no other machine can clone them, so they are listed apart. */
  withoutRemote: Schema.Array(ProjectRelativePath).check(
    Schema.isMaxLength(PROJECT_NESTED_REPOSITORY_LIMIT),
  ),
  /** The folder held more than the scan reads; the list is not complete. */
  truncated: Schema.Boolean,
});
export type ProjectRepositoriesReadResult = typeof ProjectRepositoriesReadResult.Type;

export const ProjectRepositoriesCheckInput = Schema.Struct({
  /** The project on the machine that answers, which may be another machine's copy. */
  projectId: ProjectId,
  repositories: Schema.Array(ProjectNestedRepository).check(
    Schema.isMaxLength(PROJECT_NESTED_REPOSITORY_LIMIT),
  ),
  /** Clone each missing checkout from its remote, with this machine's Git credentials. */
  clone: Schema.Boolean,
});
export type ProjectRepositoriesCheckInput = typeof ProjectRepositoriesCheckInput.Type;

export const ProjectRepositoryPresenceStatus = Schema.Literals([
  /** A clone of the same repository is there, or elsewhere in the copy (`foundAt`). */
  "present",
  /** Nothing is at that path. */
  "missing",
  /** It was missing and is now cloned. */
  "cloned",
  /** Something else is at that path: another repository, or a folder that is not a checkout. */
  "different",
  /** Not cloned: the clone failed, another is running, or the remote is not HTTPS or SSH. `detail` says why. */
  "failed",
]);
export type ProjectRepositoryPresenceStatus = typeof ProjectRepositoryPresenceStatus.Type;

export const ProjectRepositoryPresence = Schema.Struct({
  path: ProjectRelativePath,
  status: ProjectRepositoryPresenceStatus,
  detail: Schema.NullOr(Schema.String),
  /**
   * Where that copy holds the repository when it is not at `path`: a copy may
   * keep its clones in any layout. Absent from older machines' answers.
   */
  foundAt: Schema.optional(ProjectRelativePath),
});
export type ProjectRepositoryPresence = typeof ProjectRepositoryPresence.Type;

export const ProjectRepositoriesCheckResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  results: Schema.Array(ProjectRepositoryPresence),
});
export type ProjectRepositoriesCheckResult = typeof ProjectRepositoriesCheckResult.Type;

export class ProjectRepositoriesError extends Schema.TaggedError<ProjectRepositoriesError>()(
  "ProjectRepositoriesError",
  { message: Schema.String },
) {}
