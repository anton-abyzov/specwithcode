import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunInterruptCause,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { LIVE_SILENT_RUN_REASON } from "./systemInterruptReasons.ts";

/**
 * 1048: a Stop ends the native subagents an earlier run left in the stopped
 * process, with the child thread's runless root turn and its open items. Who
 * stopped it decides how: a person's Stop is final ("Stopped by you"), an
 * agent's says so, and the server's own interrupt (the watchdog) is an outage
 * the parent's next turn is told about (review F-01).
 */

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:core-failure-recovery");
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "core-failure-recovery" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

type Seeded = {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly runA: RunId;
  readonly runB: RunId;
  readonly turnB: ProviderTurnId;
  readonly subagentId: NodeId;
  readonly itemId: TurnItemId;
  readonly childRootId: NodeId;
  readonly childItemId: TurnItemId;
};

/**
 * Run A launched a background native subagent (with a child thread) and
 * completed; its process no longer runs anywhere this server holds. Run B on
 * the same provider thread is running, waiting on nothing.
 */
const seed = (key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${key}`);
    const childThreadId = ThreadId.make(`thread:${key}:child`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${key}`);
    // No session manager entry: the process that ran this thread is gone.
    const providerSessionId = ProviderSessionId.make(`session:${key}:gone`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${key}`),
      threadId,
      projectId,
      title: key,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    let index = 0;
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:${key}:${index++}`),
        occurredAt: now,
      } as OrchestrationV2DomainEvent);
    yield* apply({
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId: instanceId,
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId,
        nativeThreadRef: { driver, nativeId: `native:${key}`, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    } as never);
    const run = (ordinal: number, status: "completed" | "running") =>
      Effect.gen(function* () {
        const runId = RunId.make(`run:${key}:${ordinal}`);
        const nodeId = NodeId.make(`node:${key}:${ordinal}`);
        const attemptId = RunAttemptId.make(`attempt:${key}:${ordinal}`);
        const providerTurnId = ProviderTurnId.make(`provider-turn:${key}:${ordinal}`);
        const done = status === "completed";
        yield* apply({
          type: "run.created",
          threadId,
          runId,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:${key}:${ordinal}`),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status,
            requestedAt: now,
            startedAt: now,
            completedAt: done ? now : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        } as never);
        yield* apply({
          type: "node.updated",
          threadId,
          runId,
          nodeId,
          providerInstanceId: instanceId,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status,
            countsForRun: true,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: done ? now : null,
          },
        } as never);
        yield* apply({
          type: "run-attempt.created",
          threadId,
          runId,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: instanceId,
            providerThreadId,
            providerTurnId,
            reason: "initial",
            status,
            startedAt: now,
            completedAt: done ? now : null,
          },
        } as never);
        yield* apply({
          type: "provider-turn.updated",
          threadId,
          runId,
          nodeId,
          providerInstanceId: instanceId,
          payload: {
            id: providerTurnId,
            providerThreadId,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal,
            status,
            startedAt: now,
            completedAt: done ? now : null,
          },
        } as never);
        return { runId, nodeId, providerTurnId };
      });
    const a = yield* run(1, "completed");
    const subagentId = NodeId.make(`subagent:${key}`);
    const itemId = TurnItemId.make(`item:${key}:subagent`);
    const nativeTaskRef = { driver, nativeId: `task:${key}`, strength: "strong" as const };
    yield* apply({
      type: "subagent.updated",
      threadId,
      runId: a.runId,
      nodeId: subagentId,
      driver,
      providerInstanceId: instanceId,
      payload: {
        id: subagentId,
        threadId,
        runId: a.runId,
        parentNodeId: a.nodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef,
        prompt: "Review the migration",
        title: "Migration review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    } as never);
    yield* apply({
      type: "node.updated",
      threadId,
      runId: a.runId,
      nodeId: subagentId,
      providerInstanceId: instanceId,
      payload: {
        id: subagentId,
        threadId,
        runId: a.runId,
        parentNodeId: a.nodeId,
        rootNodeId: a.nodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId,
        providerTurnId: a.providerTurnId,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    } as never);
    yield* apply({
      type: "turn-item.updated",
      threadId,
      runId: a.runId,
      nodeId: subagentId,
      providerInstanceId: instanceId,
      payload: {
        id: itemId,
        threadId,
        runId: a.runId,
        nodeId: subagentId,
        providerThreadId,
        providerTurnId: a.providerTurnId,
        nativeItemRef: nativeTaskRef,
        parentItemId: null,
        ordinal: 10,
        status: "running",
        title: "Migration review",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId,
        origin: "provider_native",
        driver,
        providerInstanceId: instanceId,
        childThreadId,
        prompt: "Review the migration",
        result: null,
      },
    } as never);
    // The native child thread: a runless root turn and Claude's progress item under it.
    yield* apply({
      type: "thread.created",
      threadId: childThreadId,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: childThreadId,
        projectId,
        title: "Migration review",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    } as never);
    const childRootId = NodeId.make(`node:${key}:child-root`);
    const childItemId = TurnItemId.make(`item:${key}:child-progress`);
    yield* apply({
      type: "node.updated",
      threadId: childThreadId,
      nodeId: childRootId,
      providerInstanceId: instanceId,
      payload: {
        id: childRootId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childRootId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    } as never);
    yield* apply({
      type: "turn-item.updated",
      threadId: childThreadId,
      nodeId: childRootId,
      providerInstanceId: instanceId,
      payload: {
        id: childItemId,
        threadId: childThreadId,
        runId: null,
        nodeId: childRootId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "vp test run",
      },
    } as never);
    const b = yield* run(2, "running");
    return {
      threadId,
      childThreadId,
      providerThreadId,
      runA: a.runId,
      runB: b.runId,
      turnB: b.providerTurnId,
      subagentId,
      itemId,
      childRootId,
      childItemId,
    } satisfies Seeded;
  });

/** How the earlier run's subagent, its child thread and the parent note ended. */
const outcome = (seeded: Seeded) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(seeded.threadId);
    const child = yield* orchestrator.getThreadProjection(seeded.childThreadId);
    const row = parent.subagents.find((subagent) => subagent.id === seeded.subagentId);
    const item = parent.turnItems.find((candidate) => candidate.id === seeded.itemId);
    return {
      row: [row?.status, row?.progress],
      item: [item?.status, item?.type === "subagent" ? item.progress : undefined],
      node: parent.nodes.find((node) => node.id === seeded.subagentId)?.status,
      childRoot: child.nodes.find((node) => node.id === seeded.childRootId)?.status,
      childItem: child.turnItems.find((candidate) => candidate.id === seeded.childItemId)?.status,
      noted: parent.runs.flatMap((run) =>
        (run.restartCancelledBackgroundWork ?? []).flatMap((entry) =>
          entry.id === undefined ? [] : [`${run.id}:${entry.id}`],
        ),
      ),
    };
  });

const OUTAGE = "Stopped when the provider session ended";

const cases = [
  {
    name: "the watchdog's interrupt of a silent run",
    reason: LIVE_SILENT_RUN_REASON,
    cause: undefined,
    status: "interrupted",
    progress: OUTAGE,
    noted: true,
  },
  {
    name: "a person's Stop",
    reason: undefined,
    cause: undefined,
    status: "cancelled",
    progress: "Stopped by you",
    noted: false,
  },
  {
    name: "an agent's interrupt",
    reason: undefined,
    cause: "agent",
    status: "cancelled",
    progress: "Stopped by an agent",
    noted: false,
  },
  {
    name: "a coordinator's cancel",
    reason: undefined,
    cause: "delegated_cancel",
    status: "cancelled",
    progress: "Stopped by an agent",
    noted: false,
  },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly reason: string | undefined;
  readonly cause: OrchestrationV2RunInterruptCause | undefined;
  readonly status: string;
  readonly progress: string;
  readonly noted: boolean;
}>;

it.effect.each(cases)(
  "run.interrupt on a dead session settles an earlier run's subagent by $name",
  (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const key = `interrupt-${scenario.name.replaceAll(/\W+/g, "-")}`;
      const seeded = yield* seed(key);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`interrupt:${key}`),
        threadId: seeded.threadId,
        runId: seeded.runB,
        ...(scenario.reason === undefined ? {} : { reason: scenario.reason }),
        ...(scenario.cause === undefined ? {} : { cause: scenario.cause }),
      });
      const settled = yield* outcome(seeded);
      assert.deepEqual(settled, {
        row: [scenario.status, scenario.progress],
        item: [scenario.status, scenario.progress],
        node: scenario.status,
        // The child thread is written by the parent's command.
        childRoot: scenario.status,
        childItem: scenario.status,
        // An outage is told to the provider thread's latest run, once.
        noted: scenario.noted ? [`${seeded.runB}:${seeded.subagentId}`] : [],
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(cases)(
  "the settle after a returned interrupt settles an earlier run's subagent by $name",
  (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const key = `settle-${scenario.name.replaceAll(/\W+/g, "-")}`;
      const seeded = yield* seed(key);
      const now = yield* DateTime.now;
      // The Stop request run.interrupt records before the provider's interrupt returns.
      yield* projections.apply({
        id: EventId.make(`event:${key}:request`),
        type: "turn-item.updated",
        threadId: seeded.threadId,
        runId: seeded.runB,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${key}:request`),
          threadId: seeded.threadId,
          runId: seeded.runB,
          nodeId: NodeId.make(`node:${key}:2`),
          providerThreadId: seeded.providerThreadId,
          providerTurnId: seeded.turnB,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 50,
          status: "completed",
          title: "Interrupt requested",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_request",
          message: scenario.reason ?? "Interrupt requested",
          ...(scenario.cause === undefined ? {} : { cause: scenario.cause }),
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make(`settle:${key}`),
        threadId: seeded.threadId,
        providerThreadId: seeded.providerThreadId,
        providerTurnId: seeded.turnB,
      });
      const settled = yield* outcome(seeded);
      assert.deepEqual(settled, {
        row: [scenario.status, scenario.progress],
        item: [scenario.status, scenario.progress],
        node: scenario.status,
        childRoot: scenario.status,
        childItem: scenario.status,
        noted: scenario.noted ? [`${seeded.runB}:${seeded.subagentId}`] : [],
      });
      // A retried settle notes nothing twice.
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make(`settle-again:${key}`),
        threadId: seeded.threadId,
        providerThreadId: seeded.providerThreadId,
        providerTurnId: seeded.turnB,
      });
      assert.deepEqual((yield* outcome(seeded)).noted, settled.noted);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["Stop", "outage"] as const)(
  "keeps the cause through two delegated levels and their native children after %s",
  (cause) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const root = yield* seed(`nested-${cause}-root`);
      const middle = yield* seed(`nested-${cause}-middle`);
      const leaf = yield* seed(`nested-${cause}-leaf`);
      const now = yield* DateTime.now;
      for (const [parent, child] of [
        [root, middle],
        [middle, leaf],
      ] as const) {
        const projection = yield* orchestrator.getThreadProjection(parent.threadId);
        const native = projection.subagents[0]!;
        const id = NodeId.make(`delegated:${parent.threadId}`);
        yield* projections.apply({
          id: EventId.make(`link:${parent.threadId}`),
          type: "subagent.updated",
          threadId: parent.threadId,
          runId: parent.runA,
          nodeId: id,
          occurredAt: now,
          payload: {
            ...native,
            id,
            origin: "app_owned",
            nativeTaskRef: null,
            childThreadId: child.threadId,
            title: "Delegated recovery task",
          },
        });
      }
      const commandId = CommandId.make(`interrupt:nested:${cause}`);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId,
        threadId: root.threadId,
        runId: root.runB,
        ...(cause === "outage" ? { reason: LIVE_SILENT_RUN_REASON } : { holdQueue: true }),
      });
      if (cause === "Stop")
        yield* threads.stopDelegatedTasks({ threadId: root.threadId, commandId });
      for (const descendant of [middle, leaf]) {
        const settled = yield* outcome(descendant);
        assert.deepEqual(
          settled.row,
          cause === "Stop" ? ["cancelled", "Stopped by you"] : ["running", undefined],
        );
        assert.equal(settled.childRoot, cause === "Stop" ? "cancelled" : "running");
        assert.equal(settled.childItem, cause === "Stop" ? "cancelled" : "running");
        assert.deepEqual(settled.noted, []);
      }
    }).pipe(Effect.provide(layerTest)),
);
