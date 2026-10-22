import * as Schema from "effect/Schema";
import { CommandId, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

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
export const ProjectEnvironmentReadInput = Schema.Struct({ projectId: ProjectId });
export const ProjectEnvironmentReadResult = Schema.Struct({
  revision: NonNegativeInt,
  workspaceRoot: SafePath,
  additionalFolders: Schema.Array(SafePath),
  repositories: Schema.Array(
    Schema.Struct({
      ...ProjectRepository.fields,
      status: Schema.Literals(["unprepared", "ready", "missing", "mismatch"]),
    }),
  ),
});
export type ProjectEnvironmentReadResult = typeof ProjectEnvironmentReadResult.Type;
export const ProjectEnvironmentPrepareInput = Schema.Struct({
  projectId: ProjectId,
  repositoryId: ProjectRepositoryId,
  expectedRevision: NonNegativeInt,
  commandId: CommandId,
  mode: Schema.Literals(["clone", "match"]),
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
      "destination_exists",
      "repository_mismatch",
      "outcome_unknown",
      "preparation_failed",
      "unsupported_provider",
      "import_changed",
      "import_blocked",
    ]),
  },
) {
  override get message(): string {
    return {
      not_found: "The project or repository is no longer available.",
      inactive: "Resume or restore this project before preparing a repository.",
      conflict: "Project settings changed. Reload before preparing a repository.",
      invalid: "Use a credential-free HTTPS or SSH Git URL and valid approved folders.",
      path_not_approved: "The repository path must stay inside an approved project folder.",
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
