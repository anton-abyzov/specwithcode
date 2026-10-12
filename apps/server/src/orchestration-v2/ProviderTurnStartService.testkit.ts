import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as StudioCapacity from "../studio/Capacity.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectStore from "./ProjectStore.ts";

export const layer = Layer.mergeAll(
  Layer.mock(StudioCapacity.Capacity)({ assertNativeStart: () => Effect.void }),
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.unwrap(
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      return Layer.mock(ProjectService.ProjectService)({
        getById: (projectId, options) =>
          projects.get(projectId, options).pipe(
            Effect.map(
              Option.map(({ projectId: id, workspaceSettings, ...row }) => ({
                ...row,
                id,
                repositoryIdentity: null,
                ...(workspaceSettings ? { workspaceSettings } : {}),
              })),
            ),
            Effect.mapError(
              (cause) =>
                new ProjectService.ProjectOperationError({
                  operation: "read-project",
                  projectId,
                  cause,
                }),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(ProjectStore.layer)),
);
