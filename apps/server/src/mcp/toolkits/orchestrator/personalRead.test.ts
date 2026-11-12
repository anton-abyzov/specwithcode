import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { PERSONAL_READ_REFUSAL } from "../../personalChatBoundary.ts";
import { layer as handlers } from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

// The service read is past the boundary; it answers with a marker failure.
const REACHED = "read reached the thread";

const read = (caller: "aide" | "code" | undefined, target: "aide" | "code") => {
  const callerId = ThreadId.make(`caller-${caller ?? "client"}`);
  const targetId = ThreadId.make(`${target}-thread`);
  const shell = (id: ThreadId) => ({
    ...liveThreadShell(id),
    ...(caller === undefined ? { runtimeMode: "approval-required" as const } : {}),
    projectId: ProjectId.make(id === callerId ? caller! : target),
  });
  const services = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          Option.some({
            workspaceSettings: { kind: id === "aide" ? "personal" : "code" },
          } as never),
        ),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "test",
      issuedAt: 1,
      capabilities: new Set(["orchestration" as const]),
      client: undefined,
      thread:
        caller === undefined
          ? undefined
          : {
              threadId: callerId,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "test",
            },
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shell(id)),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      readThread: () =>
        Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: REACHED })),
    }),
  );
  return Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
    );
    const output = yield* toolkit
      .handle("studio_thread_read", { threadId: targetId })
      .pipe(Stream.unwrap, Stream.runCollect);
    return Array.from(output).at(-1)?.result;
  }).pipe(Effect.provide(services));
};

it.effect("refuses another project's agent the assistant's thread", () =>
  Effect.gen(function* () {
    expect(yield* read("code", "aide")).toMatchObject({
      code: "capability_denied",
      message: PERSONAL_READ_REFUSAL,
    });
  }),
);
it.effect.each([
  ["the assistant reads its own thread", "aide", "aide"],
  ["the assistant reads a code project's thread", "aide", "code"],
  ["a thread-less client reads the assistant's thread", undefined, "aide"],
  ["code projects read each other's threads", "code", "code"],
] as const)("%s", ([, caller, target]) =>
  Effect.gen(function* () {
    expect(yield* read(caller, target)).toMatchObject({ message: REACHED });
  }),
);
