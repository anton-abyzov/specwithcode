import type {
  OrchestrationV2Subagent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@specweave-studio/contracts";
import type * as DateTime from "effect/DateTime";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

/** Persist receipt and projections before offering a parent wake. No model turn is needed. */
export function nativeChildTerminalReceipt(input: {
  readonly task: OrchestrationV2Subagent;
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  readonly itemProviderThreadId?: OrchestrationV2ProviderThread["id"];
  readonly itemProviderTurnId?: OrchestrationV2ProviderTurn["id"];
  readonly status: "completed" | "failed" | "cancelled";
  readonly result: string;
  readonly now: DateTime.Utc;
}): {
  readonly task: OrchestrationV2Subagent;
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
} {
  const task = {
    ...input.task,
    status: input.status,
    result: input.result,
    completedAt: input.now,
    updatedAt: input.now,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: task.id,
    threadId: task.threadId,
    runId: task.runId,
    parentNodeId: task.parentNodeId,
    rootNodeId: input.rootNodeId,
    kind: "subagent",
    status: task.status,
    countsForRun: false,
    providerThreadId: input.itemProviderThreadId ?? task.providerThreadId,
    providerTurnId: input.itemProviderTurnId ?? null,
    nativeItemRef: task.nativeTaskRef,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
  const events: Array<ProviderAdapterV2Event> = [
    { type: "node.updated", driver: task.driver, node },
    {
      type: "turn_item.updated",
      driver: task.driver,
      turnItem: {
        id: input.turnItemId,
        threadId: task.threadId,
        runId: task.runId,
        nodeId: task.id,
        providerThreadId: node.providerThreadId,
        providerTurnId: node.providerTurnId,
        nativeItemRef: task.nativeTaskRef,
        parentItemId: null,
        ordinal: input.turnItemOrdinal,
        type: "subagent",
        status: task.status,
        subagentId: task.id,
        origin: task.origin,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        childThreadId: task.childThreadId,
        title: task.title,
        prompt: task.prompt,
        result: task.result,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        updatedAt: task.updatedAt,
      },
    },
  ];
  if (task.childThreadId !== null)
    events.push({
      type: "node.updated",
      driver: task.driver,
      node: {
        ...node,
        id: input.childRootNodeId,
        threadId: task.childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: input.childRootNodeId,
        kind: "root_turn",
        providerThreadId: null,
        providerTurnId: null,
      },
    });
  // Last: ingestion can retire its child tracking only after all linked records landed.
  events.push({ type: "subagent.updated", driver: task.driver, subagent: task });
  return { task, events };
}
