import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import * as ProjectService from "../project/ProjectService.ts";
import { assertPersonalChatBoundary } from "./personalChatBoundary.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { layer as threadHandlers } from "./toolkits/thread/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";

const aide = ProjectId.make("aide");
const code = ProjectId.make("code");
const other = ProjectId.make("other");
const projects = Layer.mock(ProjectService.ProjectService)({
  getById: (id) =>
    Effect.succeed(
      id === ProjectId.make("missing")
        ? Option.none()
        : Option.some({
            workspaceSettings: { kind: id === aide ? "personal" : "code" },
          } as never),
    ),
});

it.effect("allows own-project workers, external user clients and code-to-code coordination", () =>
  Effect.gen(function* () {
    yield* assertPersonalChatBoundary(aide, aide);
    yield* assertPersonalChatBoundary(undefined, aide);
    yield* assertPersonalChatBoundary(code, other);
  }).pipe(Effect.provide(projects)),
);
it.effect("refuses unsolicited messages in both directions across a personal boundary", () =>
  Effect.gen(function* () {
    const incoming = yield* assertPersonalChatBoundary(code, aide).pipe(Effect.flip);
    expect(incoming.code).toBe("capability_denied");
    const outgoing = yield* assertPersonalChatBoundary(aide, code).pipe(Effect.flip);
    expect(outgoing.message).toContain("studio_project_route");
    const missing = yield* assertPersonalChatBoundary(code, ProjectId.make("missing")).pipe(
      Effect.flip,
    );
    expect(missing.code).toBe("invalid_request");
  }).pipe(Effect.provide(projects)),
);

for (const direction of ["incoming", "outgoing"] as const) {
  it.effect(`refuses ${direction} queued text edits, settlement notes and routine runs`, () => {
    const sourceId = ThreadId.make("source");
    const targetId = ThreadId.make("target");
    const sourceProject = direction === "incoming" ? code : aide;
    const targetProject = direction === "incoming" ? aide : code;
    const shell = (id: ThreadId) => ({
      ...liveThreadShell(id),
      projectId: id === sourceId ? sourceProject : targetProject,
    });
    const services = Layer.mergeAll(
      projects,
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "test",
        issuedAt: 1,
        capabilities: new Set(["orchestration" as const]),
        client: undefined,
        thread: {
          threadId: sourceId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "test",
        },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shell(id)),
        getProjectThreadRecords: (() =>
          Effect.succeed({
            thread: shell(targetId),
            messages: [],
            runs: [],
          })) as never,
        dispatch: () => Effect.die("Personal boundary allowed a thread mutation"),
      }),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({
        list: () =>
          Effect.succeed({
            tasks: [
              {
                id: ScheduledTaskId.make("routine"),
                projectId: targetProject,
              } as never,
            ],
          }),
        runNow: () => Effect.die("Personal boundary allowed a routine run"),
      }),
    );
    return Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(threadHandlers)),
      );
      const results = [
        yield* toolkit
          .handle("studio_queue_edit", {
            threadId: targetId,
            queuedRunId: RunId.make("queued"),
            text: "Unrequested project report",
          })
          .pipe(Stream.unwrap, Stream.runCollect),
        yield* toolkit
          .handle("studio_thread_organize", {
            threadId: targetId,
            action: "settle",
            note: "Unrequested project report",
          })
          .pipe(Stream.unwrap, Stream.runCollect),
        yield* toolkit
          .handle("run_scheduled_task_now", { taskId: ScheduledTaskId.make("routine") })
          .pipe(Stream.unwrap, Stream.runCollect),
      ];
      for (const result of results) {
        expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }
    }).pipe(Effect.provide(services));
  });
}
