import {
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@specweave-studio/contracts";

import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

/** Which provider events belong to one root run, and the ownership they add. */
export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  // Set once this run's root turn ended. A child thread created after that
  // belongs to the run that is live then, so this one no longer adopts it.
  readonly rootTurnEnded: boolean;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurnIds: ReadonlySet<ProviderTurnId>;
  readonly inheritedBackgroundTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2Run["id"]>;
  /**
   * Subagents of inherited items, by subagent id. Their earlier process may
   * be gone, so this run also stores the terminal state an adapter reports
   * for them (row, node and the child's runless root turn).
   */
  readonly inheritedSubagents: ReadonlyMap<
    NodeId,
    { readonly runId: OrchestrationV2Run["id"]; readonly childThreadId: ThreadId | null }
  >;
  readonly rootProviderTurnId: ProviderTurnId | null;
}

export interface ProviderEventRouteIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

export interface InheritedBackgroundTurnItemRoute {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
  /** The open item, so a run that fails or is stopped can settle it. */
  readonly turnItem?: OrchestrationV2TurnItem;
  /** A subagent item's open row. */
  readonly subagent?: OrchestrationV2Subagent;
  /** The item's open nodes (its own and, for a subagent, the subagent's). */
  readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
}

// Turn item types whose lifecycle can outlive the root turn (background
// commands, monitors/dynamic tools, subagent rows). Ingestion must not stop
// while one of these is still non-terminal, or the late completion event is
// dropped and the item spins forever in the projection.
export const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set(
  ["command_execution", "dynamic_tool", "subagent"],
);

export function isSettledTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly inheritedBackgroundTurnItems?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    rootTurnEnded: false,
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurnIds:
      input.providerTurnId === null ? new Set() : new Set([input.providerTurnId]),
    inheritedBackgroundTurnItems: new Map(
      (input.inheritedBackgroundTurnItems ?? []).map((item) => [item.id, item.runId]),
    ),
    inheritedSubagents: new Map(
      (input.inheritedBackgroundTurnItems ?? []).flatMap((item) =>
        item.turnItem?.type === "subagent"
          ? [
              [
                item.turnItem.subagentId,
                { runId: item.runId, childThreadId: item.turnItem.childThreadId },
              ] as const,
            ]
          : [],
      ),
    ),
    rootProviderTurnId: input.providerTurnId,
  };
}

export function routeProviderEvent(
  event: ProviderAdapterV2Event,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
): readonly [boolean, ProviderEventRoutingState] {
  const ownsThread = (threadId: ThreadId): boolean => state.ownedThreadIds.has(threadId);
  const ownsChildThread = (threadId: ThreadId): boolean =>
    threadId !== input.threadId && ownsThread(threadId);
  const ownsRun = (runId: string | null): boolean => runId === input.runId;
  // Only a settlement of inherited subagent work, never its live progress:
  // a run still ingesting for it stores that.
  const settlesInheritedSubagent = (id: NodeId, runId: string | null, status: string): boolean =>
    status !== "pending" &&
    status !== "running" &&
    status !== "waiting" &&
    state.inheritedSubagents.get(id)?.runId === runId;
  const settlesInheritedChildRoot = (node: OrchestrationV2ExecutionNode): boolean =>
    node.runId === null &&
    node.kind === "root_turn" &&
    !isOrchestrationV2WorkActive(node.status) &&
    [...state.inheritedSubagents.values()].some(
      (subagent) => subagent.childThreadId === node.threadId,
    );
  const addProviderThread = (providerThreadId: ProviderThreadId): ProviderEventRoutingState => ({
    ...state,
    ownedProviderThreadIds: new Set([...state.ownedProviderThreadIds, providerThreadId]),
  });
  const addProviderTurn = (
    providerTurnId: ProviderTurnId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurnIds: new Set([...state.ownedProviderTurnIds, providerTurnId]),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "provider_session.updated":
      // The session manager persists process-wide status once for every
      // attached app thread before broadcasting the adapter event.
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        !state.rootTurnEnded &&
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId);
      if (!isOwnedSubagent) {
        return [false, state];
      }
      return [
        true,
        {
          ...state,
          ownedThreadIds: new Set([...state.ownedThreadIds, event.appThread.id]),
        },
      ];
    }
    case "provider_thread.updated": {
      const belongs =
        state.ownedProviderThreadIds.has(event.providerThread.id) ||
        (event.providerThread.appThreadId !== null && ownsThread(event.providerThread.appThreadId));
      return belongs ? [true, addProviderThread(event.providerThread.id)] : [false, state];
    }
    case "provider_turn.updated": {
      const isRoot = event.providerTurn.runAttemptId === input.attemptId;
      const belongs =
        isRoot ||
        (event.providerTurn.providerThreadId !== input.providerThreadId &&
          state.ownedProviderThreadIds.has(event.providerTurn.providerThreadId)) ||
        state.ownedProviderTurnIds.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs ? [true, addProviderTurn(event.providerTurn.id, isRoot)] : [false, state];
    }
    case "node.updated": {
      const belongs =
        ownsRun(event.node.runId) ||
        ownsChildThread(event.node.threadId) ||
        settlesInheritedSubagent(event.node.id, event.node.runId, event.node.status) ||
        settlesInheritedChildRoot(event.node);
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated":
      return [
        ownsRun(event.subagent.runId) ||
          ownsChildThread(event.subagent.threadId) ||
          settlesInheritedSubagent(event.subagent.id, event.subagent.runId, event.subagent.status),
        state,
      ];
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "turn_item.updated": {
      if (ownsRun(event.turnItem.runId) || ownsChildThread(event.turnItem.threadId)) {
        return [true, state];
      }
      const inheritedRunId = state.inheritedBackgroundTurnItems.get(event.turnItem.id);
      // Preserve the item's original ownership while allowing the one live run
      // to deliver an exact carryover identity selected from the projection.
      const isInheritedBackgroundItem =
        event.turnItem.threadId === input.threadId &&
        event.turnItem.runId !== null &&
        event.turnItem.runId === inheritedRunId &&
        backgroundCapableTurnItemTypes.has(event.turnItem.type);
      if (!isInheritedBackgroundItem) {
        return [false, state];
      }
      if (!isSettledTurnItemStatus(event.turnItem.status)) {
        return [true, state];
      }
      const inheritedBackgroundTurnItems = new Map(state.inheritedBackgroundTurnItems);
      inheritedBackgroundTurnItems.delete(event.turnItem.id);
      return [true, { ...state, inheritedBackgroundTurnItems }];
    }
    case "plan.updated":
      return [ownsRun(event.plan.runId) || ownsChildThread(event.plan.threadId), state];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurnIds.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "turn.terminal":
      return event.providerTurnId === state.rootProviderTurnId
        ? [true, { ...state, rootTurnEnded: true }]
        : [false, state];
  }
}
