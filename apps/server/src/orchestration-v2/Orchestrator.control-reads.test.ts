import { DeferredResolutionActivation } from "./DeferredThreadResolution.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase(
  ["control-dispatch", "implement-plan", "settle-binding", "parent-pr", "launch-stand-in"].map(
    (name) => ProjectId.make(`project:${name}`),
  ),
);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                decision: "accept",
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      const retiredThreads = yield* McpSessionRegistry.McpRetiredThreads.pipe(
        Effect.provide(McpSessionRegistry.layerRetiredThreads),
      );
      const unknownThreadId = ThreadId.make("thread:control-dispatch-unknown");
      assert.deepEqual(yield* retiredThreads.retiredAmong([threadId, unknownThreadId]), [
        unknownThreadId,
      ]);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      // No live provider session is left to detach (as after a server
      // restart), yet archiving still retires the thread's MCP credentials.
      const archiveEffects = yield* sql<{ readonly effect_type: string }>`
        SELECT effect_type FROM orchestration_v2_effect_outbox
        WHERE command_id = 'archive-with-old-history'
        ORDER BY effect_id ASC`;
      assert.deepEqual(
        archiveEffects.map((effect) => effect.effect_type),
        ["mcp-credential.invalidate", "terminal.cleanup"],
      );
      assert.deepEqual(yield* retiredThreads.retiredAmong([threadId]), [threadId]);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

// Stop's settle follow-up runs after the provider interrupt returns, possibly
// long after the Stop (retries) or again (an effect replayed after a crash).
// A later run's background work is not that Stop's to end.
it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    // The settle that followed a Stop of run 1's turn, dispatched only after
    // run 2 had settled with work of its own.
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    // A settle that found nothing to end replays as a no-op, even after work
    // it would match appears: its receipt is recorded with no events.
    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "anton-abyzov/specwithcode",
      number: 123,
      url: "https://github.com/anton-abyzov/specwithcode/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/anton-abyzov/specwithcode/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a launch stand-in on a pick by hand, never on a server move", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("project:launch-stand-in");
    const standsInFor = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    };
    const create = (name: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-${name}`),
        threadId: ThreadId.make(`thread:${name}`),
        projectId,
        title: name,
        modelSelection,
        launchFallbackFrom: standsInFor,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const standIn = (threadId: ThreadId) =>
      projections.getThread(threadId).pipe(Effect.map((thread) => thread.launchFallbackFrom));
    const setModel = (threadId: ThreadId, commandId: string, model: string) =>
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(commandId),
        threadId,
        modelSelection: { ...modelSelection, model },
      });

    const threadId = ThreadId.make("thread:launch-picked");
    yield* create("launch-picked");
    assert.deepEqual(yield* standIn(threadId), standsInFor);
    // The usage pre-switch is the server's own move: the thread still stands in.
    yield* setModel(threadId, `limit-preswitch:${threadId}:codex:window`, "gpt-6");
    assert.deepEqual(yield* standIn(threadId), standsInFor);
    // A variant of the same model is no pick of another one.
    yield* setModel(threadId, "pick-variant", "gpt-6[1m]");
    assert.deepEqual(yield* standIn(threadId), standsInFor);
    // A pick of another model by hand ends it, and picking back does not restore it.
    yield* setModel(threadId, "pick-other", "gpt-6.5");
    assert.isNull(yield* standIn(threadId));
    yield* setModel(threadId, "pick-back", modelSelection.model);
    assert.isNull(yield* standIn(threadId));

    // A send on another model by hand ends it the same way.
    const sentId = ThreadId.make("thread:launch-sent");
    yield* create("launch-sent");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-launch-sent"),
      threadId: sentId,
      messageId: MessageId.make("message:launch-sent"),
      text: "Go on another model",
      attachments: [],
      modelSelection: { ...modelSelection, model: "gpt-6.5" },
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.isNull(yield* standIn(sentId));

    // A delegated child on a model of its own stands in for nothing its parent did.
    const parentId = ThreadId.make("thread:launch-parent");
    yield* create("launch-parent");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-launch-parent"),
      threadId: parentId,
      messageId: MessageId.make("message:launch-parent"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentId);
    assert.deepEqual(parent.thread.launchFallbackFrom, standsInFor);
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-launch-parent"),
      parentThreadId: parentId,
      parentRunId: parent.runs[0]!.id,
      parentNodeId: parent.runs[0]!.rootNodeId!,
      task: "Review the changes",
      modelSelection: { ...modelSelection, model: "gpt-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childId = (yield* projections.getThreadProjection(parentId)).subagents[0]!.childThreadId!;
    assert.isNull(yield* standIn(childId));
  }).pipe(Effect.provide(layerTest)),
);

const launchStandIn = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

/** A thread that stands in for `launchStandIn`, as a launch fallback leaves it. */
const createStandIn = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId,
      projectId: ProjectId.make("project:launch-stand-in"),
      title: name,
      modelSelection,
      launchFallbackFrom: launchStandIn,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

it.effect("keeps a launch stand-in when a usage-limit fallback moves the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = yield* createStandIn("launch-limit-fallback");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-launch-limit-fallback"),
      threadId,
      messageId: MessageId.make("message:launch-limit-fallback"),
      text: "Work on this.",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* events.write({
      commandId: CommandId.make("limit-launch-limit-fallback"),
      events: [
        {
          id: EventId.make("launch-limit-fallback:run"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
        {
          id: EventId.make("launch-limit-fallback:error"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("launch-limit-fallback:error"),
            type: "error",
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: {
              class: "usage_limit",
              message: "Plan limit reached.",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
            },
          },
        },
      ],
    });
    // The provider fallback worker's continuation on another model.
    const identity = `${threadId}:${run.id}`;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`limit-fallback:${identity}`),
      messageId: MessageId.make(`limit-fallback:${identity}`),
      threadId,
      manualContinuationOfRunId: run.id,
      modelSelection: { ...modelSelection, model: "gpt-6.5" },
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
    const thread = yield* projections.getThread(threadId);
    assert.equal(thread.modelSelection.model, "gpt-6.5");
    assert.deepEqual(thread.launchFallbackFrom, launchStandIn);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a launch stand-in for a server's queued run, not for a person's", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = yield* createStandIn("launch-queued");
    const send = (
      key: string,
      creationSource: "web" | "server",
      dispatchMode: { readonly type: "start_immediately" | "queue_after_active" },
      model?: string,
    ) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`launch-queued:${key}`),
        threadId,
        messageId: MessageId.make(`launch-queued:${key}`),
        text: key,
        attachments: [],
        ...(model === undefined ? {} : { modelSelection: { ...modelSelection, model } }),
        dispatchMode,
        createdBy: creationSource === "server" ? "agent" : "user",
        creationSource,
      });
    // Ends the latest run so the queue may start the next one.
    const finishLatest = (key: string) =>
      Effect.gen(function* () {
        const run = (yield* projections.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.status !== "queued" && candidate.status !== "completed",
        )!;
        const now = yield* DateTime.now;
        yield* events.write({
          commandId: CommandId.make(`launch-queued:finish:${key}`),
          events: [
            {
              id: EventId.make(`launch-queued:finish:${key}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`launch-queued:resume:${key}`),
          threadId,
        });
      });
    const thread = projections.getThread(threadId);

    yield* send("first", "web", { type: "start_immediately" });
    yield* send("server", "server", { type: "queue_after_active" }, "gpt-6.5");
    yield* send("person", "web", { type: "queue_after_active" }, "gpt-6");
    assert.deepEqual((yield* thread).launchFallbackFrom, launchStandIn);
    // The server's queued message starts on its own model: the thread still stands in.
    yield* finishLatest("first");
    assert.equal((yield* thread).modelSelection.model, "gpt-6.5");
    assert.deepEqual((yield* thread).launchFallbackFrom, launchStandIn);
    // A person's queued message on another model is a pick by hand and ends it.
    yield* finishLatest("server");
    assert.equal((yield* thread).modelSelection.model, "gpt-6");
    assert.isNull((yield* thread).launchFallbackFrom);
  }).pipe(Effect.provide(layerTest)),
);

// Steering onto another model moves the thread's saved selection: a provider
// that can restart the turn restarts it, one that cannot takes the steer into
// the running turn. Either way only a person's steer is a pick by hand.
it.effect.each([
  { steering: "into the running turn", creationSource: "server" },
  { steering: "into the running turn", creationSource: "web" },
  { steering: "by interrupt and restart", creationSource: "server" },
  { steering: "by interrupt and restart", creationSource: "web" },
] as const)(
  "a $creationSource steer to another model $steering keeps a launch stand-in only when the server sent it",
  ({ steering, creationSource }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const key = `launch-steer-${steering.replaceAll(" ", "-")}-${creationSource}`;
        const projectId = ProjectId.make(`project:${key}`);
        const databaseLayer = fixtureProjectDatabase([projectId]);
        const cwd = yield* checkpointWorkspace(key);
        const providerEvents = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const capabilities = {
          ...CodexProviderCapabilitiesV2,
          turns: {
            ...CodexProviderCapabilitiesV2.turns,
            supportsActiveSteering: true,
            supportsSteeringByInterruptRestart: steering === "by interrupt and restart",
          },
        };
        const liveAdapter: ProviderAdapterV2Shape = {
          instanceId,
          driver: adapter.driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver: adapter.driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver: adapter.driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(providerEvents),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver: adapter.driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: {
                      driver: adapter.driver,
                      nativeId: "native-thread",
                      strength: "strong",
                    },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Queue.offer(providerEvents, {
                    type: "provider_turn.updated",
                    driver: adapter.driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver: adapter.driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  }),
                steerTurn: () => Effect.void,
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make(`thread:${key}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${key}`),
            threadId,
            projectId,
            title: key,
            modelSelection,
            launchFallbackFrom: launchStandIn,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`start-${key}`),
            threadId,
            messageId: MessageId.make(`message:start-${key}`),
            text: "Work on this.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* worker.drain();
          yield* Fiber.join(running);
          const target = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`steer-${key}`),
            threadId,
            messageId: MessageId.make(`message:steer-${key}`),
            text: "Go on another model.",
            attachments: [],
            modelSelection: { ...modelSelection, model: "gpt-6.5" },
            dispatchMode: { type: "steer_active", targetRunId: target.id },
            createdBy: creationSource === "server" ? "agent" : "user",
            creationSource,
          });
          const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
          assert.equal(thread.modelSelection.model, "gpt-6.5");
          if (creationSource === "server") {
            assert.deepEqual(thread.launchFallbackFrom, launchStandIn);
          } else {
            assert.isNull(thread.launchFallbackFrom);
          }
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: key },
              ProviderAdapterRegistry.layerSingle(liveAdapter),
              { runEffectWorker: false, databaseLayer },
            ).pipe(Layer.provideMerge(databaseLayer)),
          ),
        );
      }),
    ),
);

const deferredResolutionScenarios = [
  "success",
  "automatic-success",
  "activation-off",
  "missing-evidence",
  "stale-evidence",
  "partial-evidence",
  "superseded-evidence",
  "success-metadata",
  "recovery",
  "new-message",
  "reopen",
  "opt-out",
  "pin",
  "failed",
  "interrupted",
  "approval-write",
  "approval-effects",
  "approval-run",
  "approval-resurrect",
  "child-owner",
  "child-write",
  "raced-finish",
  "stopped-rearm",
  "stopped-finish",
] as const;

for (const { scenario, userRequested } of deferredResolutionScenarios.flatMap((scenario) =>
  [false, true].map((userRequested) => ({ scenario, userRequested })),
)) {
  it.effect(`deferred self-resolution: ${userRequested ? "user-requested " : ""}${scenario}`, () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`thread:deferred:${userRequested}:${scenario}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`deferred:${scenario}:create`),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Resolve when done",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`deferred:${scenario}:start`),
        threadId,
        messageId: MessageId.make(`deferred:${scenario}:prompt`),
        text: "Finish the fix",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* projections.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const attemptId = RunAttemptId.make(`deferred:${scenario}:attempt`);
      yield* sink.write({
        commandId: CommandId.make(`deferred:${scenario}:running`),
        events: [
          {
            id: EventId.make(`deferred:${scenario}:running`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now, activeAttemptId: attemptId },
          },
        ],
      });
      // Persist a verified adjudication independently of intent and provider completion.
      // Every readiness guard below is exercised WITH otherwise valid delivery evidence.
      if (scenario !== "activation-off" && scenario !== "missing-evidence") {
        const observedAt = DateTime.formatIso(now);
        const proof = {
          status: "verified" as const,
          reference: "fixture://installed/verified-scope",
          observedAt,
          scopeRevision: "fixture-source",
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`deferred:${scenario}:acceptance`),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: {
                ...(yield* projections.getThread(threadId)),
                lifecycleReceipt: {
                  requestId: run.userMessageId,
                  runId: run.id,
                  acceptanceRevision: scenario === "superseded-evidence" ? "old-revision" : run.id,
                  requestedAt: DateTime.formatIso(run.requestedAt),
                  kind: "code",
                  scope: "Requested installed fix",
                  scopeRevision: "fixture-source",
                  recordedAt: observedAt,
                  validUntil: DateTime.formatIso(
                    DateTime.add(now, {
                      milliseconds: scenario === "stale-evidence" ? -1 : 3600000,
                    }),
                  ),
                  reportedBy: "fixture-verifier",
                  obligations: [],
                  push: proof,
                  merge: proof,
                  deployment:
                    scenario === "partial-evidence"
                      ? { status: "pending", reason: "Release has not installed" }
                      : proof,
                  deliverable: proof,
                  verification: proof,
                },
              },
            },
          ],
        });
        assert.isDefined((yield* projections.getThread(threadId)).lifecycleReceipt);
      }
      // Explicit resolution of an active thread still fails; only exact-run intent is accepted.
      const explicit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`deferred:${scenario}:explicit`),
          threadId,
        }),
      );
      assert.equal(explicit._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "thread.deferred-resolution.request",
        runId: run.id,
        ...(userRequested ? { userRequested: true as const } : {}),
        note: "Fix delivered",
        commandId: CommandId.make(`deferred:${scenario}:request`),
        threadId,
      });
      if (userRequested) {
        // A routine later self-settle must not downgrade the user's explicit Resolve.
        yield* orchestrator.dispatch({
          type: "thread.deferred-resolution.request",
          runId: run.id,
          commandId: CommandId.make(`deferred:${scenario}:repeat-without-user-flag`),
          threadId,
        });
      }
      // A real SQL encode/decode roundtrip retains the intent and leaves the current turn alone.
      const persisted = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(persisted.thread.deferredResolution, {
        runId: run.id,
        ...(userRequested ? { userRequested: true as const } : {}),
        note: "Fix delivered",
      });
      assert.notEqual(persisted.thread.settledOverride, "settled");
      assert.equal(persisted.runs[0]?.status, "running");
      assert.include(yield* projections.getRecoveryThreadIds("deferred-resolutions"), threadId);
      if (scenario === "success-metadata") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`deferred:${scenario}:title`),
          threadId,
          title: "Renamed while finishing",
        });
        assert.deepEqual(
          (yield* projections.getThread(threadId)).deferredResolution,
          persisted.thread.deferredResolution,
        );
      }
      if (scenario === "reopen" || scenario === "pin") {
        yield* orchestrator.dispatch({
          ...(scenario === "reopen"
            ? { type: "thread.unsettle" as const, reason: "user" as const }
            : { type: "thread.pin" as const }),
          commandId: CommandId.make(`deferred:${scenario}:intervene`),
          threadId,
        });
      } else if (scenario === "opt-out") {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          enabled: false,
          commandId: CommandId.make(`deferred:${scenario}:intervene`),
          threadId,
        });
      } else if (scenario === "new-message") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`deferred:${scenario}:intervene`),
          threadId,
          messageId: MessageId.make(`deferred:${scenario}:new`),
          text: "One more change",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      if (scenario.startsWith("approval-") || scenario.startsWith("child-")) {
        const providerThreadId = ProviderThreadId.make(`deferred:${scenario}:provider`);
        const providerThread = {
          id: providerThreadId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: run.ordinal,
          lastRunOrdinal: run.ordinal,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`deferred:${scenario}:provider`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        const request = {
          id: RuntimeRequestId.make(`deferred:${scenario}:approval`),
          nodeId: NodeId.make(`deferred:${scenario}:approval-node`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command" as const,
          status: "pending" as const,
          responseCapability: { type: "not_resumable" as const, reason: "Fixture" },
          createdAt: now,
          resolvedAt: null,
        };
        const child = {
          id: NodeId.make(`deferred:${scenario}:child`),
          threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId!,
          origin: "provider_native" as const,
          createdBy: "agent" as const,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          providerThreadId,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Child work",
          title: null,
          model: null,
          status: "running" as const,
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const pending: OrchestrationV2DomainEvent =
          scenario === "child-owner"
            ? {
                id: EventId.make(`deferred:${scenario}:pending`),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...providerThread,
                  pendingBackgroundTasks: [{ taskId: "child", kind: "subagent" }],
                },
              }
            : scenario === "child-write"
              ? {
                  id: EventId.make(`deferred:${scenario}:pending`),
                  type: "subagent.updated",
                  threadId,
                  occurredAt: now,
                  payload: child,
                }
              : {
                  id: EventId.make(`deferred:${scenario}:pending`),
                  type: "runtime-request.updated",
                  threadId,
                  occurredAt: now,
                  payload: request,
                };
        const input = { guardPendingUserInputCancellations: true, events: [pending] };
        if (scenario === "approval-run") {
          const refused = yield* sink.writeIfRunCurrent({
            ...input,
            threadId,
            runId: run.id,
            activeAttemptId: RunAttemptId.make("stale-attempt"),
            expectedStatus: "running",
          });
          assert.isFalse(refused.committed);
          assert.isNotNull((yield* projections.getThread(threadId)).deferredResolution);
          const result = yield* sink.writeIfRunCurrent({
            ...input,
            threadId,
            runId: run.id,
            activeAttemptId: attemptId,
            expectedStatus: "running",
          });
          assert.isTrue(result.committed);
        } else if (scenario === "child-owner") {
          const refused = yield* sink.writeIfProviderThreadOwner({
            ...input,
            providerThreadId,
            runId: run.id,
            activeAttemptId: RunAttemptId.make("stale-attempt"),
            expectedLastRunOrdinal: run.ordinal,
          });
          assert.isFalse(refused.committed);
          assert.isNotNull((yield* projections.getThread(threadId)).deferredResolution);
          const result = yield* sink.writeIfProviderThreadOwner({
            ...input,
            providerThreadId,
            runId: run.id,
            activeAttemptId: attemptId,
            expectedLastRunOrdinal: run.ordinal,
          });
          assert.isTrue(result.committed);
        } else if (scenario === "approval-effects") {
          yield* sink.writeWithEffects({ ...input, effects: [] });
        } else {
          yield* sink.write(input);
        }
        assert.isTrue((yield* projections.getThread(threadId)).deferredResolution?.revoked);
        const cleared: OrchestrationV2DomainEvent =
          scenario === "child-owner"
            ? {
                ...pending,
                type: "provider-thread.updated",
                payload: { ...providerThread, pendingBackgroundTasks: [] },
              }
            : scenario === "child-write"
              ? {
                  ...pending,
                  type: "subagent.updated",
                  payload: { ...child, status: "completed", completedAt: now, result: "Finished" },
                }
              : {
                  ...pending,
                  type: "runtime-request.updated",
                  payload: {
                    ...request,
                    status: "resolved",
                    resolvedAt: now,
                    decision: "accept",
                  },
                };
        yield* sink.write({
          guardPendingUserInputCancellations: true,
          events: [{ ...cleared, id: EventId.make(`deferred:${scenario}:cleared`) }],
        });
        if (scenario === "approval-resurrect") {
          const stalePayload = { ...persisted.thread, title: "Updated title" };
          yield* sink.commitCommand({
            commandId: CommandId.make(`deferred:${scenario}:stale-metadata`),
            threadId,
            commandType: "thread.metadata.update",
            acceptedAt: now,
            effects: [],
            events: [
              {
                id: EventId.make(`deferred:${scenario}:stale-metadata`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: stalePayload,
              },
            ],
          });
          assert.isTrue((yield* projections.getThread(threadId)).deferredResolution?.revoked);
          assert.equal((yield* projections.getThread(threadId)).title, "Updated title");
          // Provider metadata writes obey the same durable tombstone rule.
          yield* sink.write({
            events: [
              {
                id: EventId.make(`deferred:${scenario}:stale-provider-metadata`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: stalePayload,
              },
            ],
          });
          assert.isTrue((yield* projections.getThread(threadId)).deferredResolution?.revoked);
        }
      }
      if (scenario === "stopped-rearm" || scenario === "stopped-finish") {
        yield* sink.write({
          guardPendingUserInputCancellations: scenario === "stopped-rearm",
          events: [
            {
              id: EventId.make(`deferred:${scenario}:stop`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`deferred:${scenario}:stop`),
                type: "run_interrupt_request",
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "completed",
                title: "Interrupt requested",
                message: "Stopped",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        if (scenario === "stopped-rearm") {
          const late = yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.deferred-resolution.request",
              runId: run.id,
              threadId,
              commandId: CommandId.make(`deferred:${scenario}:late-request`),
            }),
          );
          assert.equal(late._tag, "Failure");
          assert.isTrue((yield* projections.getThread(threadId)).deferredResolution?.revoked);
        }
      }
      const invalidatedIntent = (yield* projections.getThread(threadId)).deferredResolution;
      if (invalidatedIntent?.revoked === true) {
        const rearm = yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.deferred-resolution.request",
            threadId,
            runId: run.id,
            commandId: CommandId.make(`deferred:${scenario}:rearm`),
          }),
        );
        assert.equal(rearm._tag, "Failure");
      }
      const beforeFinish = yield* projections.getThreadProjection(threadId);
      const currentRun = beforeFinish.runs.find((candidate) => candidate.id === run.id)!;
      const resolved =
        scenario === "success"
          ? yield* sink.stream().pipe(
              Stream.filter(
                (stored) =>
                  stored.event.threadId === threadId && stored.event.type === "thread.settled",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            )
          : undefined;
      yield* sink.write({
        commandId: CommandId.make(
          scenario === "raced-finish"
            ? `command:runtime-reconcile:deferred:${scenario}:complete`
            : `deferred:${scenario}:complete`,
        ),
        events: [
          {
            id: EventId.make(`deferred:${scenario}:answer`),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...projection.messages[0]!,
              id: MessageId.make(`deferred:${scenario}:answer`),
              role: "assistant",
              text: "The final answer is delivered.",
              streaming: false,
              runId: run.id,
            },
          },
          {
            id: EventId.make(`deferred:${scenario}:complete`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...currentRun,
              status:
                scenario === "failed"
                  ? "failed"
                  : scenario === "interrupted"
                    ? "interrupted"
                    : "completed",
              completedAt: now,
            },
          },
        ],
      });
      if (scenario === "raced-finish") {
        const snapshot = yield* sink.latestSequence({ threadId });
        const planned = (yield* projections.getThreadProjection(threadId)).thread;
        yield* sink.write({
          guardPendingUserInputCancellations: true,
          events: [
            {
              id: EventId.make(`deferred:${scenario}:late-output`),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...projection.messages[0]!,
                role: "assistant",
                id: MessageId.make(`deferred:${scenario}:late-output`),
                text: "Late provider output",
                streaming: false,
              },
            },
          ],
        });
        yield* sink.commitCommand({
          commandId: CommandId.make(`deferred:${scenario}:raced-commit`),
          threadId,
          commandType: "thread.deferred-resolution.finish",
          expectedThreadSequence: snapshot,
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make(`deferred:${scenario}:stale-settle`),
              type: "thread.settled",
              threadId,
              occurredAt: now,
              payload: {
                ...planned,
                deferredResolution: null,
                settledOverride: "settled",
                settledAt: now,
              },
            },
          ],
        });
      } else if (resolved !== undefined) {
        yield* Fiber.join(resolved);
      } else if (scenario === "automatic-success" && !userRequested) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`deferred:${scenario}:automatic`),
          threadId,
          snapshotAt: (yield* projections.getThread(threadId)).updatedAt,
          snapshotSequence: yield* sink.latestSequence({ threadId }),
        });
      } else if (scenario === "recovery") {
        // Same persisted path startup uses after reconciliation, without replaying terminal history.
        yield* orchestrator.recoverDelegatedTasks;
      } else {
        yield* orchestrator.dispatch({
          type: "thread.deferred-resolution.finish",
          commandId: CommandId.make(`deferred:${scenario}:finish`),
          threadId,
          runId: run.id,
        });
      }
      const result = yield* projections.getThreadProjection(threadId);
      const successful =
        scenario === "success" ||
        scenario === "automatic-success" ||
        scenario === "success-metadata" ||
        scenario === "recovery" ||
        (userRequested &&
          [
            "activation-off",
            "missing-evidence",
            "stale-evidence",
            "partial-evidence",
            "superseded-evidence",
          ].includes(scenario));
      if (scenario === "activation-off" && !userRequested) {
        // No acceptance evidence exists. Neither the completion reactor, a
        // direct finish nor startup recovery may change lifecycle state.
        yield* orchestrator.recoverDelegatedTasks;
        const unchanged = (yield* projections.getThreadProjection(threadId)).thread;
        for (const key of [
          "settledOverride",
          "settledAt",
          "settledNote",
          "pinnedAt",
          "unsettledAt",
          "activeOrderKey",
          "deferredResolution",
          "pullRequests",
        ] as const) {
          assert.deepEqual(unchanged[key], beforeFinish.thread[key]);
        }
      } else if (successful) assert.isNull(result.thread.deferredResolution);
      else assert.isTrue(result.thread.deferredResolution?.revoked);
      if (!successful && scenario !== "activation-off")
        assert.notInclude(
          yield* projections.getRecoveryThreadIds("deferred-resolutions"),
          threadId,
        );
      assert.equal(result.thread.settledOverride === "settled", successful);
      if (successful && scenario !== "automatic-success")
        assert.equal(result.thread.settledNote, "Fix delivered");
      assert.equal(
        result.messages.find((message) => message.role === "assistant")?.text,
        "The final answer is delivered.",
      );
      if (scenario === "approval-write") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          threadId,
          commandId: CommandId.make("deferred:next-run:start"),
          messageId: MessageId.make("deferred:next-run:prompt"),
          text: "A new request",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const nextRun = (yield* projections.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.ordinal > run.ordinal,
        )!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("deferred:next-run:running"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...nextRun, status: "running", startedAt: now },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "thread.deferred-resolution.request",
          threadId,
          runId: nextRun.id,
          commandId: CommandId.make("deferred:next-run:request"),
        });
        assert.deepEqual((yield* projections.getThread(threadId)).deferredResolution, {
          runId: nextRun.id,
        });
      }
    }).pipe(
      Effect.provide(layerTest),
      Effect.provideService(
        DeferredResolutionActivation,
        !userRequested && scenario !== "activation-off" && scenario !== "automatic-success",
      ),
    ),
  );
}
