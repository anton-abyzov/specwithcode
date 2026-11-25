import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type Project as ProjectRecord,
  type ServerProvider,
  type TaskRoutingSettings,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TASK_ROUTING_SETTINGS,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** A client-session caller of the project toolkit, with launches recorded instead of run. */
export const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly taskRouting?: Partial<TaskRoutingSettings>;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: modelSelection,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, ...input.taskRouting },
      }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(
        input.providers ?? [
          {
            instanceId: modelSelection.instanceId,
            models: [
              {
                slug: modelSelection.model,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Reasoning",
                      type: "select",
                      options: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
                    },
                  ],
                },
              },
            ],
          } as unknown as ServerProvider,
        ],
      ),
    }),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};
