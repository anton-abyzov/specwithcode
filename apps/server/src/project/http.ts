import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProjectFolderCheckError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { ProjectFolderService } from "./ProjectFolderChange.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectMutationOperation } from "./ProjectMutation.ts";

export const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause:
    | ProjectService.ProjectServiceError
    | ProjectFolderCheckError
    | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (cause._tag === "ProjectRequestDeniedError") {
    const reason = {
      settings_conflict: "project_settings_conflict",
      confirmation_required: "project_confirmation_required",
      active_work: "project_active_work",
      environment_active: "project_environment_active",
    } as const;
    return yield* failEnvironmentInvalidRequest(reason[cause.reason]);
  }
  if (cause._tag === "ProjectEnvironmentError")
    return yield* failEnvironmentInvalidRequest("project_environment_invalid");
  if (cause._tag === "ProjectFolderChangeError" || cause._tag === "ProjectFolderCheckError")
    return yield* failEnvironmentInvalidRequest("project_folder_change_refused");
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    const folders = yield* ProjectFolderService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projects.snapshot.pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const operation = projectMutationOperation(
            { ...projects, changeFolder: folders.change },
            args.payload,
          );
          return yield* startup
            .enqueueCommand(operation)
            .pipe(traceLocalHandlerWork, Effect.catch(failProjectMutation));
        }),
      );
  }),
);
