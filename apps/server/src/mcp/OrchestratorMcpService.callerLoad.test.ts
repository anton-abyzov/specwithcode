import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("project-caller-load");
const threadId = ThreadId.make("thread-caller-load");
const otherThreadId = ThreadId.make("thread-caller-load-other");
const runId = RunId.make("run-caller-load");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-11-14T12:00:00.000Z");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-caller-load"),
  requestNamespace: "provider-session-caller-load",
  thread: {
    threadId,
    providerSessionId: "provider-session-caller-load",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const thread = (id: ThreadId) => ({
  id,
  projectId,
  title: "Caller",
  createdBy: "user",
  creationSource: "web",
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  archivedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});

/** A long coordinator thread: many messages, turn items and provider turns. */
const callerProjection = {
  thread: thread(threadId),
  runs: [
    {
      id: runId,
      ordinal: 1,
      status: "running",
      rootNodeId: NodeId.make("node-caller-load"),
      modelSelection: { instanceId, model: "gpt-5.4" },
      providerInstanceId: instanceId,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
    },
  ],
  messages: Array.from({ length: 2_000 }, (_, index) => ({
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text: "hello",
  })),
  turnItems: Array.from({ length: 10_000 }, (_, index) => ({
    id: TurnItemId.make(`item-${index}`),
    type: index % 3 === 0 ? "assistant_message" : "command_execution",
  })),
  providerTurns: Array.from({ length: 500 }, (_, index) => ({ id: `provider-turn-${index}` })),
  runtimeRequests: Array.from({ length: 100 }, (_, index) => ({
    id: RuntimeRequestId.make(`request-${index}`),
    status: "resolved",
  })),
  providerThreads: Array.from({ length: 20 }, (_, index) => ({ id: `provider-thread-${index}` })),
  contextTransfers: Array.from({ length: 50 }, (_, index) => ({ id: `transfer-${index}` })),
  subagents: Array.from({ length: 50 }, (_, index) => ({ id: `task-${index}` })),
} as unknown as OrchestrationV2ThreadProjection;

const otherProjection = {
  ...callerProjection,
  thread: thread(otherThreadId),
} as unknown as OrchestrationV2ThreadProjection;

interface CallerRead {
  readonly fields: ReadonlyArray<ProjectionRecordField>;
  readonly rows: number;
}

/** Rows the store would return for a read of the caller's thread, honouring the filter. */
const rowsFor = (
  fields: ReadonlyArray<ProjectionRecordField>,
  filter: ProjectionRecordFilter | undefined,
) =>
  fields.reduce((total, field) => {
    const records = (callerProjection as unknown as Record<string, ReadonlyArray<unknown>>)[
      field
    ];
    if (records === undefined) return total;
    const kept = records.filter((record) => {
      const row = record as { readonly role?: string; readonly type?: string };
      if (field === "messages" && filter?.messageRoles !== undefined)
        return filter.messageRoles.includes(row.role as never);
      if (field === "turnItems" && filter?.turnItemTypes !== undefined)
        return filter.turnItemTypes.includes(row.type as never);
      return true;
    });
    return total + kept.length;
  }, 0);

const harness = (reads: Array<CallerRead>) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id, fields, filter) => {
            if (id === threadId) reads.push({ fields, rows: rowsFor(fields, filter) });
            const source = id === threadId ? callerProjection : otherProjection;
            return Effect.succeed(
              Object.fromEntries([
                ["thread", source.thread],
                ...fields.map((field) => [
                  field,
                  field === "turnItems" && filter?.turnItemTypes !== undefined
                    ? source.turnItems.filter((item) =>
                        filter.turnItemTypes!.includes(item.type),
                      )
                    : source[field],
                ]),
              ]) as never,
            );
          },
          getThreadShell: (id) =>
            Effect.succeed(
              (id === threadId ? callerProjection : otherProjection)
                .thread as unknown as OrchestrationV2ThreadShell,
            ),
          getProjectThreadRecords: (input) =>
            Effect.succeed(input.threadId === threadId ? callerProjection : otherProjection),
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          interruptThread: () => Effect.succeed({ type: "no_active_run" } as never),
          waitForThread: () => Effect.succeed({ run: null, timedOut: false } as never),
          dispatch: () => Effect.succeed({} as never),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        }),
        NodeCrypto.layer,
      ),
    ),
  );

/** Kinds a caller read must not fetch for these tools. */
const HEAVY_KINDS: ReadonlyArray<ProjectionRecordField> = [
  "messages",
  "turnItems",
  "providerTurns",
  "runtimeRequests",
  "providerThreads",
];

const calls: ReadonlyArray<
  readonly [
    string,
    (
      service: OrchestratorMcpService.OrchestratorMcpService["Service"],
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>,
    ReadonlyArray<ProjectionRecordField>,
  ]
> = [
  ["orchestrator_capabilities", (service) => service.capabilities(scope), []],
  ["studio_list_scheduled_tasks", (service) => service.listScheduledTasks(scope, {}), []],
  [
    "studio_thread_read (another thread)",
    (service) => service.readThread(scope, { threadId: otherThreadId }),
    [],
  ],
  [
    "studio_thread_wait (own thread)",
    (service) => service.waitForThread(scope, { threadId, timeoutMs: 1 }),
    [],
  ],
  [
    "studio_thread_interrupt (another thread)",
    (service) => service.interruptThread(scope, { threadId: otherThreadId }),
    [],
  ],
  [
    "ask_user",
    (service) =>
      service.askUser(scope, {
        questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }],
      } as never),
    // ask_user reads the caller's requests to find a retried card.
    ["runtimeRequests"],
  ],
];

describe("caller load", () => {
  it.each(calls)("%s loads only the record kinds it uses", async (name, call, needs) => {
    const reads: Array<CallerRead> = [];
    await Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      yield* call(service);
    }).pipe(Effect.provide(harness(reads)), Effect.runPromise);
    const kinds = [...new Set(reads.flatMap((read) => read.fields))].toSorted();
    // At most the caller's run, plus the kinds this tool reads (one request row per card).
    expect(reads.reduce((total, read) => total + read.rows, 0), name).toBeLessThanOrEqual(
      1 + (needs.includes("runtimeRequests") ? 100 : 0),
    );
    expect(
      kinds.filter((kind) => HEAVY_KINDS.includes(kind) && !needs.includes(kind)),
    ).toEqual([]);
  });
});
