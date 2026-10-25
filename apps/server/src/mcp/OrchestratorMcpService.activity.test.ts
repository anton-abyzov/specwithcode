import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const cancelledRunId = RunId.make("run-mcp-cancelled");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");
// Distinct from driver kind so a regression that re-derives from driver fails.
const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it("readThread prefers activity-run status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("running");
    expect(result.thread.latestRunId).toBe(cancelledRunId);
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread prefers waiting activity status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent waiting",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "waiting" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("waiting");
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("taskStatus returns task.providerInstanceId rather than the driver kind", async () => {
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      makeRun({
        id: childRunId,
        ordinal: 1,
        status: "running",
        instanceId: customCodexInstanceId,
      }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.taskStatus(makeScope(), taskId);
    expect(result.providerInstanceId).toBe(customCodexInstanceId);
    expect(result.providerInstanceId).not.toBe(ProviderInstanceId.make(String(codexDriver)));
    expect(result.status).toBe("running");
    expect(result.taskId).toBe(taskId);
    expect(result.childThreadId).toBe(childThreadId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread and sendToThread reach threads in other projects", async () => {
  let parentRuns: ReadonlyArray<unknown> = [
    makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" }),
  ];
  const foreignProjectId = ProjectId.make("project-mcp-orchestrator-foreign");
  let foreignPaused = false;
  let sourcePersonal = false;
  let targetPersonal = false;
  let sends = 0;
  const foreignThreadId = ThreadId.make("thread-mcp-orchestrator-foreign");
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    get runs() {
      return parentRuns;
    },
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const foreignProjection = (threadId: ThreadId) =>
    ({
      thread: {
        ...baseThread({
          threadId,
          title: "Foreign",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        projectId: foreignProjectId,
      },
      runs: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: threadId,
          sourceItemId: "item-1",
          item: {
            id: "item-1",
            type: "assistant_message",
            messageId: "assistant-1",
            status: "completed",
            title: null,
            text: "Foreign thread said hello",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === foreignThreadId) return Effect.succeed(foreignProjection(threadId));
            return Effect.die(`unexpected thread ${threadId}`);
          },
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === foreignThreadId
                ? (foreignProjection(threadId).thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getTimelinePage: (threadId) =>
            Effect.succeed({
              items: foreignProjection(threadId).visibleTurnItems,
              totalItems: 1,
              hasMore: false,
            }),
          getProjectThreadRecords: (input) =>
            input.threadId === foreignThreadId && input.projectId === foreignProjectId
              ? Effect.succeed(foreignProjection(input.threadId))
              : Effect.fail(
                  new ThreadManagementService.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                ),
          sendToThread: () => {
            sends += 1;
            return Effect.succeed({
              run: { id: "run-foreign", status: "queued" },
              projection: { runs: [] },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.some({
                workspaceSettings: {
                  paused: id === foreignProjectId && foreignPaused,
                  archived: false,
                  kind: (id === foreignProjectId ? targetPersonal : sourcePersonal)
                    ? "personal"
                    : "code",
                },
              } as never),
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () =>
            Effect.succeed({
              tasks: [
                {
                  id: "task-foreign",
                  projectId: foreignProjectId,
                  threadId: null,
                  webhook: { url: "https://example.invalid/fixture-trigger" },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                } as never,
              ],
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const foreign = yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    expect(foreign.thread.threadId).toBe(foreignThreadId);
    expect(foreign.thread.projectId).toBe(foreignProjectId);
    expect(foreign.items.map((item) => item.text)).toEqual(["Foreign thread said hello"]);

    const sent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "hi",
    });
    expect(sent.threadId).toBe(foreignThreadId);

    // Neither a project worker nor coordinator can push unsolicited text into Aide.
    targetPersonal = true;
    for (const input of [
      { message: "A project worker finished." },
      { forwardMessageId: MessageId.make("old-user-request") },
    ]) {
      const refused = yield* service
        .sendToThread(makeScope(), { threadId: foreignThreadId, ...input })
        .pipe(Effect.flip);
      expect(refused.code).toBe("capability_denied");
      expect(refused.message).toContain("cannot send messages into the personal assistant");
    }
    expect(sends).toBe(1);
    // On-demand report reads remain available; no send or new run is created.
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    targetPersonal = false;
    sourcePersonal = true;
    const bypass = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "Do work" })
      .pipe(Effect.flip);
    expect(bypass.code).toBe("capability_denied");
    expect(bypass.message).toContain("studio_project_route");
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    expect(sends).toBe(1);
    sourcePersonal = false;

    for (const direction of ["incoming", "outgoing"]) {
      targetPersonal = direction === "incoming";
      sourcePersonal = direction === "outgoing";
      const routines = yield* service.listScheduledTasks(makeScope(), {
        projectId: foreignProjectId,
      });
      expect(routines.tasks).toHaveLength(1);
      expect(routines.tasks[0]?.webhookUrl).toBeUndefined();
      const actions: ReadonlyArray<Effect.Effect<void, OrchestratorMcpFailure>> = [
        service.stopAllThreads(makeScope(), { projectId: foreignProjectId }).pipe(Effect.asVoid),
        service
          .continueAllThreads(makeScope(), { projectId: foreignProjectId })
          .pipe(Effect.asVoid),
        service
          .scheduleTask(makeScope(), {
            projectId: foreignProjectId,
            prompt: "Push a project report",
            schedule: { type: "interval", everyMs: 3_600_000 },
            ownThread: true,
          })
          .pipe(Effect.asVoid),
        service
          .updateScheduledTask(makeScope(), {
            scheduledTaskId: ScheduledTaskId.make("task-foreign"),
            prompt: "Replace a personal routine",
          })
          .pipe(Effect.asVoid),
        service
          .deleteScheduledTask(makeScope(), {
            scheduledTaskId: ScheduledTaskId.make("task-foreign"),
          })
          .pipe(Effect.asVoid),
      ];
      for (const action of actions) {
        const refused = yield* action.pipe(Effect.flip);
        expect(refused.code).toBe("capability_denied");
      }
    }
    sourcePersonal = false;
    targetPersonal = false;

    // A paused project's threads take no new agent-sent work until the user resumes it.
    foreignPaused = true;
    const paused = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "keep going" })
      .pipe(Effect.flip);
    expect(paused.code).toBe("invalid_request");
    foreignPaused = false;

    // Once the caller's run ends, it can still read other threads but no longer write to them.
    parentRuns = [];
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    const stale = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "hi again" })
      .pipe(Effect.flip);
    expect(stale.code).toBe("parent_not_active");
    const staleInterrupt = yield* service
      .interruptThread(makeScope(), { threadId: foreignThreadId })
      .pipe(Effect.flip);
    expect(staleInterrupt.code).toBe("parent_not_active");
    // Nor create, change or remove scheduled work in another project.
    const staleSchedule = yield* service
      .scheduleTask(makeScope(), {
        projectId: foreignProjectId,
        prompt: "check in later",
        schedule: { type: "interval", everyMs: 3_600_000 },
      })
      .pipe(Effect.flip);
    expect(staleSchedule.code).toBe("parent_not_active");
    const staleUpdate = yield* service
      .updateScheduledTask(makeScope(), {
        scheduledTaskId: ScheduledTaskId.make("task-foreign"),
        enabled: false,
      })
      .pipe(Effect.flip);
    expect(staleUpdate.code).toBe("parent_not_active");
    const staleDelete = yield* service
      .deleteScheduledTask(makeScope(), { scheduledTaskId: ScheduledTaskId.make("task-foreign") })
      .pipe(Effect.flip);
    expect(staleDelete.code).toBe("parent_not_active");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("sendToThread forwards the user's own words from a worker follow-up", async () => {
  const workerThreadId = ThreadId.make("thread-mcp-orchestrator-worker");
  const followUpId = MessageId.make("coordinator-send:project:command-1");
  const userMessage = (id: string, text: string, createdBy: "user" | "agent") => ({
    id,
    threadId: parentThreadId,
    role: "user",
    text,
    createdBy,
    creationSource: createdBy === "user" ? "web" : "mcp",
    senderThreadId: workerThreadId,
    attachments: [],
    streaming: false,
    runId: null,
    nodeId: null,
    createdAt: now,
    updatedAt: now,
  });
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Coordinator",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [
      userMessage(
        followUpId,
        `User follow-up from selected worker ${workerThreadId}, message ${followUpId}. Review that thread and decide whether to reuse it or route elsewhere.\n\nrlease and push all!`,
        "user",
      ),
      userMessage("agent-report", "Worker finished", "agent"),
    ],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const workerProjection = {
    ...parentProjection,
    thread: baseThread({
      threadId: workerThreadId,
      title: "Release macOS app",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(parentProjection)
              : threadId === workerThreadId
                ? Effect.succeed(workerProjection)
                : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === workerThreadId
                ? (workerProjection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: () => Effect.succeed(workerProjection),
          sendToThread: (input) => {
            sent.push(input);
            return Effect.succeed({
              run: { id: "run-worker", status: "queued" },
              projection: { runs: [] },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    yield* service.sendToThread(makeScope(), {
      threadId: workerThreadId,
      forwardMessageId: followUpId,
    });
    // A retry without a clientRequestId lands on the same message.
    yield* service.sendToThread(makeScope(), {
      threadId: workerThreadId,
      forwardMessageId: followUpId,
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      threadId: workerThreadId,
      text: "rlease and push all!",
      createdBy: "user",
      senderThreadId: parentThreadId,
    });
    expect(sent[1]!.messageId).toBe(sent[0]!.messageId);

    // Only what the user wrote is forwarded as theirs, and never alongside rewritten text.
    const agentWords = yield* service
      .sendToThread(makeScope(), {
        threadId: workerThreadId,
        forwardMessageId: MessageId.make("agent-report"),
      })
      .pipe(Effect.flip);
    expect(agentWords.code).toBe("invalid_request");
    const both = yield* service
      .sendToThread(makeScope(), {
        threadId: workerThreadId,
        forwardMessageId: followUpId,
        message: "From the user (coordinator relay): release",
      })
      .pipe(Effect.flip);
    expect(both.code).toBe("invalid_request");
    const neither = yield* service
      .sendToThread(makeScope(), { threadId: workerThreadId })
      .pipe(Effect.flip);
    expect(neither.code).toBe("invalid_request");
    expect(sent).toHaveLength(2);

    // A relay that quotes the follow-up back to its thread delivers only the user's words.
    yield* service.sendToThread(makeScope(), {
      threadId: workerThreadId,
      clientRequestId: "relay-1",
      message:
        'User follow-up typed in this thread, relayed by the coordinator: "rlease and push all!"\n\nReply with one line of status.',
    });
    expect(sent[2]).toMatchObject({ text: "rlease and push all!", createdBy: "user" });
    expect(sent[2]!.messageId).toBe(sent[0]!.messageId);
    // A coordinator's own brief that does not quote the user stays the coordinator's.
    yield* service.sendToThread(makeScope(), {
      threadId: workerThreadId,
      message: "Please push all the branches",
    });
    expect(sent[3]).toMatchObject({ text: "Please push all the branches", createdBy: "agent" });
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("scheduleTask gives a coordinator's routines their own thread and binds a worker's", async () => {
  const workerThreadId = ThreadId.make("thread-mcp-orchestrator-worker");
  const projectionFor = (threadId: ThreadId) =>
    ({
      thread: baseThread({
        threadId,
        title: threadId === parentThreadId ? "Coordinator" : "Worker",
        instanceId: parentInstanceId,
        model: "gpt-5.4",
      }),
      runs: [makeRun({ id: RunId.make(`run-${threadId}`), ordinal: 1, status: "running" })],
      visibleTurnItems: [],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;
  const saved: Array<ScheduledTaskUpsertInput> = [];
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projectionFor(threadId)),
          getThreadShell: (threadId) =>
            Effect.succeed(projectionFor(threadId).thread as unknown as OrchestrationV2ThreadShell),
          getProjectThreadRecords: (input) => Effect.succeed(projectionFor(input.threadId)),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                defaultModelSelection: null,
                workspaceSettings: { coordinatorThreadId: parentThreadId },
              } as never),
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          upsert: (input) =>
            Effect.sync(() => {
              saved.push(input);
              return {
                task: {
                  ...input,
                  id: ScheduledTaskId.make(`task-${saved.length}`),
                  threadId: input.threadId ?? null,
                  nextRunAt: null,
                  lastRunStatus: "never",
                } as never,
              };
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
  const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
    ...makeScope(),
    thread: { ...makeScope().thread!, threadId },
  });
  const watch = {
    prompt: "Check the search console",
    schedule: { type: "interval" as const, everyMs: 3_600_000 },
  };

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    // From the coordinator: its own thread, even when asked to bind to the caller.
    const fromCoordinator = yield* service.scheduleTask(scopeFor(parentThreadId), watch);
    yield* service.scheduleTask(scopeFor(parentThreadId), { ...watch, bindToCurrentThread: true });
    expect(fromCoordinator.boundThreadId).toBeNull();
    expect(fromCoordinator.ownThread).toBe(true);
    for (const input of saved) {
      expect(input.threadId).toBeNull();
      expect(input.ownThread).toBe(true);
      expect(input.workspaceStrategy.type).toBe("worktree");
    }
    // From a worker: "wake me" binds to that worker's thread.
    const fromWorker = yield* service.scheduleTask(scopeFor(workerThreadId), watch);
    expect(fromWorker.boundThreadId).toBe(workerThreadId);
    expect(saved.at(-1)?.ownThread).toBeUndefined();
    // A worker that asks for its own thread gets one.
    yield* service.scheduleTask(scopeFor(workerThreadId), { ...watch, bindToCurrentThread: false });
    expect(saved.at(-1)?.threadId).toBeNull();
    expect(saved.at(-1)?.ownThread).toBe(true);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
