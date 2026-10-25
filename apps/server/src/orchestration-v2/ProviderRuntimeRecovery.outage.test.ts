import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  NodeId,
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
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect.each([
  ["startup", "completed", "running"],
  ["shutdown", "completed", "running"],
  ["startup", "running", "running"],
  ["shutdown", "running", "running"],
  ["startup", "completed", "completed"],
  ["shutdown", "completed", "completed"],
] as const)(
  "%s interrupts native subagent outages on a %s parent with a %s runless root",
  ([trigger, status, rootStatus]) => {
    const threadId = ThreadId.make("thread_recovery_subagent");
    const settledRunId = RunId.make("run_recovery_subagent_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_subagent");
    const staleSubagentNodeId = NodeId.make("node_recovery_subagent_stale");
    const doneSubagentNodeId = NodeId.make("node_recovery_subagent_done");
    const staleItemId = TurnItemId.make("turn_item_recovery_subagent_stale");
    const doneItemId = TurnItemId.make("turn_item_recovery_subagent_done");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      // Settled run: the stale-item loop owns it, not the nonterminal loop.
      runs: [{ id: settledRunId, status, providerInstanceId: claudeInstanceId }],
      attempts: [],
      nodes: [
        { id: NodeId.make("runless-root"), kind: "root_turn", runId: null, status: rootStatus },
        { id: staleSubagentNodeId, runId: settledRunId, status: "running" },
        { id: doneSubagentNodeId, runId: settledRunId, status: "completed" },
      ],
      subagents: [
        {
          id: staleSubagentNodeId,
          runId: settledRunId,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "running",
        },
        {
          // Already finished with a real result: must never be overwritten.
          id: doneSubagentNodeId,
          runId: settledRunId,
          origin: "provider_native",
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "completed",
          result: "done",
        },
      ],
      messages: [],
      turnItems: [
        {
          id: TurnItemId.make("runless-command"),
          type: "command_execution",
          runId: null,
          nodeId: NodeId.make("runless-root"),
          status: "running",
        },
        {
          id: TurnItemId.make("runless-completed-command"),
          type: "command_execution",
          runId: null,
          nodeId: NodeId.make("runless-root"),
          status: "completed",
          output: "preserved output",
        },
        {
          id: staleItemId,
          runId: settledRunId,
          nodeId: staleSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "running",
          subagentId: staleSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
        {
          id: doneItemId,
          runId: settledRunId,
          nodeId: doneSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "completed",
          subagentId: doneSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile(trigger);
      const events = committedInput?.events ?? [];
      const native = events.find((event) => event.type === "subagent.updated");
      assert.equal(
        native?.type === "subagent.updated" ? native.payload.status : null,
        "interrupted",
        "server process loss is an outage, not cancellation",
      );

      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === "runless-command" &&
            event.payload.status === "interrupted",
        ),
        "open runless work settles even when its root completed earlier",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" && event.payload.id === "runless-completed-command",
        ),
      );
      // Both open items settle; terminal items retain their results.
      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "interrupted",
      );
      assert.equal(turnItemCancels.length, 2);

      // The linked subagent entity is terminalized alongside its turn item.
      const subagentCancels = events.filter((event) => event.type === "subagent.updated");
      assert.equal(subagentCancels.length, 1);
      const subagentCancel = subagentCancels[0];
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.status : null,
        "interrupted",
        "server process loss is an outage, not cancellation",
      );
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.id : null,
        staleSubagentNodeId,
      );
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.status : null,
        "interrupted",
      );

      // So is its execution node, which no live process can terminalize.
      const nodeCancels = events.filter((event) => event.type === "node.updated");
      assert.equal(nodeCancels.length, rootStatus === "running" ? 2 : 1);
      const nodeCancel = nodeCancels[0];
      assert.equal(
        nodeCancel?.type === "node.updated" ? nodeCancel.payload.id : null,
        staleSubagentNodeId,
      );

      const rootUpdates = events.filter(
        (event) => event.type === "node.updated" && event.payload.id === "runless-root",
      );
      assert.lengthOf(rootUpdates, rootStatus === "running" ? 1 : 0);
      if (rootStatus === "running")
        assert.equal(
          rootUpdates[0]?.type === "node.updated" ? rootUpdates[0].payload.status : null,
          "interrupted",
        );
      assert.include(
        native?.type === "subagent.updated" ? (native.payload.progress ?? "") : "",
        "Stopped when SpecWithCode",
      );
      // The already-completed subagent and node are left untouched.
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);
