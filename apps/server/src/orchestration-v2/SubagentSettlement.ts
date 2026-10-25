import {
  PROVIDER_DISPLAY_NAMES,
  type EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2RunInterruptCause,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderThreadId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { runRanAfter } from "@specweave-studio/shared/orchestrationV2ThreadError";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  interruptedSubagentWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";
import { cancelledForUpdate } from "./RestartQueueHold.ts";
import { SYSTEM_INTERRUPT_REASONS } from "./systemInterruptReasons.ts";

/**
 * Settles provider-native subagent state that no provider process will ever
 * report on: the parent's `subagents[]` row, its `subagent` turn item, their
 * nodes, and the child thread's runless root turn with its open items. Every
 * reconciler (restart recovery, Stop, the stranded sweep) builds its events
 * here, so they settle the same records the same way.
 */

type TurnItem = OrchestrationV2TurnItem;
type SubagentTurnItem = Extract<TurnItem, { readonly type: "subagent" }>;
type Work = OrchestrationV2RestartCancelledBackgroundWork;

export type SubagentSettlementProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "nodes" | "subagents" | "turnItems" | "providerThreads"
>;

/**
 * `cancelled` for a stop someone asked for; `interrupted` for an outage;
 * `failed` only where a failed run keeps its own status for its subagents.
 */
export type SubagentSettlementStatus = "cancelled" | "interrupted" | "failed";

export const PERSON_STOP_PROGRESS = "Stopped by you";
export const AGENT_STOP_PROGRESS = "Stopped by an agent";

function providerName(driver: string | null | undefined): string {
  if (driver == null) return "the provider";
  return PROVIDER_DISPLAY_NAMES[driver as ProviderDriverKind] ?? "the provider";
}

/** What an outage-settled subagent says ended it, from the parent's failure. */
export function outageProgress(input: {
  readonly driver: string | null | undefined;
  readonly failureClass: string | null | undefined;
}): string {
  const name = providerName(input.driver);
  switch (input.failureClass) {
    case "usage_limit":
      return `Stopped when ${name}'s usage limit ended the parent's session`;
    case "transport_error":
    case "provider_error":
      return `Stopped when ${name} failed and ended the parent's session`;
    case "service_update":
      return "Stopped when SpecWithCode restarted for an update";
    default:
      return "Stopped when the provider session ended";
  }
}

/**
 * Who a Stop request came from, for the subagents it ends. The server's own
 * interrupts (watchdog, start timeout) carry no cause, like an older person's
 * Stop, so their reason tells them apart. Not a wire value: older peers decode
 * `cause` as a closed set, so this maps from the existing causes.
 */
export type StopIntent = "person" | "agent" | "service_update" | "system";

export function stopIntent(
  request:
    | {
        readonly cause?: OrchestrationV2RunInterruptCause | undefined;
        readonly message?: string | undefined;
      }
    | null
    | undefined,
): StopIntent | null {
  if (request == null) return null;
  if (
    request.cause === undefined &&
    request.message !== undefined &&
    SYSTEM_INTERRUPT_REASONS.has(request.message)
  ) {
    return "system";
  }
  switch (request.cause ?? "user") {
    case "user":
      return "person";
    case "agent":
    case "delegated_cancel":
      return "agent";
    case "service_update":
      return "service_update";
  }
}

/**
 * How a Stop settles the subagents it ends. Only a person's Stop is final
 * ("Stopped by you"); an agent's says so; an update or the server's own
 * interrupt is an outage the parent is told about.
 */
export function stopSettlement(
  intent: StopIntent,
  driver: string | null | undefined,
): {
  readonly status: "cancelled" | "interrupted";
  readonly progress: string;
  readonly outage: boolean;
} {
  switch (intent) {
    case "person":
      return { status: "cancelled", progress: PERSON_STOP_PROGRESS, outage: false };
    case "agent":
      return { status: "cancelled", progress: AGENT_STOP_PROGRESS, outage: false };
    case "service_update":
      return {
        status: "interrupted",
        progress: outageProgress({ driver, failureClass: "service_update" }),
        outage: true,
      };
    case "system":
      return {
        status: "interrupted",
        progress: outageProgress({ driver, failureClass: null }),
        outage: true,
      };
  }
}

/** Whether a subagent's progress is an outage settlement's (see `outageProgress`). */
export function isOutageProgress(progress: string | undefined): boolean {
  return progress?.startsWith("Stopped when ") === true;
}

export function isOpenWorkStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

/**
 * A delegate_task child. Its own thread is reconciled and continued on its own
 * and reports back through the app, so it is not provider background work.
 */
export function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
}): boolean {
  return task.origin === "app_owned" && task.childThreadId !== null;
}

export function isAppOwnedDelegationItem(item: TurnItem): boolean {
  return item.type === "subagent" && isAppOwnedDelegation(item);
}

/**
 * Resolve providerInstanceId for a stale background-capable turn item whose
 * run is missing/null (or not found). Prefer an existing run, then a subagent
 * item's own instance id, then the item's provider thread, then a last-resort
 * first provider thread, then the thread's selected provider.
 */
function staleItemProviderInstanceId(
  item: TurnItem,
  projection: SubagentSettlementProjection,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) return run.providerInstanceId;
  }
  if (item.type === "subagent") return item.providerInstanceId;
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) return providerThread.providerInstanceId;
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

interface SettlementInput<E> {
  readonly projection: SubagentSettlementProjection;
  readonly status: SubagentSettlementStatus;
  /** Shown on settled subagent rows and items; omitted leaves their progress. */
  readonly progress?: string | undefined;
  readonly now: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
  /** Nodes already settled by this reconcile; shared so none is settled twice. */
  readonly settledNodeIds: Set<string>;
}

const withProgress = (progress: string | undefined) => (progress === undefined ? {} : { progress });

/**
 * Closes open background-capable turn items, each with its node and, for a
 * subagent item, the linked subagent row and node. Matching the exact linked
 * id means a subagent that already finished is never overwritten.
 */
export const settleStaleBackgroundItems = <E>(
  input: SettlementInput<E> & { readonly items: ReadonlyArray<TurnItem> },
): Effect.Effect<
  {
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  },
  E
> =>
  Effect.gen(function* () {
    const { projection, now } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const subagents: Array<OrchestrationV2Subagent> = [];
    for (const item of input.items) {
      const providerInstanceId = staleItemProviderInstanceId(item, projection);
      const runScope = item.runId === null ? {} : { runId: item.runId };
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: projection.thread.id,
        ...runScope,
        ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...item,
          status: input.status,
          completedAt: now,
          updatedAt: now,
          ...(item.type === "subagent" ? withProgress(input.progress) : {}),
        },
      });
      if (item.nodeId !== null && item.nodeId !== undefined) {
        const node = projection.nodes.find(
          (candidate) => candidate.id === item.nodeId && isOpenWorkStatus(candidate.status),
        );
        if (node !== undefined && !input.settledNodeIds.has(node.id)) {
          input.settledNodeIds.add(node.id);
          events.push({
            id: yield* input.allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            ...runScope,
            nodeId: node.id,
            providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: input.status, completedAt: now },
          });
        }
      }
      if (item.type !== "subagent") continue;
      // Cancelling only the turn item would leave the linked subagent entity
      // non-terminal forever, since the dead provider process can no longer
      // emit its terminal event.
      const subagent = projection.subagents.find(
        (candidate) => candidate.id === item.subagentId && isOpenWorkStatus(candidate.status),
      );
      if (subagent !== undefined) {
        subagents.push(subagent);
        events.push({
          id: yield* input.allocateEventId(),
          type: "subagent.updated",
          threadId: projection.thread.id,
          ...runScope,
          nodeId: subagent.id,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          occurredAt: now,
          payload: {
            ...subagent,
            status: input.status,
            ...withProgress(input.progress),
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      const subagentNode = projection.nodes.find(
        (candidate) => candidate.id === item.subagentId && isOpenWorkStatus(candidate.status),
      );
      if (subagentNode !== undefined && !input.settledNodeIds.has(subagentNode.id)) {
        input.settledNodeIds.add(subagentNode.id);
        events.push({
          id: yield* input.allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          ...runScope,
          nodeId: subagentNode.id,
          providerInstanceId,
          occurredAt: now,
          payload: { ...subagentNode, status: input.status, completedAt: now },
        });
      }
    }
    return { events, subagents };
  });

/** Closes open subagent rows whose turn item is already settled, with their nodes. */
export const settleOpenSubagentRows = <E>(
  input: SettlementInput<E> & { readonly rows: ReadonlyArray<OrchestrationV2Subagent> },
): Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E> =>
  Effect.gen(function* () {
    const { projection, now } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const row of input.rows) {
      const runScope = row.runId === null ? {} : { runId: row.runId };
      events.push({
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        threadId: projection.thread.id,
        ...runScope,
        nodeId: row.id,
        driver: row.driver,
        providerInstanceId: row.providerInstanceId,
        occurredAt: now,
        payload: {
          ...row,
          status: input.status,
          ...withProgress(input.progress),
          completedAt: now,
          updatedAt: now,
        },
      });
      const node = projection.nodes.find(
        (candidate) => candidate.id === row.id && isOpenWorkStatus(candidate.status),
      );
      if (node !== undefined && !input.settledNodeIds.has(node.id)) {
        input.settledNodeIds.add(node.id);
        events.push({
          id: yield* input.allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          ...runScope,
          nodeId: node.id,
          providerInstanceId: row.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: input.status, completedAt: now },
        });
      }
    }
    return events;
  });

/**
 * A provider-native subagent thread has no runs: its work is a runless root
 * turn, plus items under it (Claude's live progress item), that only the dead
 * provider process could settle. Left running, the child would show as
 * working forever.
 */
export const settleRunlessRootTurns = <E>(
  input: Omit<SettlementInput<E>, "progress" | "status"> & {
    /** `completed` when the child's parent row already reports it finished. */
    readonly status: SubagentSettlementStatus | "completed";
    readonly settledItemIds: Set<string>;
  },
): Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E> =>
  Effect.gen(function* () {
    const { projection, now } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const node of projection.nodes) {
      if (node.kind !== "root_turn" || node.runId !== null) continue;
      if (isOpenWorkStatus(node.status) && !input.settledNodeIds.has(node.id)) {
        input.settledNodeIds.add(node.id);
        events.push({
          id: yield* input.allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          nodeId: node.id,
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: input.status, completedAt: now },
        });
      }
      // A terminal root can still own open progress or tools from its dead
      // process. Settle those items without rewriting the root or its result.
      for (const item of projection.turnItems) {
        if (
          item.nodeId !== node.id ||
          item.runId !== null ||
          !isOpenWorkStatus(item.status) ||
          input.settledItemIds.has(item.id)
        ) {
          continue;
        }
        input.settledItemIds.add(item.id);
        events.push({
          id: yield* input.allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          nodeId: node.id,
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...item,
            status: input.status,
            completedAt: now,
            updatedAt: now,
            ...(item.type === "reasoning" || item.type === "assistant_message"
              ? { streaming: false }
              : {}),
          },
        });
      }
    }
    return events;
  });

/** Which open native subagent work a settlement may end. */
export interface NativeSubagentScope {
  /** Only work of runs up to this ordinal, plus work with no run. */
  readonly throughRunOrdinal?: number;
  /** Only work on these provider threads. */
  readonly providerThreadIds?: ReadonlySet<ProviderThreadId>;
}

export interface OpenNativeSubagentWork {
  readonly items: ReadonlyArray<SubagentTurnItem>;
  /** Open rows with no open item of their own. */
  readonly rows: ReadonlyArray<OrchestrationV2Subagent>;
}

/** The provider thread whose process ran a subagent: its item's, else its run's. */
export function subagentProviderThreadId(
  projection: Pick<SubagentSettlementProjection, "runs" | "turnItems">,
  subagent: Pick<OrchestrationV2Subagent, "id" | "runId" | "providerThreadId">,
): ProviderThreadId | null {
  const item = projection.turnItems.find(
    (candidate) => candidate.type === "subagent" && candidate.subagentId === subagent.id,
  );
  return (
    item?.providerThreadId ??
    subagent.providerThreadId ??
    projection.runs.find((run) => run.id === subagent.runId)?.providerThreadId ??
    null
  );
}

/** Open provider-native subagent rows and items in scope; delegated tasks never count. */
export function openNativeSubagentWork(
  projection: Pick<SubagentSettlementProjection, "runs" | "turnItems" | "subagents">,
  scope: NativeSubagentScope = {},
): OpenNativeSubagentWork {
  const ordinals = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  const inRuns = (runId: string | null) => {
    if (scope.throughRunOrdinal === undefined || runId === null) return true;
    const ordinal = ordinals.get(runId as never);
    return ordinal === undefined || ordinal <= scope.throughRunOrdinal;
  };
  const onThreads = (providerThreadId: ProviderThreadId | null) =>
    scope.providerThreadIds === undefined ||
    (providerThreadId !== null && scope.providerThreadIds.has(providerThreadId));
  const items = projection.turnItems.filter(
    (item): item is SubagentTurnItem =>
      item.type === "subagent" &&
      isOpenWorkStatus(item.status) &&
      !isAppOwnedDelegation(item) &&
      inRuns(item.runId) &&
      onThreads(item.providerThreadId ?? null),
  );
  const covered = new Set(items.map((item) => item.subagentId));
  const rows = projection.subagents.filter(
    (row) =>
      row.origin === "provider_native" &&
      isOpenWorkStatus(row.status) &&
      !covered.has(row.id) &&
      inRuns(row.runId) &&
      onThreads(subagentProviderThreadId(projection, row)),
  );
  return { items, rows };
}

export interface NativeSubagentSettlement {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  /** What the parent is told it lost, keyed by the provider thread that lost it. */
  readonly lostWork: ReadonlyMap<ProviderThreadId, ReadonlyArray<Work>>;
  /** Child threads whose runless root turns now need settling too. */
  readonly childThreadIds: ReadonlyArray<ThreadId>;
}

/**
 * Settles the open native subagent rows and items in scope on one parent
 * thread. Only an outage (`interrupted`) is reported to the parent as lost
 * work: a stop someone asked for is final, so nothing is offered to rerun.
 */
export const settleNativeSubagents = <E>(
  input: Omit<SettlementInput<E>, "settledNodeIds"> & {
    readonly scope?: NativeSubagentScope;
    readonly settledNodeIds?: Set<string>;
  },
): Effect.Effect<NativeSubagentSettlement, E> =>
  Effect.gen(function* () {
    const settledNodeIds = input.settledNodeIds ?? new Set<string>();
    const open = openNativeSubagentWork(input.projection, input.scope);
    const fromItems = yield* settleStaleBackgroundItems({
      ...input,
      settledNodeIds,
      items: open.items,
    });
    const fromRows = yield* settleOpenSubagentRows({ ...input, settledNodeIds, rows: open.rows });
    const lostWork = new Map<ProviderThreadId, ReadonlyArray<Work>>();
    const childThreadIds = new Set<ThreadId>();
    const settled = [
      ...open.items.map((item) => ({
        id: item.subagentId,
        title: item.title,
        prompt: item.prompt,
        childThreadId: item.childThreadId,
        providerThreadId: item.providerThreadId ?? null,
        runId: item.runId,
      })),
      ...open.rows.map((row) => ({
        id: row.id,
        title: row.title,
        prompt: row.prompt,
        childThreadId: row.childThreadId,
        providerThreadId: subagentProviderThreadId(input.projection, row),
        runId: row.runId,
      })),
    ];
    for (const subagent of settled) {
      if (subagent.childThreadId !== null) childThreadIds.add(subagent.childThreadId);
      if (input.status !== "interrupted" || subagent.providerThreadId === null) continue;
      lostWork.set(
        subagent.providerThreadId,
        mergeRestartCancelledBackgroundWork(lostWork.get(subagent.providerThreadId) ?? [], [
          interruptedSubagentWork(subagent),
        ]),
      );
    }
    for (const subagent of fromItems.subagents) {
      if (subagent.childThreadId !== null) childThreadIds.add(subagent.childThreadId);
    }
    return {
      events: [...fromItems.events, ...fromRows],
      lostWork,
      childThreadIds: [...childThreadIds],
    };
  });

/**
 * A provider thread's latest started run: the last turn that provider saw.
 * Lost background work is recorded on it, and the next run on the same
 * provider thread delivers it with its input.
 */
export function latestStartedRun(
  runs: OrchestrationV2ThreadProjection["runs"],
  providerThreadId: ProviderThreadId,
): OrchestrationV2ThreadProjection["runs"][number] | undefined {
  return runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      !cancelledForUpdate(run) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

/**
 * The note events for lost work: each provider thread's latest started run
 * records it once (merged by id), so repeating a settlement adds nothing.
 */
export const lostWorkNoteEvents = <E>(input: {
  readonly projection: Pick<SubagentSettlementProjection, "thread" | "runs">;
  readonly lostWork: ReadonlyMap<ProviderThreadId, ReadonlyArray<Work>>;
  /** If loss is discovered in preparation, the prompt has not been offered yet. */
  readonly beforeRunId?: string | null | undefined;
  readonly now: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}): Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E> =>
  Effect.gen(function* () {
    const events: Array<OrchestrationV2DomainEvent> = [];
    // Work a run already records was noted once; another settlement of the
    // same subagent (a second sweep, a restart) must not tell it again.
    const noted = new Set(
      input.projection.runs.flatMap((run) =>
        (run.restartCancelledBackgroundWork ?? []).flatMap((entry) =>
          entry.id === undefined ? [] : [entry.id],
        ),
      ),
    );
    for (const [providerThreadId, lost] of input.lostWork) {
      // Delivery starts after discovery, not after the child's launch. A turn
      // completed before discovery could not have told the parent about it.
      const beforeRun = input.projection.runs.find((run) => run.id === input.beforeRunId);
      const noteRun = latestStartedRun(
        beforeRun === undefined
          ? input.projection.runs
          : input.projection.runs.filter((run) => runRanAfter(beforeRun, run)),
        providerThreadId,
      );
      if (noteRun === undefined) continue;
      const work = lost.filter((entry) => entry.id === undefined || !noted.has(entry.id));
      const current = noteRun.restartCancelledBackgroundWork ?? [];
      const merged = mergeRestartCancelledBackgroundWork(current, work);
      if (merged.length === current.length) continue;
      // Its own event: a run snapshot read before this commit could regress
      // a lifecycle change (e.g. a checkpoint completing the run) made since.
      events.push({
        id: yield* input.allocateEventId(),
        type: "run.background-work-cancelled",
        threadId: input.projection.thread.id,
        runId: noteRun.id,
        providerInstanceId: noteRun.providerInstanceId,
        occurredAt: input.now,
        payload: { runId: noteRun.id, restartCancelledBackgroundWork: merged },
      });
    }
    return events;
  });

/** Open background-capable items PRRS treats as stale: not delegated, not on the given runs. */
export function staleBackgroundItems(
  turnItems: ReadonlyArray<TurnItem>,
  skipRunIds: ReadonlySet<string>,
): ReadonlyArray<TurnItem> {
  return turnItems.filter(
    (item) =>
      !(item.runId !== null && skipRunIds.has(item.runId)) &&
      isBackgroundCapableTurnItemType(item.type) &&
      isOpenWorkStatus(item.status) &&
      !isAppOwnedDelegationItem(item),
  );
}
