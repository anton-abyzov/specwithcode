/**
 * The words for why a new project could not be made, shared by the server's
 * error message (what an older client shows) and its typed reason.
 *
 * @module namedProjectFailure
 */
import type { GitCommandError, ProjectCreateFailureReason } from "@specweave-studio/contracts";
import type * as PlatformError from "effect/PlatformError";

import { GIT_SPAWN_FAILURE_DETAIL } from "../vcs/GitVcsDriverCore.ts";

/** Says why, naming the folder; "this machine" is the server's own. */
export function namedProjectFailureMessage(input: {
  readonly reason: ProjectCreateFailureReason;
  readonly folder: string;
  readonly detail?: string;
}): string {
  switch (input.reason) {
    case "parent_missing":
      return `The folder '${input.folder}' does not exist on this machine.`;
    case "permission_denied":
      return `This machine does not allow making a folder in '${input.folder}'.`;
    case "git_missing":
      return `Git is not installed on this machine, so '${input.folder}' could not be made a repository. Install Git, then try again.`;
    case "git_init_failed":
      return `git init failed in '${input.folder}'${input.detail ? `: ${input.detail}` : "."}`;
    case "name_exhausted":
      return `Every folder name for "${input.detail ?? "the project"}" in '${input.folder}' is taken, up to 100. Choose another name or folder.`;
    case "refused":
      return `SpecWithCode does not make folders in '${input.folder}'.`;
  }
}

/** The reason a file system failure gives, when it is one the person can act on. */
export function platformFailureReason(cause: PlatformError.PlatformError): {
  readonly reason?: "parent_missing" | "permission_denied";
} {
  const tag = cause.reason._tag;
  if (tag === "NotFound") return { reason: "parent_missing" };
  if (tag === "PermissionDenied") return { reason: "permission_denied" };
  return {};
}

/**
 * Git could not be started at all: not installed, or not on the server's PATH.
 * The folder it runs in was just made, so a missing working directory is not the cause.
 */
export function isGitSpawnFailure(error: GitCommandError): boolean {
  return error.detail === GIT_SPAWN_FAILURE_DETAIL;
}
