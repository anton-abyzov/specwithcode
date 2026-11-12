/**
 * The parts of studio_project_create that match the New project dialog: the
 * parent folder, a create failure that names the fix, an already registered
 * folder, and publishing a private GitHub repository.
 *
 * @module projectCreate
 */
import {
  OrchestratorMcpFailure,
  type Project,
  type ProjectCreatePublished,
  type ProjectCreateToolOptions,
  type SourceControlPublishFailureReason,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import type * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import type * as ProjectService from "../../../project/ProjectService.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** `~` and `~/...` on this machine's home; any other path must already be absolute. */
export const absoluteParentPath = Effect.fn("mcp.projectCreate.absoluteParentPath")(function* (
  parentPath: string,
) {
  const path = yield* Path.Path;
  const expanded =
    parentPath === "~"
      ? NodeOS.homedir()
      : parentPath.startsWith("~/") || parentPath.startsWith("~\\")
        ? path.join(NodeOS.homedir(), parentPath.slice(2))
        : parentPath;
  if (!path.isAbsolute(expanded))
    return yield* invalid(
      `parentPath must be an absolute folder on this machine, or start with ~ for its home; got '${parentPath}'.`,
    );
  return path.resolve(expanded);
});

/** What to do about each typed create failure, said after the failure's own words. */
const FIX: Partial<Record<string, string>> = {
  parent_missing:
    "Pass an existing folder as parentPath, or omit parentPath to use this machine's projects folder.",
  permission_denied: "Choose a parentPath this machine's user may write to.",
  refused:
    "It is a protected folder (credentials or the app's own data). Choose another parentPath.",
  name_exhausted: "Choose another title or parentPath.",
};

/** A failed named create as a tool failure that says why and how to fix it. */
export function createFailure(error: ManagedProjectFolders.NamedProjectError) {
  const reason = error._tag === "NamedProjectFolderError" ? error.reason : undefined;
  const fix = reason === undefined ? undefined : FIX[reason];
  return new OrchestratorMcpFailure({
    code: fix === undefined ? "orchestration_error" : "invalid_request",
    message: fix === undefined ? error.message : `${error.message} ${fix}`,
  });
}

/** The project a failed register names as the folder's owner, as an existing project. */
export const conflictingProject = (
  projects: ProjectService.ProjectService["Service"],
  error: ProjectService.ProjectServiceError,
) =>
  error._tag === "ProjectConflictError"
    ? projects.getById(error.conflictingProjectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      )
    : Effect.succeed(undefined);

export interface PublishOutcome {
  readonly published?: ProjectCreatePublished;
  readonly repository?: string;
  readonly publishFailure?: SourceControlPublishFailureReason;
  readonly publishError?: string;
}

/**
 * Publishes the new project as a private GitHub repository with this
 * machine's GitHub sign-in, as the dialog does: `account/<folder>`, or just
 * the folder for `gh` to place under the signed-in user. Never fails: a
 * failed publish keeps the project and says why.
 */
export const publishNewProject = Effect.fn("mcp.projectCreate.publishNewProject")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly github: NonNullable<ProjectCreateToolOptions["github"]>;
  }) {
    const path = yield* Path.Path;
    const folderName = path.basename(input.workspaceRoot);
    const repository =
      typeof input.github === "object" ? `${input.github.account}/${folderName}` : folderName;
    const service = yield* Effect.serviceOption(Repositories.SourceControlRepositoryService);
    if (Option.isNone(service))
      return {
        repository,
        publishError: "This machine cannot publish to GitHub. Publish it from the Git menu.",
      } satisfies PublishOutcome as PublishOutcome;
    return yield* service.value
      .publishRepository({
        cwd: input.workspaceRoot,
        provider: "github",
        repository,
        visibility: "private",
      })
      .pipe(
        Effect.map((result): PublishOutcome => ({
          published: result.status === "pushed" ? "published" : "remote_added",
          repository: result.repository.nameWithOwner,
        })),
        Effect.catch((error) =>
          Effect.succeed<PublishOutcome>({
            repository,
            ...(error.publishFailure === undefined ? {} : { publishFailure: error.publishFailure }),
            publishError: `${error.detail.replace(/[.\s]*$/u, ".")} The project exists; publish it later from the Git menu.`,
          }),
        ),
      );
  },
);

/** Refuses options a create of this shape cannot apply, rather than dropping them. */
export function refuseUnusableOptions(input: {
  readonly kind?: "code" | "personal" | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly parentPath?: string | undefined;
  readonly github?: ProjectCreateToolOptions["github"];
}): OrchestratorMcpFailure | undefined {
  if (input.workspaceRoot !== undefined && input.parentPath !== undefined)
    return invalid(
      "Pass parentPath to make a new project folder in it, or workspaceRoot to register an existing folder, not both.",
    );
  if (input.workspaceRoot !== undefined && input.github !== undefined)
    return invalid(
      "github publishes a new project only. To publish an existing folder, ask the user to use Publish Repository in the Git menu.",
    );
  if (input.kind === "personal" && (input.parentPath !== undefined || input.github !== undefined))
    return invalid(
      "A personal assistant lives in the app's own folder and is never published: omit parentPath and github.",
    );
  return undefined;
}

export type CreatedProject = Project & {
  readonly commitError?: string;
  readonly existing?: boolean;
} & PublishOutcome;
