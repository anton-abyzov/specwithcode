import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { layer as handlers } from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const cases = [
  {
    name: "code caller cannot merge a personal fork into Aide",
    caller: "code",
    parent: "aide",
    source: "aide",
    denied: true,
  },
  {
    name: "Aide cannot merge a code fork into its project",
    caller: "aide",
    parent: "code",
    source: "code",
    denied: true,
  },
  {
    name: "code caller cannot import a personal source into code",
    caller: "code",
    parent: "code",
    source: "aide",
    denied: true,
  },
  {
    name: "Aide cannot import a code source into Aide",
    caller: "aide",
    parent: "aide",
    source: "code",
    denied: true,
  },
  {
    name: "same personal project can merge its own fork",
    caller: "aide",
    parent: "aide",
    source: "aide",
    denied: false,
  },
  {
    name: "same code project can merge its own fork",
    caller: "code",
    parent: "code",
    source: "code",
    denied: false,
  },
  {
    name: "code-to-code coordination remains available",
    caller: "other",
    parent: "code",
    source: "code",
    denied: false,
  },
  {
    name: "external client can merge a personal fork",
    caller: undefined,
    parent: "aide",
    source: "aide",
    denied: false,
  },
];
for (const testCase of cases) {
  it.effect(testCase.name, () => {
    const callerId = ThreadId.make("caller");
    const parentId = ThreadId.make("parent");
    const forkId = ThreadId.make("fork");
    const shell = (id: ThreadId) => ({
      ...liveThreadShell(id),
      ...(testCase.caller === undefined ? { runtimeMode: "approval-required" as const } : {}),
      projectId: ProjectId.make(
        id === callerId ? testCase.caller! : id === parentId ? testCase.parent : testCase.source,
      ),
      ...(id === forkId ? { parentThreadId: parentId, relationshipToParent: "fork" as const } : {}),
    });
    const dispatched: unknown[] = [];
    const services = Layer.mergeAll(
      NodeCrypto.layer,
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
          testCase.caller === undefined
            ? undefined
            : {
                threadId: callerId,
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: "test",
              },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shell(id)),
        getProjectThreadRecords: ((input: { threadId: ThreadId }) =>
          Effect.succeed({ thread: shell(input.threadId), messages: [], runs: [] })) as never,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1 } as never;
          }),
      }),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    );
    return Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
      );
      const output = yield* toolkit
        .handle("studio_thread_merge_back", {
          sourceThreadId: forkId,
          targetThreadId: parentId,
          sourcePoint: { type: "latest_stable" },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const result = Array.from(output).at(-1)?.result;
      if (testCase.denied) {
        expect(result).toMatchObject({ code: "capability_denied" });
        expect(dispatched).toEqual([]);
      } else {
        expect(result).toMatchObject({ sequence: 1, targetThreadId: parentId });
        expect(dispatched).toMatchObject([
          { type: "thread.merge_back", sourceThreadId: forkId, targetThreadId: parentId },
        ]);
      }
    }).pipe(Effect.provide(services));
  });
}
