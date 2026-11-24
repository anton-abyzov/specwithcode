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
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { layer as handlers } from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const cases = [
  {
    name: "code caller cannot merge a personal fork into Percy",
    caller: "code",
    parent: "aide",
    source: "aide",
    denied: true,
  },
  {
    name: "Percy cannot merge a code fork into its project",
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
    name: "Percy cannot import a code source into Percy",
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

it.effect(
  "blocks code threads and remote coordinators from reading personal assistant threads",
  () => {
    const codeCallerId = ThreadId.make("code-caller");
    const personalThreadId = ThreadId.make("personal-thread");
    const codeThreadId = ThreadId.make("code-thread");
    const personalShell = {
      ...liveThreadShell(personalThreadId),
      projectId: ProjectId.make("aide"),
    };
    const codeShell = { ...liveThreadShell(codeThreadId), projectId: ProjectId.make("code") };
    const codeCallerShell = { ...liveThreadShell(codeCallerId), projectId: ProjectId.make("code") };
    const byId = new Map([
      [codeCallerId, codeCallerShell],
      [personalThreadId, personalShell],
      [codeThreadId, codeShell],
    ]);
    const baseServices = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some({
              workspaceSettings: { kind: id === "aide" ? "personal" : "code" },
            } as never),
          ),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(byId.get(id) ?? null),
      }),
      Layer.mock(ThreadSearch.ThreadSearch)({
        search: () =>
          Effect.succeed({
            matches: [
              {
                threadId: personalThreadId,
                projectId: ProjectId.make("aide"),
                title: "Personal secret",
                source: "user" as const,
                snippet: "secret",
                messageCreatedAt: "2026-11-23T00:00:00.000Z",
              },
              {
                threadId: codeThreadId,
                projectId: ProjectId.make("code"),
                title: "Code task",
                source: "user" as const,
                snippet: "task",
                messageCreatedAt: "2026-11-23T00:00:00.000Z",
              },
            ],
            truncated: false,
          } as never),
      }),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    );
    const runWith = (scope: McpInvocationContext.McpInvocationScope) =>
      Effect.gen(function* () {
        const toolkit = yield* ThreadToolkit.pipe(
          Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
        );
        const search = yield* toolkit
          .handle("studio_thread_search", { query: "secret" })
          .pipe(Stream.unwrap, Stream.runCollect);
        const cfg = yield* toolkit
          .handle("studio_thread_configuration", { threadId: personalThreadId })
          .pipe(Stream.unwrap, Stream.runCollect);
        const queue = yield* toolkit
          .handle("studio_queue_list", { threadId: personalThreadId })
          .pipe(Stream.unwrap, Stream.runCollect);
        const pending = yield* toolkit
          .handle("studio_pending_request_list", { threadId: personalThreadId })
          .pipe(Stream.unwrap, Stream.runCollect);
        return {
          search: search.at(-1)?.result,
          cfg: cfg.at(-1)?.result,
          queue: queue.at(-1)?.result,
          pending: pending.at(-1)?.result,
        };
      }).pipe(
        Effect.provide(
          Layer.merge(
            baseServices,
            Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
          ),
        ),
      );
    return Effect.gen(function* () {
      const asCode = yield* runWith({
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "test",
        issuedAt: 1,
        capabilities: new Set(["orchestration" as const]),
        client: undefined,
        thread: {
          threadId: codeCallerId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "test",
        },
      });
      expect(asCode.search).toMatchObject({ matches: [{ threadId: codeThreadId }] });
      expect(asCode.cfg).toMatchObject({ code: "capability_denied" });
      expect(asCode.queue).toMatchObject({ code: "capability_denied" });
      expect(asCode.pending).toMatchObject({ code: "capability_denied" });

      const asRemoteCoordinator = yield* runWith({
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "test",
        issuedAt: 1,
        capabilities: new Set(["orchestration" as const]),
        client: {
          sessionId: "peer-coord",
          label: "Peer",
          access: "read-only",
          principal: { kind: "coordinator", environmentId: EnvironmentId.make("peer") },
        },
        thread: undefined,
      });
      expect(asRemoteCoordinator.search).toMatchObject({ matches: [{ threadId: codeThreadId }] });
      expect(asRemoteCoordinator.cfg).toMatchObject({ code: "outside_grant_scope" });
      expect(asRemoteCoordinator.queue).toMatchObject({ code: "outside_grant_scope" });
      expect(asRemoteCoordinator.pending).toMatchObject({ code: "outside_grant_scope" });
    });
  },
);
