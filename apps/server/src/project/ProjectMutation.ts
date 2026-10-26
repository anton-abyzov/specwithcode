import { type ProjectMutation } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectFolderService } from "./ProjectFolderChange.ts";
import { ProjectFolderChangeError, type ProjectService } from "./ProjectService.ts";

type ProjectMutations = Pick<
  ProjectService["Service"],
  "create" | "delete" | "update" | "getById"
> & {
  /** Absent where the folder service cannot run, such as the offline CLI. */
  readonly changeFolder?: ProjectFolderService["Service"]["change"];
};

/** The same folder, ignoring surrounding spaces and trailing separators. */
function sameRoot(left: string, right: string): boolean {
  const trim = (root: string) => {
    const trimmed = root.trim();
    const stripped = trimmed.replace(/[\\/]+$/, "");
    return stripped === "" ? trimmed : stripped;
  };
  return trim(left) === trim(right);
}

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
  /** The temporary agent session making the call, if any; see TemporaryProjects. */
  temporarySessionId?: string,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        ...(temporarySessionId === undefined ? {} : { temporarySessionId }),
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        ...(mutation.kind === undefined ? {} : { kind: mutation.kind }),
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
        ...(mutation.origin === undefined ? {} : { origin: mutation.origin }),
      });

    case "project.update": {
      // Which list a project sits in and how loudly it alerts are the person's
      // choices; a temporary agent token cannot change either.
      const workspaceSettings =
        temporarySessionId === undefined || mutation.workspaceSettings === undefined
          ? mutation.workspaceSettings
          : (({ origin: _origin, notifications: _notifications, ...rest }) => rest)(
              mutation.workspaceSettings,
            );
      // Moving the folder keeps threads in place, confirms a different repository or
      // planning root, and relocates sessions; a plain update would skip all of that.
      // The same folder is a no-op and stays allowed for older clients that send it, so
      // the root is never passed on; an unknown project still fails as not found below.
      if (mutation.workspaceRoot !== undefined) {
        const current = yield* projects.getById(mutation.projectId);
        if (
          Option.isSome(current) &&
          !sameRoot(current.value.workspaceRoot, mutation.workspaceRoot)
        )
          return yield* new ProjectFolderChangeError({
            projectId: mutation.projectId,
            reason: "use_folder_change",
            detail:
              "Nothing changed: a project update cannot move the project folder. Use Project settings > General > Project folder, or `project move` in the CLI. It checks the folder first and keeps running threads where they are.",
          });
      }
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(workspaceSettings === undefined ? {} : { workspaceSettings }),
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });
    }

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.confirmationTitle === undefined
          ? {}
          : { confirmationTitle: mutation.confirmationTitle }),
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });

    case "project.folder.change": {
      if (projects.changeFolder === undefined)
        return yield* new ProjectFolderChangeError({
          projectId: mutation.projectId,
          reason: "folder_missing",
          detail: "Start SpecWithCode to change a project's folder.",
        });
      const changed = yield* projects.changeFolder({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.confirmDifferentRepository === undefined
          ? {}
          : { confirmDifferentRepository: mutation.confirmDifferentRepository }),
        ...(mutation.confirmPlanningImpact === undefined
          ? {}
          : { confirmPlanningImpact: mutation.confirmPlanningImpact }),
      });
      return changed.project;
    }
  }
});
