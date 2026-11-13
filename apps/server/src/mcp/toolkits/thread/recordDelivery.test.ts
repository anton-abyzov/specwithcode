import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
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

const ownerId = ThreadId.make("completion-owner");
const targetId = ThreadId.make("worker");
const proof = {
  status: "verified" as const,
  reference: "https://example.test/pr/1",
  observedAt: "2026-10-26T10:00:00Z",
  scopeRevision: "abc123",
};
const na = { status: "not_applicable" as const, rationale: "Research answer; no code changed" };

const rootId = ThreadId.make("root");

/** `parents` maps a thread to the thread that started it; the caller is the completion owner. */
const invoke = (
  target: ThreadId,
  parents: ReadonlyMap<ThreadId, ThreadId> = new Map(),
  recorded: {
    readonly fileChanges?: ReadonlyArray<{ readonly runId: string; readonly fileName: string }>;
    readonly pullRequests?: ReadonlyArray<unknown>;
    readonly kind?: "code" | "no_code";
  } = {},
) => {
  const dispatched: unknown[] = [];
  const services = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some({ workspaceSettings: { kind: "code" } } as never)),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "test",
      issuedAt: 1,
      capabilities: new Set(["orchestration" as const]),
      client: undefined,
      thread: {
        threadId: ownerId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "test",
      },
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          ...liveThreadShell(id),
          projectId: ProjectId.make("code"),
          ...(parents.has(id)
            ? {
                lineage: {
                  parentThreadId: parents.get(id)!,
                  relationshipToParent: "subagent" as const,
                  rootThreadId: rootId,
                },
              }
            : {}),
        }),
      getProjectThreadRecords: ((
        input: { threadId: ThreadId },
        _fields: unknown,
        filter?: { turnItemTypes?: ReadonlyArray<string>; turnItemRunIds?: ReadonlyArray<string> },
      ) =>
        Effect.succeed({
          thread: {
            ...liveThreadShell(input.threadId),
            projectId: ProjectId.make("code"),
            ...(recorded.pullRequests ? { pullRequests: recorded.pullRequests } : {}),
          },
          messages: [],
          runs: [],
          turnItems: (filter?.turnItemTypes?.includes("file_change")
            ? (recorded.fileChanges ?? [])
            : []
          )
            .filter((item) => filter?.turnItemRunIds?.includes(item.runId) ?? true)
            .map((item) => ({ type: "file_change", ...item })),
        })) as never,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 7 } as never;
        }),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  );
  return Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
    );
    const output = yield* toolkit
      .handle("studio_thread_record_delivery", {
        threadId: target,
        expectedRunId: RunId.make("run:worker:1"),
        kind: recorded.kind ?? "no_code",
        scope: "Answered which releases include the fix",
        scopeRevision: "abc123",
        validUntil: "2026-10-27T10:00:00Z",
        obligations: [],
        push: na,
        merge: na,
        deployment: na,
        deliverable: proof,
        verification: proof,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: Array.from(output).at(-1)?.result, dispatched };
  }).pipe(Effect.provide(services));
};

it.effect("records another thread's delivery with the caller as reporter", () =>
  Effect.gen(function* () {
    const { result, dispatched } = yield* invoke(targetId);
    expect(result).toEqual({ sequence: 7 });
    expect(dispatched).toMatchObject([
      {
        type: "thread.lifecycle-receipt.record",
        threadId: targetId,
        runId: "run:worker:1",
        reportedBy: `thread:${ownerId}`,
        report: { kind: "no_code", scope: "Answered which releases include the fix" },
      },
    ]);
  }),
);

it.effect("refuses a thread vouching for its own delivery", () =>
  Effect.gen(function* () {
    const { result, dispatched } = yield* invoke(ownerId);
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toEqual([]);
  }),
);

it.effect.each([
  { name: "its root", parents: [[ownerId, rootId]] },
  {
    name: "its parent",
    parents: [
      [ownerId, targetId],
      [targetId, rootId],
    ],
  },
  {
    name: "an ancestor further up",
    parents: [
      [ownerId, ThreadId.make("middle")],
      [ThreadId.make("middle"), targetId],
      [targetId, rootId],
    ],
  },
] as const)("refuses a subagent or fork vouching for $name", ({ name, parents }) =>
  Effect.gen(function* () {
    const target = name === "its root" ? rootId : targetId;
    const { result, dispatched } = yield* invoke(target, new Map(parents));
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toEqual([]);
  }),
);

it.effect("lets a sibling under the same root vouch", () =>
  Effect.gen(function* () {
    const { result } = yield* invoke(
      targetId,
      new Map([
        [ownerId, rootId],
        [targetId, rootId],
      ]),
    );
    expect(result).toEqual({ sequence: 7 });
  }),
);

it.effect("refuses no_code for a run that changed files", () =>
  Effect.gen(function* () {
    const { result, dispatched } = yield* invoke(targetId, new Map(), {
      fileChanges: [{ runId: "run:worker:1", fileName: "/repo/src/auth.ts" }],
    });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect((result as { message: string }).message).toContain("/repo/src/auth.ts");
    expect(dispatched).toEqual([]);
  }),
);

it.effect("refuses no_code for a thread with a linked pull request", () =>
  Effect.gen(function* () {
    const { result, dispatched } = yield* invoke(targetId, new Map(), {
      pullRequests: [{ number: 12 }],
    });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toEqual([]);
  }),
);

it.effect("records no_code when only an earlier run changed files", () =>
  Effect.gen(function* () {
    const { result } = yield* invoke(targetId, new Map(), {
      fileChanges: [{ runId: "run:worker:0", fileName: "/repo/old.ts" }],
    });
    expect(result).toEqual({ sequence: 7 });
  }),
);

it.effect("still records kind code for a run that changed files", () =>
  Effect.gen(function* () {
    const { result } = yield* invoke(targetId, new Map(), {
      kind: "code",
      fileChanges: [{ runId: "run:worker:1", fileName: "/repo/src/auth.ts" }],
    });
    expect(result).toEqual({ sequence: 7 });
  }),
);
