// A project's coordinator delegates hands-on work: preview, preview controls,
// Chrome, computer and device tools refuse it, and a worker in the same
// project keeps them.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BrowserExtension from "../browserExtension/BrowserExtension.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import * as Preview from "../preview/Manager.ts";
import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ChromeHandlers from "./toolkits/chrome/handlers.ts";
import { ChromeStandardToolkit } from "./toolkits/chrome/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";

// liveThreadShell puts every thread in this project.
const projectId = ProjectId.make("project:mcp-test");
const coordinatorId = ThreadId.make("thread:coordinator");
const workerId = ThreadId.make("thread:worker");

const scopeOf = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:mcp-coordinator"),
  requestNamespace: `session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
});

const projectsLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (id) =>
    Effect.succeedSome(
      projectFixture(id, {
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          coordinatorThreadId: id === projectId ? coordinatorId : null,
        },
      }),
    ),
});

it.effect("a coordinator is refused a preview tool; a worker uses it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-coordinator-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const dependencies = Layer.mergeAll(
        PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(Preview.PreviewManager, manager),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            enableAgentBrowserAccess: true,
          }),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(Layer.merge(dependencies, projectsLayer)),
          ),
        ),
      );
      const list = (threadId: ThreadId) =>
        toolkit
          .handle("studio_preview_list", {})
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provide(dependencies),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId)),
          );

      const refused = (yield* list(coordinatorId)).at(-1)?.result;
      assert.deepInclude(refused, {
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
        message: McpToolAccess.COORDINATOR_HANDS_ON_REFUSAL,
      });
      const listed = (yield* list(workerId)).at(-1)?.result;
      assert.deepInclude(listed, { sessions: [], nextCursor: null });
    }),
  ),
);

it.effect("a coordinator is refused a Chrome tool; a worker gets past the check", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      McpToolAccessTestkit.liveThreadsLayer,
      // Never reached for the coordinator; the worker's call may fail on it.
      Layer.succeed(
        BrowserExtension.BrowserExtension,
        {} as BrowserExtension.BrowserExtension["Service"],
      ),
      Layer.mock(RemoteWorkers.RemoteWorkers)({ enabled: false }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    );
    const toolkit = yield* ChromeStandardToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ChromeHandlers.layerStandard).pipe(
          Layer.provide(projectsLayer),
        ),
      ),
    );
    const profiles = (threadId: ThreadId) =>
      toolkit
        .handle("chrome_profiles", {})
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(dependencies),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId)),
          Effect.exit,
        );

    const coordinator = yield* profiles(coordinatorId);
    assert.isTrue(coordinator._tag === "Failure");
    assert.include(String(coordinator), McpToolAccess.COORDINATOR_HANDS_ON_REFUSAL);
    // The worker reaches the Chrome handler, whatever the unpaired mock answers.
    const worker = yield* profiles(workerId);
    assert.notInclude(String(worker), McpToolAccess.COORDINATOR_HANDS_ON_REFUSAL);
  }),
);
