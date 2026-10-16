// A provider's own background agents and workflows (Claude Code's background
// Agent and Workflow tools, Codex subagents) keep calling SpecWithCode's MCP
// tools after the turn that started them ended. These run the real
// orchestrator and MCP service against a coordinator whose turn completed.
import { fixtureProjectDatabase, projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("project:mcp-between-turns");
const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("claudeAgent");
const model = "gpt-5.1-codex";
const modelSelection = { instanceId, model };
const target = { providerInstanceId: instanceId, model };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerAdapters = ProviderAdapterRegistry.layerFromAdapters([adapter]);
const layerDatabase = fixtureProjectDatabase([projectId]);
// No effect worker: runs stay where the test puts them.
const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry({ name: "mcp-between-turns" }, layerAdapters, {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
      }),
    ),
  ),
);
const codexProvider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const layerTest = OrchestratorMcpService.layer.pipe(
  Layer.provideMerge(layerThreads),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      layerAdapters,
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([codexProvider]),
        refreshInstance: () => Effect.succeed([codexProvider]),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeedSome(projectFixture(id)),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    ),
  ),
);

const scopeOf = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId = instanceId,
): McpInvocationScope & { readonly thread: NonNullable<McpInvocationScope["thread"]> } => ({
  environmentId: EnvironmentId.make("environment:mcp-between-turns"),
  requestNamespace: `session:${threadId}:${providerInstanceId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}:${providerInstanceId}`,
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

/** The provider session that holds `scope`'s credential is attached in this server. */
const attach = (scope: ReturnType<typeof scopeOf>) =>
  McpProviderSession.setMcpProviderSession({
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
    providerSessionId: scope.thread.providerSessionId,
    providerInstanceId: scope.thread.providerInstanceId,
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer fixture",
    browserToolsAvailable: false,
  });

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A coordinator whose one turn ran and ended with `status`. */
const coordinatorAfterTurn = (
  threadId: ThreadId,
  status: "completed" | "interrupted" | "running" = "completed",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Plan the release and start the workers.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:${status}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        ...run,
        status,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
    return run;
  });

it.effect(
  "a coordinator's background agent delegates, launches and sends after its turn ended",
  () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:between-turns-coordinator");
      const workerId = ThreadId.make("thread:between-turns-worker");
      const run = yield* coordinatorAfterTurn(threadId);
      yield* createThread(workerId);
      const scope = scopeOf(threadId);
      attach(scope);

      const delegated = yield* service.delegateTask(scope, {
        task: "Run the release checklist.",
        target,
        mode: "async",
        clientRequestId: "between-turns-delegate",
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const task = parent.subagents.find((candidate) => candidate.id === delegated.taskId);
      // The task belongs to the turn that ended, whose result wakes the thread.
      assert.equal(task?.runId, run.id);
      assert.equal(task?.completionWake, "always");
      const child = yield* orchestrator.getThreadProjection(delegated.childThreadId);
      assert.lengthOf(child.runs, 1);

      const launched = yield* service.createThreads(scope, {
        threads: [{ title: "Release notes", prompt: "Draft the release notes.", target }],
        clientRequestId: "between-turns-launch",
      });
      assert.lengthOf(launched.threads, 1);
      const recorded = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "thread_created",
      );
      assert.equal(recorded?.runId, run.id);

      const sent = yield* service.sendToThread(scope, {
        threadId: workerId,
        message: "Start on the changelog.",
        clientRequestId: "between-turns-send",
      });
      assert.equal(sent.threadId, workerId);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
          McpProviderSession.clearMcpProviderSession(
            ThreadId.make("thread:between-turns-coordinator"),
          ),
        ),
      ),
      Effect.provide(layerTest),
    ),
);

it.effect("between turns only the thread's own attached provider session changes anything", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threadId = ThreadId.make("thread:between-turns-refusals");
    const workerId = ThreadId.make("thread:between-turns-refusals-worker");
    yield* coordinatorAfterTurn(threadId);
    yield* createThread(workerId);
    const delegate = (scope: ReturnType<typeof scopeOf>, key: string) =>
      service
        .delegateTask(scope, {
          task: "Check the build.",
          target,
          mode: "async",
          clientRequestId: key,
        })
        .pipe(Effect.flip);

    // No session holds this credential here any more (a restart, an idle release).
    const detached = yield* delegate(scopeOf(threadId), "detached");
    assert.equal(detached.code, "parent_not_active");
    assert.include(detached.message, "no longer attached");

    // A provider the thread switched away from, though still attached, only reads.
    const previous = scopeOf(threadId, otherInstanceId);
    attach(previous);
    const switched = yield* delegate(previous, "switched");
    assert.equal(switched.code, "parent_not_active");
    assert.include(switched.message, `now runs on ${instanceId}`);
    const sendFromPrevious = yield* service
      .sendToThread(previous, { threadId: workerId, message: "hello" })
      .pipe(Effect.flip);
    assert.equal(sendFromPrevious.code, "parent_not_active");
    // It can still read.
    yield* service.readThread(previous, { threadId: workerId });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() =>
        McpProviderSession.clearMcpProviderSession(ThreadId.make("thread:between-turns-refusals")),
      ),
    ),
    Effect.provide(layerTest),
  ),
);

it.effect("after Stop, what the stopped turn left running changes nothing", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const workerId = ThreadId.make("thread:between-turns-stopped-worker");
    yield* createThread(workerId);
    /** Every change a background agent of `scope`'s thread might ask for, all refused. */
    const assertChangesNothing = (scope: ReturnType<typeof scopeOf>, key: string) =>
      Effect.gen(function* () {
        const refusals = [
          yield* service
            .delegateTask(scope, {
              task: "Late.",
              target,
              mode: "async",
              clientRequestId: `${key}-delegate`,
            })
            .pipe(Effect.flip),
          yield* service
            .createThreads(scope, {
              threads: [{ title: "Late", prompt: "Start late work.", target }],
              clientRequestId: `${key}-launch`,
            })
            .pipe(Effect.flip),
          yield* service
            .sendToThread(scope, {
              threadId: workerId,
              message: "Keep going.",
              clientRequestId: `${key}-send`,
            })
            .pipe(Effect.flip),
          yield* service
            .interruptThread(scope, { threadId: workerId, clientRequestId: `${key}-interrupt` })
            .pipe(Effect.flip),
        ];
        for (const refusal of refusals) {
          assert.equal(refusal.code, "parent_not_active");
          assert.include(refusal.message, "was stopped");
        }
        // It can still read.
        yield* service.readThread(scope, { threadId: workerId });
      });

    // Stop during the turn.
    const stoppedId = ThreadId.make("thread:between-turns-stopped");
    yield* coordinatorAfterTurn(stoppedId, "interrupted");
    const stoppedScope = scopeOf(stoppedId);
    attach(stoppedScope);
    yield* assertChangesNothing(stoppedScope, "stopped");

    // Stop on a finished thread also keeps its last turn from taking new work.
    const finishedId = ThreadId.make("thread:between-turns-finished-stop");
    const finishedRun = yield* coordinatorAfterTurn(finishedId);
    const finishedScope = scopeOf(finishedId);
    attach(finishedScope);
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:between-turns-finished"),
      threadId: finishedId,
    });
    yield* assertChangesNothing(finishedScope, "after-stop");
    const parent = yield* orchestrator.getThreadProjection(finishedId);
    assert.isFalse(parent.subagents.some((task) => task.runId === finishedRun.id));

    // The thread's next turn lifts it: once that turn ends, its agents act again.
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:between-turns-finished-stop:next"),
      threadId: finishedId,
      messageId: MessageId.make("message:between-turns-finished-stop:next"),
      text: "Carry on.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const nextRun = (yield* orchestrator.getThreadProjection(finishedId)).runs.toSorted(
      (left, right) => right.ordinal - left.ordinal,
    )[0]!;
    assert.notEqual(nextRun.id, finishedRun.id);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:between-turns-finished-stop:next"),
      type: "run.updated",
      threadId: finishedId,
      runId: nextRun.id,
      occurredAt: now,
      payload: { ...nextRun, status: "completed", startedAt: now, completedAt: now },
    });
    const sent = yield* service.sendToThread(finishedScope, {
      threadId: workerId,
      message: "Next step.",
      clientRequestId: "after-next-turn-send",
    });
    assert.equal(sent.threadId, workerId);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        McpProviderSession.clearMcpProviderSession(ThreadId.make("thread:between-turns-stopped"));
        McpProviderSession.clearMcpProviderSession(
          ThreadId.make("thread:between-turns-finished-stop"),
        );
      }),
    ),
    Effect.provide(layerTest),
  ),
);

it.effect(
  "the orchestrator takes a late delegated task only on the thread's last completed turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:between-turns-orchestrator");
      const first = yield* coordinatorAfterTurn(threadId);
      const request = (key: string) =>
        orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`delegate:${key}`),
          parentThreadId: threadId,
          parentRunId: first.id,
          parentNodeId: first.rootNodeId!,
          task: key,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* request("after the turn");

      // Once a later turn starts, the earlier one no longer takes work.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:between-turns-orchestrator:second"),
        threadId,
        messageId: MessageId.make("message:between-turns-orchestrator:second"),
        text: "Next.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(request("during a later turn"))));
    }).pipe(Effect.provide(layerTest)),
);
