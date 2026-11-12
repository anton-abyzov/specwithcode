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
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import { PERSONAL_READ_REFUSAL } from "../../personalChatBoundary.ts";
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

// The personal assistant's chats stay private to it: an agent thread in
// another project may not read or search them; the assistant, its workers and
// a thread-less user-approved client may, and the assistant reads projects.
const readCase = (caller: "aide" | "code" | undefined) => {
  const callerId = ThreadId.make(`caller-${caller ?? "client"}`);
  const shell = (id: ThreadId) => ({
    ...liveThreadShell(id),
    ...(caller === undefined ? { runtimeMode: "approval-required" as const } : {}),
    projectId: ProjectId.make(
      id === callerId ? caller! : String(id).startsWith("aide") ? "aide" : "code",
    ),
  });
  return Layer.mergeAll(
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
      getProjectThreadRecords: ((input: { threadId: ThreadId }) =>
        Effect.succeed({
          thread: shell(input.threadId),
          messages: [],
          runs: [],
          runtimeRequests: [],
          turnItems: [],
          contextTransfers: [],
        })) as never,
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({
      search: () =>
        Effect.succeed({
          matches: (["aide", "code"] as const).map((project) => ({
            threadId: ThreadId.make(`${project}-match`),
            projectId: ProjectId.make(project),
            source: "user" as const,
            snippet: project,
            messageCreatedAt: null,
          })),
        }),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  );
};
const runReads = (caller: "aide" | "code" | undefined, target: string) =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
    );
    const threadId = ThreadId.make(target);
    const last = (output: Iterable<{ readonly result: unknown }>) =>
      Array.from(output).at(-1)?.result;
    return {
      transfers: last(
        yield* toolkit
          .handle("studio_thread_transfers", { threadId })
          .pipe(Stream.unwrap, Stream.runCollect),
      ),
      configuration: last(
        yield* toolkit
          .handle("studio_thread_configuration", { threadId })
          .pipe(Stream.unwrap, Stream.runCollect),
      ),
      pending: last(
        yield* toolkit
          .handle("studio_pending_request_list", { threadId })
          .pipe(Stream.unwrap, Stream.runCollect),
      ),
      queue: last(
        yield* toolkit
          .handle("studio_queue_list", { threadId })
          .pipe(Stream.unwrap, Stream.runCollect),
      ),
    };
  }).pipe(Effect.provide(readCase(caller)));
const search = (caller: "aide" | "code" | undefined, projectId?: string) =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
    );
    const output = yield* toolkit
      .handle("studio_thread_search", {
        query: "report",
        ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    return Array.from(output).at(-1)?.result as unknown;
  }).pipe(Effect.provide(readCase(caller)));

it.effect("refuses another project's agent the assistant's thread reads", () =>
  Effect.gen(function* () {
    const results = yield* runReads("code", "aide-thread");
    for (const result of Object.values(results))
      expect(result).toMatchObject({
        code: "capability_denied",
        message: PERSONAL_READ_REFUSAL,
      });
  }),
);
it.effect.each([
  ["the assistant reads its own thread", "aide", "aide-thread"],
  ["a thread-less client reads the assistant's thread", undefined, "aide-thread"],
  ["the assistant reads a code project's thread", "aide", "code-thread"],
] as const)("%s", ([, caller, target]) =>
  Effect.gen(function* () {
    const results = yield* runReads(caller, target);
    for (const result of Object.values(results))
      expect(result).not.toMatchObject({ code: "capability_denied" });
    expect(results.configuration).toMatchObject({ threadId: target });
  }),
);
it.effect("refuses another project's agent a search of the assistant's project", () =>
  Effect.gen(function* () {
    expect(yield* search("code", "aide")).toMatchObject({
      code: "capability_denied",
      message: PERSONAL_READ_REFUSAL,
    });
    // An omitted project is the caller's own, which holds no assistant chats.
    expect(yield* search("code")).toEqual({
      matches: [expect.objectContaining({ projectId: "code" })],
    });
    expect(yield* search("aide")).toEqual({
      matches: [expect.objectContaining({ projectId: "aide" })],
    });
    expect(yield* search("aide", "code")).toEqual({
      matches: [expect.objectContaining({ projectId: "code" })],
    });
    // A thread-less client keeps searching every project.
    expect(((yield* search(undefined)) as { matches: unknown[] }).matches).toHaveLength(2);
  }),
);
