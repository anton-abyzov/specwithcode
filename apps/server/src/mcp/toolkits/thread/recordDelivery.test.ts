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

const invoke = (target: ThreadId) => {
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
        Effect.succeed({ ...liveThreadShell(id), projectId: ProjectId.make("code") }),
      getProjectThreadRecords: ((input: { threadId: ThreadId }) =>
        Effect.succeed({
          thread: { ...liveThreadShell(input.threadId), projectId: ProjectId.make("code") },
          messages: [],
          runs: [],
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
        kind: "no_code",
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
