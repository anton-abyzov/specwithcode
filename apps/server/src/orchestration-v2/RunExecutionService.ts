import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
  CommandId,
  type EventId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2RunInterruptCause,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
  runInterruptResultMessage,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnMessage,
} from "./ProviderAdapter.ts";
import { ProviderAdapterTurnStartError, providerSetupFailureDetail } from "./ProviderAdapter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import {
  isLocalStorageFailure,
  isPreviousTurnActiveFailure,
  makeProviderFailure,
  makeProviderFailureTurnItem,
  previousActiveProviderTurn,
  providerFailureDiagnostics,
} from "./ProviderFailure.ts";
import { logProviderTurnStartFailure } from "./ProviderTurnStartLogging.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import { isolateIngestFailure, retryFinalWrite } from "./RunIngestionGuards.ts";
import {
  interruptedSubagentWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";
import {
  isOutageProgress,
  outageProgress,
  settleStaleBackgroundItems,
  stopIntent,
  stopSettlement,
  type StopIntent,
  type SubagentSettlementProjection,
} from "./SubagentSettlement.ts";
import * as RunLiveness from "./RunLiveness.ts";
import {
  backgroundCapableTurnItemTypes,
  isSettledTurnItemStatus,
  makeProviderEventRoutingState,
  routeProviderEvent,
  type InheritedBackgroundTurnItemRoute,
  type ProviderEventRouteIdentity,
  type ProviderEventRoutingState,
} from "./ProviderEventRouting.ts";

export {
  makeProviderEventRoutingState,
  routeProviderEvent,
  type InheritedBackgroundTurnItemRoute,
  type ProviderEventRouteIdentity,
  type ProviderEventRoutingState,
};

// Retry bounded status checks before any provider request is sent.
const TRANSIENT_TURN_START_RETRIES = 2;
const TRANSIENT_TURN_START_RETRY_DELAY = "10 seconds";
export const isTransientTurnStartFailure = (error: unknown): boolean =>
  /native provider status check (timed out|failed)/u.test(providerSetupFailureDetail(error) ?? "");

// A provider turn no run owns any more is stopped, then the start is retried
// until the provider lets go of it, within these bounds.
const ORPHANED_TURN_INTERRUPT_TIMEOUT = "10 seconds";
const ORPHANED_TURN_CLEAR_POLL = "1 second";
const ORPHANED_TURN_CLEAR_POLLS = 30;
// Ingestion that cannot store events stops its provider turn, bounded so the
// run still settles when the provider does not answer.
const INGESTION_FAILURE_INTERRUPT_TIMEOUT = "10 seconds";

type ProviderTerminalEvent = Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal" }>;

function isTerminalProviderTurnStatus(status: OrchestrationV2ProviderTurn["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isSettledSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

function isSettledRunEligibleForInheritedBackground(status: OrchestrationV2Run["status"]): boolean {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/**
 * Transfer delivery permission for exact live background items whose original
 * run no longer has a subscriber. Provider sessions are runtime containers and
 * can host multiple provider threads, so the durable provider-thread lineage is
 * the discriminator. Completed, rolled-back, and already-terminal items remain
 * excluded.
 */
export function selectInheritedBackgroundTurnItems(input: {
  readonly threadId: ThreadId;
  readonly currentProviderThreadId: ProviderThreadId;
  readonly currentRunOrdinal: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** Open rows and nodes; given, each route carries its item's, so the run can settle them. */
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
}): ReadonlyArray<InheritedBackgroundTurnItemRoute> {
  const settledPriorRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.threadId === input.threadId &&
          run.ordinal < input.currentRunOrdinal &&
          isSettledRunEligibleForInheritedBackground(run.status),
      )
      .map((run) => run.id),
  );
  return input.turnItems.flatMap((turnItem) => {
    if (
      turnItem.threadId !== input.threadId ||
      turnItem.providerThreadId !== input.currentProviderThreadId ||
      turnItem.runId === null ||
      !settledPriorRunIds.has(turnItem.runId) ||
      !backgroundCapableTurnItemTypes.has(turnItem.type) ||
      isSettledTurnItemStatus(turnItem.status)
    ) {
      return [];
    }
    if (input.subagents === undefined && input.nodes === undefined) {
      return [{ id: turnItem.id, runId: turnItem.runId }];
    }
    const subagentId = turnItem.type === "subagent" ? turnItem.subagentId : null;
    const subagent = input.subagents?.find(
      (candidate) => candidate.id === subagentId && isOrchestrationV2WorkActive(candidate.status),
    );
    const nodes = (input.nodes ?? []).filter(
      (node) =>
        (node.id === turnItem.nodeId || node.id === subagentId) &&
        isOrchestrationV2WorkActive(node.status),
    );
    return [
      {
        id: turnItem.id,
        runId: turnItem.runId,
        turnItem,
        ...(subagent === undefined ? {} : { subagent }),
        ...(nodes.length === 0 ? {} : { nodes }),
      },
    ];
  });
}

type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  /** Child threads once linked by a root-run subagent row; kept for cascade. */
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
};

type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/**
 * Whether a new run takes over a subagent's child thread, so a later message
 * can resume it there. A running subagent stays with the run that launched it,
 * which keeps ingesting until it ends; taking it over too would store its
 * events twice. An interrupted, failed or cancelled one is never resumed.
 */
export function canRouteRelatedSubagent(status: OrchestrationV2Subagent["status"]): boolean {
  return status === "completed";
}

function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
  };
}

function withLinkedChildThreadId(
  current: OpenRunOwnedSubagentProjection,
  childThreadId: ThreadId | null,
): OpenRunOwnedSubagentProjection {
  if (childThreadId === null || current.linkedChildThreadIds.has(childThreadId)) {
    return current;
  }
  const linkedChildThreadIds = new Set(current.linkedChildThreadIds);
  linkedChildThreadIds.add(childThreadId);
  return { ...current, linkedChildThreadIds };
}

export function cascadeTerminalizeRunOwnedSubagents(input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  /** Why the subagents ended (see SubagentSettlement); omitted leaves their progress. */
  readonly progress?: string;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
}): Effect.Effect<
  ReadonlyArray<OrchestrationV2DomainEvent>,
  IdAllocator.IdAllocatorV2AllocationError
> {
  return Effect.gen(function* () {
    const events: Array<OrchestrationV2DomainEvent> = [];
    // Prefer lifetime linkage over currently-open rows: subagent/turn-item
    // snapshots may terminalize before the linked child-thread node settles.
    const childThreadIds = new Set(input.open.linkedChildThreadIds);
    for (const item of [...input.open.subagents.values(), ...input.open.turnItems.values()]) {
      if (item.childThreadId !== null) {
        childThreadIds.add(item.childThreadId);
      }
    }
    const keys = new Set<NodeId>([
      ...input.open.subagents.keys(),
      ...input.open.turnItems.keys(),
      ...input.open.nodes.keys(),
    ]);
    for (const key of keys) {
      const subagent = input.open.subagents.get(key);
      if (subagent !== undefined && !isSettledSubagentStatus(subagent.status)) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "subagent.updated",
          threadId: subagent.threadId,
          runId: input.run.id,
          nodeId: subagent.id,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...subagent,
            status: input.status,
            ...(input.progress === undefined ? {} : { progress: input.progress }),
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
      }
      const node = input.open.nodes.get(key);
      if (
        node !== undefined &&
        ((node.threadId === input.run.threadId && node.runId === input.run.id) ||
          childThreadIds.has(node.threadId)) &&
        isOpenExecutionNodeStatus(node.status)
      ) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "node.updated",
          threadId: node.threadId,
          runId: node.runId ?? input.run.id,
          nodeId: node.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...node,
            status: input.status,
            completedAt: input.completedAt,
          },
        });
      }
      const turnItem = input.open.turnItems.get(key);
      if (
        turnItem !== undefined &&
        turnItem.runId === input.run.id &&
        !isSettledTurnItemStatus(turnItem.status)
      ) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "turn-item.updated",
          threadId: turnItem.threadId,
          runId: input.run.id,
          ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...turnItem,
            status: input.status,
            ...(input.progress === undefined ? {} : { progress: input.progress }),
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
      }
    }
    for (const turnItem of input.open.childTurnItems.values()) {
      if (!childThreadIds.has(turnItem.threadId) || isSettledTurnItemStatus(turnItem.status)) {
        continue;
      }
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: turnItem.threadId,
        runId: turnItem.runId ?? input.run.id,
        ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...turnItem,
          ...("streaming" in turnItem ? { streaming: false } : {}),
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    return events;
  });
}

const OUTAGE_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "usage_limit",
  "transport_error",
  "provider_error",
]);

/**
 * How a failed or stopped run settles the subagents it leaves open. A limit
 * or provider failure is an outage: the subagents are `interrupted`, say why,
 * and the parent is told it lost them. So is an update's or the server's own
 * interrupt (watchdog, start timeout). A person's Stop is final: `cancelled`,
 * "Stopped by you"; an agent's is "Stopped by an agent". Any other end keeps
 * the run's own status.
 */
export function runSubagentSettlement(
  terminal: ProviderTerminalEvent,
  intent: StopIntent | null,
): {
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly progress?: string;
  readonly outage: boolean;
} | null {
  if (!isRunOwnedSubagentTerminalStatus(terminal.status)) return null;
  if (terminal.status === "failed" && OUTAGE_FAILURE_CLASSES.has(terminal.failure.class)) {
    return {
      status: "interrupted",
      progress: outageProgress({ driver: terminal.driver, failureClass: terminal.failure.class }),
      outage: true,
    };
  }
  if (terminal.status === "interrupted" && intent !== null) {
    return stopSettlement(intent, terminal.driver);
  }
  return { status: terminal.status, outage: false };
}

export function finalProviderThreadStatus(
  disposition: ProviderTerminalEvent["threadDisposition"],
): OrchestrationV2ProviderThread["status"] {
  return disposition === "broken" ? "error" : "idle";
}

/**
 * ERRORS
 */
export class RunExecutionStartError extends Schema.TaggedError<RunExecutionStartError>()(
  "RunExecutionStartError",
  {
    commandId: CommandId,
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start orchestration V2 run execution ${this.runId}.`;
  }
}

export class RunExecutionIngestError extends Schema.TaggedError<RunExecutionIngestError>()(
  "RunExecutionIngestError",
  {
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while ingesting orchestration V2 run execution ${this.runId}.`;
  }
}

export const RunExecutionServiceV2Error = Schema.Union([
  RunExecutionStartError,
  RunExecutionIngestError,
]);
export type RunExecutionServiceV2Error = typeof RunExecutionServiceV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface RunExecutionServiceV2StartRootRunInput {
  readonly commandId: CommandId;
  readonly appThread: OrchestrationV2AppThread;
  readonly providerSessionId: ProviderSessionId;
  readonly session: ProviderAdapterV2SessionRuntime;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly checkpointScope: OrchestrationV2CheckpointScope;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly attemptId: RunAttemptId;
  readonly providerTurnOrdinal: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
    ReadonlyArray<InheritedBackgroundTurnItemRoute>,
    unknown
  >;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly shouldStartProviderTurn?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
  /**
   * Whether a live run other than this one owns a provider turn the provider
   * reports still active (null when it did not name the turn). Without it, a
   * busy provider fails the start.
   */
  readonly previousTurnOwnedByLiveRun?: (
    providerTurnId: ProviderTurnId | null,
  ) => Effect.Effect<boolean | "unknown", never>;
  readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  /** The run's latest Stop request (who asked, and why), or null with none. */
  readonly runInterruptRequest?: () => Effect.Effect<RunInterruptRequest | null, never>;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface RunExecutionServiceV2Shape {
  readonly startRootRun: (
    input: RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void, RunExecutionServiceV2Error>;
}

export class RunExecutionServiceV2 extends Context.Service<
  RunExecutionServiceV2,
  RunExecutionServiceV2Shape
>()("specweave-studio/orchestration-v2/RunExecutionService/RunExecutionServiceV2") {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<
  RunExecutionServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RunExecutionServiceV2,
  Effect.gen(function* () {
    const checkpointService = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const finalizationObserver = yield* RunFinalizationService.RunFinalizationObserver;
    const liveness = yield* RunLiveness.RunLiveness;

    const writeFinalRunEvents = (input: {
      readonly run: OrchestrationV2Run;
      readonly rootNode: OrchestrationV2ExecutionNode;
      readonly checkpointScope: OrchestrationV2CheckpointScope;
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly attempt: OrchestrationV2RunAttempt;
      readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
      readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
      readonly runInterruptRequest?: () => Effect.Effect<RunInterruptRequest | null, never>;
      readonly openRunOwnedSubagents?: OpenRunOwnedSubagentProjection;
      /** Earlier runs' subagent items this run delivered and that are still open. */
      readonly openInheritedSubagents?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
      readonly terminal: ProviderTerminalEvent;
      readonly failureItemPersisted: boolean;
      readonly refreshAfterTurn: Effect.Effect<void>;
      readonly writeIfRunCurrent?: {
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
    }) =>
      Effect.gen(function* () {
        const completedAt = yield* DateTime.now;
        const finalizedAttempt: OrchestrationV2RunAttempt | null = {
          ...input.attempt,
          status: input.terminal.status,
          completedAt,
        };
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        const interruptRequest = () =>
          input.runInterruptRequest === undefined
            ? Effect.succeed(null)
            : input.runInterruptRequest();
        const interruptCause = () =>
          interruptRequest().pipe(
            Effect.map((request) =>
              request === null || stopIntent(request) === "system"
                ? null
                : (request.cause ?? "user"),
            ),
          );
        if (!shouldFinalizeRun) {
          // Superseded attempt (steer / selection restart). Emit
          // run_interrupt_result only when hard Stop left an unpaired request
          // for this run; plain steers and already-paired stops emit nothing.
          if (input.terminal.status === "interrupted") {
            const hasUnpairedRequest =
              input.hasUnpairedRunInterruptRequest === undefined
                ? false
                : yield* input.hasUnpairedRunInterruptRequest();
            if (hasUnpairedRequest) {
              yield* eventSink.writeWithEffects({
                effects: [],
                events: [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      completedAt,
                      cause: yield* interruptCause(),
                    }),
                  },
                ],
              });
              yield* input.refreshAfterTurn;
            }
          }
          return;
        }
        const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
        const open = input.openRunOwnedSubagents ?? emptyOpenRunOwnedSubagentProjection();
        const hasOpenSubagentProjection =
          open.subagents.size > 0 ||
          open.turnItems.size > 0 ||
          open.childTurnItems.size > 0 ||
          open.nodes.size > 0;
        const inherited = (input.openInheritedSubagents ?? []).filter(
          (route) =>
            route.turnItem?.type === "subagent" && route.turnItem.origin === "provider_native",
        );
        const settlement =
          hasOpenSubagentProjection || inherited.length > 0
            ? runSubagentSettlement(
                input.terminal,
                input.terminal.status === "interrupted"
                  ? stopIntent(yield* interruptRequest())
                  : null,
              )
            : null;
        const cascadedSubagentEvents =
          settlement !== null && hasOpenSubagentProjection
            ? yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open,
                status: settlement.status,
                ...(settlement.progress === undefined ? {} : { progress: settlement.progress }),
                completedAt,
                allocateEventId,
              })
            : [];
        // Subagents an earlier, stopped run launched end with this run too:
        // nothing is left ingesting for them.
        const inheritedSettlement =
          settlement !== null && inherited.length > 0
            ? yield* settleStaleBackgroundItems({
                projection: {
                  thread: {
                    id: input.run.threadId,
                    providerInstanceId: input.run.providerInstanceId,
                  } as SubagentSettlementProjection["thread"],
                  runs: [input.run],
                  nodes: inherited.flatMap((route) => route.nodes ?? []),
                  subagents: inherited.flatMap((route) =>
                    route.subagent === undefined ? [] : [route.subagent],
                  ),
                  turnItems: [],
                  providerThreads: [input.providerThread],
                },
                items: inherited.flatMap((route) =>
                  route.turnItem === undefined ? [] : [route.turnItem],
                ),
                status: settlement.status,
                progress: settlement.progress,
                now: completedAt,
                allocateEventId,
                settledNodeIds: new Set(),
              })
            : { events: [], subagents: [] };
        const lostWork =
          settlement?.outage === true
            ? mergeRestartCancelledBackgroundWork(
                [...open.subagents.values(), ...open.turnItems.values()].flatMap((subagent) =>
                  "subagentId" in subagent
                    ? [
                        interruptedSubagentWork({
                          id: subagent.subagentId,
                          title: subagent.title,
                          prompt: subagent.prompt,
                        }),
                      ]
                    : subagent.origin === "provider_native"
                      ? [interruptedSubagentWork(subagent)]
                      : [],
                ),
                inherited.flatMap((route) =>
                  route.turnItem?.type === "subagent"
                    ? [
                        interruptedSubagentWork({
                          id: route.turnItem.subagentId,
                          title: route.turnItem.title,
                          prompt: route.turnItem.prompt,
                        }),
                      ]
                    : [],
                ),
              )
            : [];
        const persistedStatus =
          input.terminal.status === "completed" ? "waiting" : input.terminal.status;
        // Completion cohorts are advanced by Orchestrator while a provider
        // turn is in flight. Do not replay the run snapshot captured at start
        // over a newer acknowledgement, successor, or Stop barrier.
        const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } =
          input.run;
        const finalizedRun: OrchestrationV2Run = {
          ...runWithoutDelegatedCompletion,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: finalProviderThreadStatus(input.terminal.threadDisposition),
          updatedAt: completedAt,
        };
        const runEventId = yield* allocateEventId();
        const nodeEventId = yield* allocateEventId();
        const providerThreadEventId = yield* allocateEventId();
        const checkpointCaptureCommandId = CommandId.make(
          `command:effect:checkpoint.capture:${input.run.id}`,
        );
        // Stopped runs capture too: their checkpoint is the rollback point for
        // the next message. The capture is enqueued with these terminal events,
        // ahead of any later run's start on this thread's effect lane.
        const finalization = {
          effects:
            input.terminal.status === "completed" ||
            input.terminal.status === "interrupted" ||
            input.terminal.status === "cancelled"
              ? [
                  {
                    id: `effect:checkpoint.capture:${input.run.id}`,
                    commandId: checkpointCaptureCommandId,
                    threadId: input.run.threadId,
                    request: {
                      type: "checkpoint.capture" as const,
                      runId: input.run.id,
                      scopeId: input.checkpointScope.id,
                    },
                  },
                ]
              : [],
          events: [
            // Terminalize open run-owned subagent rows before the root run
            // settles so projections never keep a forever-running subagent card.
            ...cascadedSubagentEvents,
            ...inheritedSettlement.events,
            ...(finalizedAttempt === null
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "run-attempt.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: finalizedAttempt,
                  },
                ]),
            ...(input.terminal.status === "interrupted"
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      completedAt,
                      cause: yield* interruptCause(),
                    }),
                  },
                ]
              : []),
            ...(input.terminal.status === "failed" && !input.failureItemPersisted
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeProviderFailureTurnItem({
                      idAllocator,
                      driver: input.terminal.driver,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.terminal.providerThreadId,
                      providerTurnId: input.terminal.providerTurnId,
                      itemOrdinal: input.terminal.failureItemOrdinal,
                      failure: input.terminal.failure,
                      occurredAt: completedAt,
                    }),
                  },
                ]
              : []),
            {
              id: runEventId,
              type: "run.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            {
              id: providerThreadEventId,
              type: "provider-thread.updated",
              threadId: input.run.threadId,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedProviderThread,
            },
          ],
        } satisfies Parameters<typeof eventSink.writeWithEffects>[0];
        if (input.writeIfRunCurrent !== undefined) {
          const result = yield* eventSink.writeIfRunCurrent({
            threadId: input.run.threadId,
            runId: input.run.id,
            activeAttemptId: input.writeIfRunCurrent.activeAttemptId,
            expectedStatus: input.writeIfRunCurrent.expectedStatus,
            events: finalization.events,
            effects: finalization.effects,
          });
          if (!result.committed) {
            return;
          }
        } else {
          yield* eventSink.writeWithEffects(finalization);
        }
        if (lostWork.length > 0 && providerEventIngestor.noteLostSubagentWork !== undefined) {
          // After the run's own write, so its snapshot cannot replace the note.
          yield* providerEventIngestor
            .noteLostSubagentWork({
              threadId: input.run.threadId,
              providerThreadId: input.providerThread.id,
              work: lostWork,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not tell the parent which subagents were interrupted", {
                  runId: input.run.id,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }
        yield* input.refreshAfterTurn;
      });

    return RunExecutionServiceV2.of({
      startRootRun: (input) =>
        Effect.gen(function* () {
          // Startup failure and stream shutdown can report the same attempt.
          const refreshAfterTurn = yield* Effect.cached(
            finalizationObserver.refreshAfterTurn(input.appThread.projectId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to refresh pull requests after run termination", {
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  cause,
                }),
              ),
            ),
          );
          const makeFailedTerminalEvent = (
            failure: OrchestrationV2ProviderFailure,
            failureItemOrdinal: number,
          ): ProviderTerminalEvent => ({
            type: "turn.terminal",
            driver: input.providerThread.driver,
            providerThreadId: input.providerThread.id,
            providerTurnId:
              input.attempt.providerTurnId ??
              idAllocator.derive.providerTurn({
                driver: input.providerThread.driver,
                nativeTurnId: `failed:${input.attempt.id}`,
              }),
            runOrdinal: input.run.ordinal,
            failureItemOrdinal,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          const makeInterruptedTerminalEvent = (): ProviderTerminalEvent => ({
            type: "turn.terminal",
            driver: input.providerThread.driver,
            providerThreadId: input.providerThread.id,
            providerTurnId:
              input.attempt.providerTurnId ??
              idAllocator.derive.providerTurn({
                driver: input.providerThread.driver,
                nativeTurnId: `interrupted:${input.attempt.id}`,
              }),
            runOrdinal: input.run.ordinal,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          const responseStreamingMode = yield* Effect.gen(function* () {
            const responseStreamingMode = yield* serverSettings.getSettings.pipe(
              Effect.map(
                (settings) =>
                  resolveProjectSettings(settings, input.appThread.projectId).settings
                    .responseStreamingMode,
              ),
            );
            yield* checkpointService
              .captureBaseline({
                scope: input.checkpointScope,
                ordinalWithinScope: Math.max(0, input.run.ordinal - 1),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning(
                        "orchestration V2 checkpoint baseline capture failed; starting provider without a baseline",
                        { runId: input.run.id },
                      ),
                ),
              );
            if (
              input.shouldStartProviderTurn !== undefined &&
              !(yield* input.shouldStartProviderTurn())
            ) {
              return null;
            }
            return responseStreamingMode;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) {
                  return yield* Effect.failCause(cause);
                }
                yield* Effect.logError("orchestration V2 run preparation failed", {
                  runId: input.run.id,
                  cause,
                });
                yield* writeFinalRunEvents({
                  run: input.run,
                  rootNode: input.rootNode,
                  checkpointScope: input.checkpointScope,
                  providerThread: input.providerThread,
                  attempt: input.attempt,
                  terminal: makeFailedTerminalEvent(
                    makeProviderFailure({
                      cause: Cause.squash(cause),
                      // Keep exact underlying text in the logged cause only;
                      // the persisted turn item gets a bounded curated message.
                      message: "Run preparation failed.",
                      class: "unknown",
                    }),
                    input.providerTurnOrdinal * 100 + 1,
                  ),
                  failureItemPersisted: false,
                  refreshAfterTurn,
                  writeIfRunCurrent: {
                    activeAttemptId: input.attemptId,
                    expectedStatus: "running",
                  },
                });
                return null;
              }),
            ),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          if (responseStreamingMode === null) {
            return;
          }
          const terminalEvent = yield* Ref.make<ProviderTerminalEvent | null>(null);
          const latestTurnItemOrdinal = yield* Ref.make(input.providerTurnOrdinal * 100);
          const latestProviderThread = yield* Ref.make(input.providerThread);
          const routeIdentity: ProviderEventRouteIdentity = {
            threadId: input.run.threadId,
            runId: input.run.id,
            attemptId: input.attempt.id,
            providerThreadId: input.providerThread.id,
          };
          const eventSubscription =
            input.session.subscribeEvents === undefined
              ? { events: input.session.events, close: Effect.void }
              : yield* input.session.subscribeEvents;
          const inheritedBackgroundTurnItems = yield* (
            input.loadInheritedBackgroundTurnItems?.() ?? Effect.succeed([])
          ).pipe(
            Effect.onError(() => eventSubscription.close),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          const inheritedBackgroundTurnItemsById = new Map(
            inheritedBackgroundTurnItems.map((item) => [item.id, item.runId]),
          );
          const eventRouting = yield* Ref.make<ProviderEventRoutingState>(
            makeProviderEventRoutingState({
              identity: routeIdentity,
              inheritedBackgroundTurnItems,
              providerTurnId: input.attempt.providerTurnId,
              ...(input.relatedThreadIds === undefined
                ? {}
                : { relatedThreadIds: input.relatedThreadIds }),
              ...(input.relatedProviderThreadIds === undefined
                ? {}
                : { relatedProviderThreadIds: input.relatedProviderThreadIds }),
            }),
          );
          const rootTerminalSeen = yield* Ref.make(false);
          const rootRunFinalized = yield* Ref.make(false);
          const providerThreadOwnerLost = yield* Ref.make(false);
          const activeChildProviderTurns = yield* Ref.make<ReadonlySet<ProviderTurnId>>(new Set());
          const activeChildSubagents = yield* Ref.make<ReadonlySet<NodeId>>(new Set());
          const activeBackgroundTurnItems = yield* Ref.make<
            ReadonlySet<OrchestrationV2TurnItem["id"]>
          >(new Set(inheritedBackgroundTurnItemsById.keys()));
          const openRunOwnedSubagents = yield* Ref.make(emptyOpenRunOwnedSubagentProjection());
          const finalizeRootRun = (
            terminal: ProviderTerminalEvent,
            // Whether the terminal's own failure item was stored. When storing
            // the terminal failed, the run's final write adds the item.
            failureItemPersisted = terminal.status === "failed",
          ) =>
            Effect.gen(function* () {
              if (yield* Ref.get(rootRunFinalized)) {
                return;
              }
              const providerThread = yield* Ref.get(latestProviderThread);
              const openSubagents = yield* Ref.get(openRunOwnedSubagents);
              const stillOpen = yield* Ref.get(activeBackgroundTurnItems);
              const openInheritedSubagents = inheritedBackgroundTurnItems.filter((route) =>
                stillOpen.has(route.id),
              );
              yield* writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread,
                attempt: input.attempt,
                ...(input.shouldFinalizeRun === undefined
                  ? {}
                  : {
                      shouldFinalizeRun: input.shouldFinalizeRun,
                      // Stop may commit between the ownership read and this
                      // terminal write. Gate the events and checkpoint together.
                      writeIfRunCurrent: {
                        activeAttemptId: input.attempt.id,
                        expectedStatus: "running" as const,
                      },
                    }),
                ...(input.hasUnpairedRunInterruptRequest === undefined
                  ? {}
                  : {
                      hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
                    }),
                ...(input.runInterruptRequest === undefined
                  ? {}
                  : { runInterruptRequest: input.runInterruptRequest }),
                openRunOwnedSubagents: openSubagents,
                openInheritedSubagents,
                terminal,
                failureItemPersisted,
                refreshAfterTurn,
              }).pipe(
                Effect.mapError(
                  (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                ),
              );
              if (isRunOwnedSubagentTerminalStatus(terminal.status)) {
                yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
              }
              yield* Ref.set(rootRunFinalized, true);
            });
          const trackChildLifecycle = (event: ProviderAdapterV2Event, deliverable: boolean) =>
            Effect.gen(function* () {
              const routing = yield* Ref.get(eventRouting);
              if (event.type === "provider_turn.updated") {
                const isRoot =
                  event.providerTurn.runAttemptId === input.attempt.id ||
                  event.providerTurn.id === routing.rootProviderTurnId;
                if (!isRoot) {
                  yield* Ref.update(activeChildProviderTurns, (current) => {
                    const next = new Set(current);
                    if (isTerminalProviderTurnStatus(event.providerTurn.status)) {
                      next.delete(event.providerTurn.id);
                    } else {
                      next.add(event.providerTurn.id);
                    }
                    return next;
                  });
                }
              }
              if (event.type === "subagent.updated") {
                const belongsToRootRun = event.subagent.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.subagent.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.subagent.threadId);
                if (belongsToRootRun || belongsToOwnedChildThread) {
                  yield* Ref.update(activeChildSubagents, (current) => {
                    const next = new Set(current);
                    if (isSettledSubagentStatus(event.subagent.status)) {
                      next.delete(event.subagent.id);
                    } else {
                      next.add(event.subagent.id);
                    }
                    return next;
                  });
                }
                // Snapshot run-owned subagents for interrupt cascade.
                // Preserve childThreadId linkage for the root-run lifetime even
                // after the subagent row terminalizes, so open child-thread
                // nodes can still be proven linked on a later root interrupt.
                if (belongsToRootRun) {
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const withLink = withLinkedChildThreadId(current, event.subagent.childThreadId);
                    const subagents = new Map(withLink.subagents);
                    if (isSettledSubagentStatus(event.subagent.status)) {
                      subagents.delete(event.subagent.id);
                    } else {
                      subagents.set(event.subagent.id, event.subagent);
                    }
                    return { ...withLink, subagents };
                  });
                }
              }
              if (event.type === "node.updated") {
                const belongsToRootSubagent =
                  event.node.kind === "subagent" && event.node.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.node.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.node.threadId);
                if (!belongsToRootSubagent && !belongsToOwnedChildThread) {
                  return;
                }
                yield* Ref.update(openRunOwnedSubagents, (current) => {
                  const nodes = new Map(current.nodes);
                  if (isOpenExecutionNodeStatus(event.node.status)) {
                    nodes.set(event.node.id, event.node);
                  } else {
                    nodes.delete(event.node.id);
                  }
                  return { ...current, nodes };
                });
              }
              if (event.type === "turn_item.updated") {
                const belongsToRootRun = event.turnItem.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.turnItem.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.turnItem.threadId);
                const belongsToInheritedBackgroundItem =
                  event.turnItem.threadId === input.run.threadId &&
                  event.turnItem.runId !== null &&
                  inheritedBackgroundTurnItemsById.get(event.turnItem.id) === event.turnItem.runId;
                if (
                  backgroundCapableTurnItemTypes.has(event.turnItem.type) &&
                  (belongsToRootRun ||
                    belongsToOwnedChildThread ||
                    belongsToInheritedBackgroundItem)
                ) {
                  yield* Ref.update(activeBackgroundTurnItems, (current) => {
                    const next = new Set(current);
                    if (isSettledTurnItemStatus(event.turnItem.status)) {
                      next.delete(event.turnItem.id);
                    } else {
                      next.add(event.turnItem.id);
                    }
                    return next;
                  });
                }
                if (belongsToOwnedChildThread && deliverable) {
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const childTurnItems = new Map(current.childTurnItems);
                    if (isSettledTurnItemStatus(event.turnItem.status)) {
                      childTurnItems.delete(event.turnItem.id);
                    } else {
                      childTurnItems.set(event.turnItem.id, event.turnItem);
                    }
                    return { ...current, childTurnItems };
                  });
                }
                if (belongsToRootRun && event.turnItem.type === "subagent") {
                  const subagentItem = event.turnItem;
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const withLink = withLinkedChildThreadId(current, subagentItem.childThreadId);
                    const turnItems = new Map(withLink.turnItems);
                    if (isSettledTurnItemStatus(subagentItem.status)) {
                      turnItems.delete(subagentItem.subagentId);
                    } else {
                      turnItems.set(subagentItem.subagentId, subagentItem);
                    }
                    return { ...withLink, turnItems };
                  });
                }
              }
            });
          const shouldStopProviderEventIngestion = Effect.gen(function* () {
            if (!(yield* Ref.get(rootTerminalSeen))) {
              return false;
            }
            const terminal = yield* Ref.get(terminalEvent);
            // Non-completed terminals drop background tracking immediately.
            if (terminal !== null && terminal.status !== "completed") {
              return true;
            }
            const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
            if (childProviderTurns.size > 0) {
              return false;
            }
            const childSubagents = yield* Ref.get(activeChildSubagents);
            if (childSubagents.size > 0) {
              return false;
            }
            // Keep ingesting past root settlement while background-capable
            // items owned by this run (or an owned child thread) are still
            // non-terminal, so their late completion events reach the
            // projection (stuck-spinner fix). Only for completed runs:
            // interrupted/failed turns intentionally drop background tracking
            // rather than pinning the stream open. Newly owned items depend on
            // adapters emitting a non-terminal event before the root terminal.
            // Exact inherited items are seeded from their selected durable rows.
            //
            // Owner loss (a newer run claimed lastRunOrdinal) must not close
            // this stream while these sets are non-empty: turn_item.updated
            // writes are not ownership-gated, so late completions still land.
            const backgroundItems = yield* Ref.get(activeBackgroundTurnItems);
            if (backgroundItems.size > 0) {
              return false;
            }
            // Owner loss means do not hold the stream open solely for the
            // roster probe; once background sets are empty, release.
            if (yield* Ref.get(providerThreadOwnerLost)) {
              return true;
            }
            // Claude background Bash has no turn-item projection. Keep the
            // stream open while this root's provider thread still reports
            // pending roster work so late empty updates can clear Waiting.
            // Use only the thread-scoped probe: session-wide pending work
            // (siblings, wake buffers, session subagents) must not pin this
            // root subscription. Session idle release still uses
            // hasPendingBackgroundWork via ProviderSessionManager.
            const latestProviderThreadSnapshot = yield* Ref.get(latestProviderThread);
            if (input.session.hasPendingBackgroundWorkForThread !== undefined) {
              const hasPendingWork = yield* input.session
                .hasPendingBackgroundWorkForThread(latestProviderThreadSnapshot)
                .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) {
                return false;
              }
            }
            return true;
          });
          // A run whose events cannot be stored is failed, but the provider
          // would go on working unobserved and hold its session busy, so
          // every later start would fail (October 24, 2026: disk full).
          const stopProviderTurnAfterIngestionFailure = (cause: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause) || (yield* Ref.get(rootTerminalSeen))) return;
              const providerTurnId = (yield* Ref.get(eventRouting)).rootProviderTurnId;
              if (providerTurnId === null) return;
              yield* Effect.logWarning(
                "orchestration V2 stopping the provider turn of a run whose events could not be stored",
                { runId: input.run.id, localStorage: isLocalStorageFailure(cause) },
              );
              const providerThread = yield* Ref.get(latestProviderThread);
              yield* input.session
                .interruptTurn({ providerThread, providerTurnId })
                .pipe(Effect.timeout(INGESTION_FAILURE_INTERRUPT_TIMEOUT));
            }).pipe(
              // Best effort: whatever goes wrong here, the run still settles.
              Effect.catchCause((interruptCause) =>
                Cause.hasInterruptsOnly(interruptCause)
                  ? Effect.interrupt
                  : Effect.logInfo(
                      "Could not stop the provider turn of a run whose events could not be stored",
                      { runId: input.run.id, ...providerFailureDiagnostics(interruptCause) },
                    ),
              ),
            );
          const filterAssistantEvent = makeAssistantStreamingFilter(responseStreamingMode);
          const ingestFailures = yield* Ref.make(0);
          // The run stays live for the liveness watchdog until this fiber ends,
          // however it ends; a run nobody reads events for is orphaned.
          const releaseIngestion = yield* liveness.acquire(input.run.id);
          const closeEventSubscription = yield* Effect.cached(eventSubscription.close);
          const providerEventFiber = yield* eventSubscription.events.pipe(
            Stream.filterEffect((event) =>
              Ref.modify(eventRouting, (state) => routeProviderEvent(event, routeIdentity, state)),
            ),
            Stream.tap((event) =>
              Effect.gen(function* () {
                let storedEventCount = 0;
                let stored = true;
                const deliveredEvent = filterAssistantEvent(
                  event,
                  DateTime.toEpochMillis(yield* DateTime.now),
                );
                if (deliveredEvent) {
                  // Root provider_thread.updated always uses an ownership gate:
                  // pre-terminal writeIfRunCurrent (attempt still running), or
                  // post-terminal writeIfProviderThreadOwner so late roster
                  // clears still land while this attempt owns the run and this
                  // run owns lastRunOrdinal.
                  const rootTerminalAlreadySeen = yield* Ref.get(rootTerminalSeen);
                  const isRootProviderThreadUpdate =
                    event.type === "provider_thread.updated" &&
                    event.providerThread.id === input.providerThread.id;
                  const storedEvents = yield* isolateIngestFailure(
                    providerEventIngestor.ingestNormalized({
                      analyticsContext: {
                        modelSelection: input.modelSelection,
                        runtimeMode: input.runtimePolicy.runtimeMode,
                        interactionMode: input.runtimePolicy.interactionMode,
                      },
                      providerSessionId: input.providerSessionId,
                      providerInstanceId: input.run.providerInstanceId,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      event: deliveredEvent,
                      ...(isRootProviderThreadUpdate
                        ? rootTerminalAlreadySeen
                          ? {
                              writeIfProviderThreadOwner: {
                                providerThreadId: input.providerThread.id,
                                runId: input.run.id,
                                activeAttemptId: input.attempt.id,
                                expectedLastRunOrdinal: input.run.ordinal,
                              },
                            }
                          : {
                              writeIfRunCurrent: {
                                runId: input.run.id,
                                activeAttemptId: input.attempt.id,
                                expectedStatus: "running" as const,
                              },
                            }
                        : {}),
                    }),
                    {
                      runId: input.run.id,
                      eventType: deliveredEvent.type,
                      consecutiveFailures: ingestFailures,
                    },
                  );
                  stored = Option.isSome(storedEvents);
                  storedEventCount = Option.isSome(storedEvents) ? storedEvents.value.length : 0;
                  if (
                    stored &&
                    isRootProviderThreadUpdate &&
                    rootTerminalAlreadySeen &&
                    storedEventCount === 0
                  ) {
                    // Ownership lost (or thread row missing). Stop pinning the
                    // stream on this run's background probe.
                    yield* Ref.set(providerThreadOwnerLost, true);
                  }
                }
                if (event.type === "provider_thread.updated") {
                  if (event.providerThread.id === input.providerThread.id && storedEventCount > 0) {
                    yield* Ref.set(latestProviderThread, event.providerThread);
                  }
                }
                if (
                  event.type === "turn_item.updated" &&
                  event.turnItem.providerTurnId ===
                    (yield* Ref.get(eventRouting)).rootProviderTurnId
                ) {
                  yield* Ref.update(latestTurnItemOrdinal, (current) =>
                    Math.max(current, event.turnItem.ordinal),
                  );
                }
                if (event.type === "turn.terminal") {
                  yield* Ref.set(terminalEvent, event);
                  yield* Ref.set(rootTerminalSeen, true);
                  yield* finalizeRootRun(event, event.status === "failed" && stored);
                }
                // An adapter that finds a subagent's process gone settles it
                // as an outage; its parent is told on its next turn.
                if (
                  storedEventCount > 0 &&
                  event.type === "subagent.updated" &&
                  event.subagent.status === "interrupted" &&
                  event.subagent.origin === "provider_native" &&
                  isOutageProgress(event.subagent.progress) &&
                  providerEventIngestor.noteLostSubagentWork !== undefined
                ) {
                  yield* providerEventIngestor
                    .noteLostSubagentWork({
                      threadId: event.subagent.threadId,
                      providerThreadId: input.providerThread.id,
                      work: [interruptedSubagentWork(event.subagent)],
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          "Could not tell the parent which subagents were interrupted",
                          { runId: input.run.id, cause: Cause.pretty(cause) },
                        ),
                      ),
                    );
                }
                yield* trackChildLifecycle(event, deliveredEvent !== null);
              }),
            ),
            Stream.takeUntilEffect(() => shouldStopProviderEventIngestion),
            Stream.runDrain,
            Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const terminal = yield* Ref.get(terminalEvent);
                if (terminal === null) {
                  return;
                }
                yield* finalizeRootRun(terminal);
              }),
            ),
            Effect.catchCause((cause) =>
              Ref.get(rootRunFinalized).pipe(
                Effect.flatMap((finalized) =>
                  Effect.logWarning("orchestration V2 provider event ingestion failed", {
                    runId: input.run.id,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.andThen(
                      finalized
                        ? Effect.void
                        : stopProviderTurnAfterIngestionFailure(cause).pipe(
                            Effect.andThen(Ref.get(latestProviderThread)),
                            Effect.flatMap((providerThread) =>
                              Ref.get(latestTurnItemOrdinal).pipe(
                                Effect.flatMap((latestItemOrdinal) =>
                                  Ref.get(openRunOwnedSubagents).pipe(
                                    Effect.flatMap((openSubagents) =>
                                      // A stream that breaks after a Stop still
                                      // unanswered (a model switch releases the
                                      // session) ends the run as stopped, not as
                                      // a provider error. Other failures stay failed.
                                      (isEventStreamBreak(cause) &&
                                      input.hasUnpairedRunInterruptRequest !== undefined
                                        ? input.hasUnpairedRunInterruptRequest()
                                        : Effect.succeed(false)
                                      ).pipe(
                                        Effect.flatMap((stopped) =>
                                          retryFinalWrite(
                                            writeFinalRunEvents({
                                              run: input.run,
                                              rootNode: input.rootNode,
                                              checkpointScope: input.checkpointScope,
                                              providerThread,
                                              attempt: input.attempt,
                                              // The failure may be the ownership
                                              // read itself, so check in the write.
                                              writeIfRunCurrent: {
                                                activeAttemptId: input.attempt.id,
                                                expectedStatus: "running",
                                              },
                                              ...(input.runInterruptRequest === undefined
                                                ? {}
                                                : {
                                                    runInterruptRequest: input.runInterruptRequest,
                                                  }),
                                              openRunOwnedSubagents: openSubagents,
                                              terminal: !stopped
                                                ? makeFailedTerminalEvent(
                                                    makeProviderFailure({
                                                      cause: Cause.squash(cause),
                                                      class: "unknown",
                                                    }),
                                                    latestItemOrdinal + 1,
                                                  )
                                                : makeInterruptedTerminalEvent(),
                                              failureItemPersisted: false,
                                              refreshAfterTurn,
                                            }),
                                            input.run.id,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                    ),
                    Effect.mapError(
                      (writeCause) =>
                        new RunExecutionIngestError({
                          runId: input.run.id,
                          cause: { ingest: cause, write: writeCause },
                        }),
                    ),
                  ),
                ),
              ),
            ),
            // Nothing joins this fiber, so a run it could not settle is logged
            // here; the liveness watchdog settles it once the fiber is gone.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("orchestration V2 run ingestion ended without settling its run", {
                    runId: input.run.id,
                    cause: Cause.pretty(cause),
                  }),
            ),
            Effect.ensuring(closeEventSubscription),
            // Its own finalizer: a close that dies must not leave the run
            // looking driven forever.
            Effect.ensuring(releaseIngestion),
            Effect.forkDetach,
          );
          // A fiber interrupted before it first runs skips its finalizers, so
          // stopping it also closes the subscription and releases the run.
          // Both happen once however many paths stop it.
          const stopIngestion = Fiber.interrupt(providerEventFiber).pipe(
            Effect.ensuring(closeEventSubscription),
            Effect.ensuring(releaseIngestion),
          );

          // The start can be interrupted from outside (the provider-start
          // timeout, a Stop), and catchCause below does not see that. Stop the
          // ingestion fiber then, or it keeps its subscription and liveness.
          yield* Effect.gen(function* () {
            // A failed read fails the start below, so the run is recorded as
            // failed instead of staying active with no provider turn.
            const shouldStart =
              input.shouldStartProviderTurn === undefined
                ? Exit.succeed(true)
                : yield* Effect.exit(input.shouldStartProviderTurn());
            if (Exit.isSuccess(shouldStart) && !shouldStart.value) {
              yield* stopIngestion;
              return;
            }

            const stillWantsProviderTurn =
              input.shouldStartProviderTurn === undefined
                ? Effect.succeed(true)
                : input.shouldStartProviderTurn().pipe(Effect.orElseSucceed(() => false));
            // The provider is still running an earlier turn. One no live run
            // owns (its run failed or stopped while the provider went on) is
            // stopped, and the start retried until the provider lets go;
            // otherwise the start fails as previous_turn_active.
            const startAfterOrphanedProviderTurn = <E>(
              error: E,
              retryStart: Effect.Effect<void, E>,
            ) =>
              Effect.gen(function* () {
                const providerTurnId = previousActiveProviderTurn(error) ?? null;
                const owned =
                  providerTurnId === null || input.previousTurnOwnedByLiveRun === undefined
                    ? ("unknown" as const)
                    : yield* input.previousTurnOwnedByLiveRun(providerTurnId);
                yield* Effect.logWarning(
                  "orchestration V2 provider is still running a previous turn",
                  {
                    runId: input.run.id,
                    ownedByLiveRun: owned,
                  },
                );
                if (owned === true) {
                  // No prompt was offered. Release this attempt atomically and
                  // keep the same message/run at the front of the waiting queue.
                  // The normal queue reactor observes this queued transition too,
                  // covering an owner that ended before the requeue committed.
                  yield* stopIngestion;
                  const now = yield* DateTime.now;
                  const nextAttemptId = idAllocator.derive.runAttempt({
                    runId: input.run.id,
                    attemptOrdinal: input.attempt.attemptOrdinal + 1,
                  });
                  yield* eventSink
                    .writeIfRunCurrent({
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      activeAttemptId: input.attempt.id,
                      expectedStatus: "running",
                      events: [
                        {
                          id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                          type: "run-attempt.updated",
                          threadId: input.run.threadId,
                          runId: input.run.id,
                          occurredAt: now,
                          payload: { ...input.attempt, status: "cancelled", completedAt: now },
                        },
                        {
                          id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                          type: "run-attempt.updated",
                          threadId: input.run.threadId,
                          runId: input.run.id,
                          occurredAt: now,
                          payload: {
                            ...input.attempt,
                            id: nextAttemptId,
                            attemptOrdinal: input.attempt.attemptOrdinal + 1,
                            status: "pending",
                            providerTurnId: null,
                            startedAt: null,
                            completedAt: null,
                          },
                        },
                        {
                          id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                          type: "node.updated",
                          threadId: input.run.threadId,
                          runId: input.run.id,
                          occurredAt: now,
                          payload: {
                            ...input.rootNode,
                            status: "pending",
                            providerTurnId: null,
                            startedAt: null,
                            completedAt: null,
                          },
                        },
                        {
                          id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                          type: "run.updated",
                          threadId: input.run.threadId,
                          runId: input.run.id,
                          occurredAt: now,
                          payload: {
                            ...input.run,
                            status: "queued",
                            queuePosition: 1,
                            activeAttemptId: nextAttemptId,
                            startedAt: null,
                            completedAt: null,
                          },
                        },
                      ],
                      effects: [],
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new RunExecutionStartError({
                            commandId: input.commandId,
                            runId: input.run.id,
                            cause,
                          }),
                      ),
                    );
                  return;
                }
                if (owned !== false || providerTurnId === null) return yield* Effect.fail(error);
                yield* Effect.suspend(() =>
                  input.session.interruptTurn({
                    providerThread: input.providerThread,
                    providerTurnId,
                  }),
                ).pipe(
                  Effect.timeout(ORPHANED_TURN_INTERRUPT_TIMEOUT),
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.interrupt
                      : Effect.logInfo("Could not stop the provider's previous turn", {
                          runId: input.run.id,
                          ...providerFailureDiagnostics(cause),
                        }),
                  ),
                );
                return yield* retryStart.pipe(
                  Effect.retry({
                    times: ORPHANED_TURN_CLEAR_POLLS,
                    schedule: Schedule.spaced(ORPHANED_TURN_CLEAR_POLL),
                    // A Stop meanwhile ends the wait.
                    while: (retryError) =>
                      isPreviousTurnActiveFailure(retryError)
                        ? stillWantsProviderTurn
                        : Effect.succeed(false),
                  }),
                );
              });

            // Keep the active turn's MCP credential valid between browser calls.
            yield* McpSessionRegistry.touchActiveMcpThread(input.run.threadId);
            const turnInput = {
              appThread: input.appThread,
              threadId: input.run.threadId,
              runId: input.run.id,
              runOrdinal: input.run.ordinal,
              providerTurnOrdinal: input.providerTurnOrdinal,
              ...(input.nativeThreadHasTurns === undefined
                ? {}
                : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
              ...(input.run.restartContinuationOfRunId === undefined
                ? {}
                : {
                    restartContinuationOfRunId: input.run.restartContinuationOfRunId,
                  }),
              attemptId: input.attemptId,
              rootNodeId: input.rootNode.id,
              providerThread: input.providerThread,
              message: input.message,
              modelSelection: input.modelSelection,
              runtimePolicy: input.runtimePolicy,
            };
            const compact =
              input.message.attachments.length === 0 &&
              input.message.text.trim().toLowerCase() === "/compact";
            const prepareTurn = Effect.gen(function* () {
              const events = yield* input.session.prepareTurn?.(turnInput) ?? Effect.succeed([]);
              for (const event of events) {
                yield* providerEventIngestor.ingestNormalized({
                  analyticsContext: {
                    modelSelection: input.modelSelection,
                    runtimeMode: input.runtimePolicy.runtimeMode,
                    interactionMode: input.runtimePolicy.interactionMode,
                  },
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: input.run.providerInstanceId,
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  nodeId: input.rootNode.id,
                  event,
                });
                if (
                  event.type === "subagent.updated" &&
                  event.subagent.status === "interrupted" &&
                  isOutageProgress(event.subagent.progress)
                ) {
                  yield* (
                    providerEventIngestor.noteLostSubagentWork?.({
                      threadId: event.subagent.threadId,
                      providerThreadId: input.providerThread.id,
                      work: [interruptedSubagentWork(event.subagent)],
                      beforeRunId: input.run.id,
                    }) ?? Effect.void
                  );
                }
              }
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: input.session.driver,
                    threadId: input.run.threadId,
                    providerThreadId: input.providerThread.id,
                    runId: input.run.id,
                    cause,
                  }),
              ),
            );
            const preparedStart = prepareTurn.pipe(
              Effect.andThen(input.session.startTurn(turnInput)),
            );
            const startTurn = compact
              ? (input.session.compactThread?.(turnInput) ??
                Effect.fail(
                  new ProviderAdapterTurnStartError({
                    driver: input.session.driver,
                    threadId: input.run.threadId,
                    providerThreadId: input.providerThread.id,
                    runId: input.run.id,
                    cause: "This provider does not support context compaction.",
                  }),
                ))
              : preparedStart.pipe(
                  Effect.retry({
                    // A credit submission admits exactly one request, so it is never resent.
                    times:
                      input.run.manualCodexCreditIntent === undefined
                        ? TRANSIENT_TURN_START_RETRIES
                        : 0,
                    schedule: Schedule.spaced(TRANSIENT_TURN_START_RETRY_DELAY),
                    // Recheck the run after Stop before each resend.
                    while: (error) =>
                      !isTransientTurnStartFailure(error)
                        ? Effect.succeed(false)
                        : stillWantsProviderTurn,
                  }),
                  Effect.catchIf(isPreviousTurnActiveFailure, (error) =>
                    startAfterOrphanedProviderTurn(error, preparedStart),
                  ),
                );
            yield* Effect.andThen(shouldStart, startTurn).pipe(
              Effect.catchCause((cause) =>
                logProviderTurnStartFailure(input.run.id, cause).pipe(
                  Effect.andThen(stopIngestion),
                  Effect.andThen(Ref.get(latestProviderThread)),
                  Effect.flatMap((providerThread) =>
                    Ref.get(latestTurnItemOrdinal).pipe(
                      Effect.flatMap((latestItemOrdinal) =>
                        Ref.get(openRunOwnedSubagents).pipe(
                          Effect.flatMap((openSubagents) =>
                            writeFinalRunEvents({
                              run: input.run,
                              rootNode: input.rootNode,
                              checkpointScope: input.checkpointScope,
                              providerThread,
                              attempt: input.attempt,
                              // Checked in the write transaction, not by another
                              // read that can fail like the one before the start.
                              writeIfRunCurrent: {
                                activeAttemptId: input.attempt.id,
                                expectedStatus: "running",
                              },
                              openRunOwnedSubagents: openSubagents,
                              terminal: makeFailedTerminalEvent(
                                makeProviderFailure({
                                  cause: Cause.squash(cause),
                                  // A failed ownership read is not the provider's fault.
                                  class: Exit.isFailure(shouldStart) ? "unknown" : "provider_error",
                                }),
                                latestItemOrdinal + 1,
                              ),
                              failureItemPersisted: false,
                              refreshAfterTurn,
                            }),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Effect.mapError(
                    (writeCause) =>
                      new RunExecutionStartError({
                        commandId: input.commandId,
                        runId: input.run.id,
                        cause: { start: cause, write: writeCause },
                      }),
                  ),
                ),
              ),
            );
          }).pipe(Effect.onInterrupt(() => stopIngestion));
        }).pipe((start) => liveness.hold(input.run.id, start)),
    } satisfies RunExecutionServiceV2Shape);
  }),
);

/** Whether an ingestion failure is the provider event stream breaking. */
export function isEventStreamBreak(cause: Cause.Cause<unknown>): boolean {
  let current: unknown = Cause.squash(cause);
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if ((current as { readonly _tag?: unknown })._tag === "ProviderAdapterEventStreamError") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/** A run's latest Stop request: who asked, and the reason it gave. */
export type RunInterruptRequest = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "run_interrupt_request" }>,
  "cause" | "message"
>;

/**
 * Who asked to stop `runId`, from its latest Stop request: a request with no
 * cause predates causes and was the user's; no request at all is null.
 */
export function runInterruptRequestCause(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: OrchestrationV2Run["id"],
): OrchestrationV2RunInterruptCause | null {
  const request = latestRunInterruptRequest(turnItems, runId);
  return request === null || stopIntent(request) === "system" ? null : (request.cause ?? "user");
}

/** `runId`'s latest Stop request, or null when nobody asked to stop it. */
export function latestRunInterruptRequest(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: OrchestrationV2Run["id"],
): Extract<OrchestrationV2TurnItem, { type: "run_interrupt_request" }> | null {
  return (
    turnItems.findLast(
      (item): item is Extract<OrchestrationV2TurnItem, { type: "run_interrupt_request" }> =>
        item.type === "run_interrupt_request" && item.runId === runId,
    ) ?? null
  );
}

/** The run's latest Stop request when a person asked for it (older requests have no cause). */
export function userInterruptRequest(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: OrchestrationV2Run["id"],
): Extract<OrchestrationV2TurnItem, { type: "run_interrupt_request" }> | undefined {
  const request = turnItems.findLast(
    (item): item is Extract<OrchestrationV2TurnItem, { type: "run_interrupt_request" }> =>
      item.type === "run_interrupt_request" && item.runId === runId,
  );
  return request !== undefined && stopIntent(request) === "person" ? request : undefined;
}

export function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly completedAt: DateTime.Utc;
  /** The run's Stop request cause, or null when none was recorded. */
  readonly cause: OrchestrationV2RunInterruptCause | null;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message: runInterruptResultMessage(input.cause),
    ...(input.cause === null ? {} : { cause: input.cause }),
  };
}
