import { type ProjectMutation } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { ProjectFolderService } from "./ProjectFolderChange.ts";
import { ProjectFolderChangeError, type ProjectService } from "./ProjectService.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update"> & {
  /** Absent where the folder service cannot run, such as the offline CLI. */
  readonly changeFolder?: ProjectFolderService["Service"]["change"];
};

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
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.workspaceSettings === undefined
          ? {}
          : { workspaceSettings: mutation.workspaceSettings }),
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
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
