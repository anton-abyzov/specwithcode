import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { layer as handlers } from "./handlers.ts";
import { AttachmentToolkit } from "./tools.ts";

for (const direction of ["into", "out of"] as const) {
  it.effect(`refuses attachments ${direction} Aide before claiming files or sending`, () => {
    const callerId = ThreadId.make("source");
    const targetId = ThreadId.make("target");
    const sourceProject = ProjectId.make("source-project");
    const targetProject = ProjectId.make("target-project");
    const shell = (id: ThreadId) => ({
      ...liveThreadShell(id),
      projectId: id === callerId ? sourceProject : targetProject,
    });
    const services = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "test",
        issuedAt: 1,
        capabilities: new Set(["orchestration" as const]),
        client: undefined,
        thread: {
          threadId: callerId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "test",
        },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shell(id)),
        getProjectThreadRecords: (() =>
          Effect.succeed({ thread: shell(targetId), messages: [] })) as never,
        sendToThread: () => Effect.die("Refused attachment reached sendToThread"),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some({
              workspaceSettings: {
                kind:
                  id === (direction === "into" ? targetProject : sourceProject)
                    ? "personal"
                    : "code",
              },
            } as never),
          ),
      }),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "aide-attachments-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    return Effect.gen(function* () {
      const toolkit = yield* AttachmentToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
      );
      const output = yield* toolkit
        .handle("studio_thread_send_attachments", {
          threadId: targetId,
          message: "Project report",
          attachments: [
            {
              id: "pending-aide-test",
              type: "image",
              name: "report.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const result = Array.from(output).at(-1)?.result as { code?: string; message?: string };
      expect(result.code).toBe("capability_denied");
      expect(result.message).toContain(
        direction === "into" ? "cannot send messages into" : "studio_project_route",
      );
    }).pipe(Effect.provide(services));
  });
}
