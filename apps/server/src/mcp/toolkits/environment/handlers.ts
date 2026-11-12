import { OrchestratorMcpFailure, type ServerSettings } from "@specweave-studio/contracts";
import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import {
  availableRepositories,
  discoverProjectRepositories,
} from "../../../project/ProjectRepositoryDiscovery.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
/** The name agents are given for this machine: the owner's name for it, else its host name. */
export function machineLabel(
  descriptor: { readonly environmentId: string; readonly label: string },
  settings: Pick<ServerSettings, "machineNicknames">,
) {
  const name = normalizeMachineNickname(
    settings.machineNicknames[descriptor.environmentId]?.name ?? "",
  );
  return name === "" ? descriptor.label : name;
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
/**
 * The repositories found in the calling thread's project folder, so an agent
 * sees what it can name without scanning. Null for a caller with no thread or
 * project, and where the project service is not part of this server.
 */
const callerRepositories = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  if (scope.thread === undefined || Option.isNone(projects)) return null;
  const management = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* management
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.projectId === null) return null;
  const project = yield* projects.value.getById(shell.projectId).pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  if (project === null) return null;
  const discovery = yield* Effect.promise(() =>
    discoverProjectRepositories({
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      saved: project.workspaceSettings?.environment?.repositories,
    }),
  );
  const found = availableRepositories(discovery);
  if (found.length === 0) return null;
  return {
    projectFolder: project.workspaceRoot,
    found: found.map(({ name, relativePath, origin, branch }) => ({
      name,
      relativePath,
      origin,
      branch,
    })),
    more: discovery?.foundMore ?? 0,
    note: "Name a repository by relativePath in a launch's repository or repositories, or in studio_worktree_add_repository. Nothing needs registering.",
  };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  studio_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const repositories = yield* callerRepositories;
      return {
        ...(repositories === null ? {} : { repositories }),
        environmentId: descriptor.environmentId,
        label: machineLabel(descriptor, current),
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  studio_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      // A thread caller serializes with its own turn; a client has no thread to lock.
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
