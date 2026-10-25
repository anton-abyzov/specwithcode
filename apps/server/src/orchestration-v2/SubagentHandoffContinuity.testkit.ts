import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as StrandedSubagents from "./StrandedSubagents.ts";
import { isOpenWorkStatus } from "./SubagentSettlement.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instance = ProviderInstanceId.make("claudeAgent");
export const PARENT = ThreadId.make("thread_stranded_parent");
export const PROVIDER_THREAD = ProviderThreadId.make("provider_thread_stranded");
export const SESSION = ProviderSessionId.make("provider_session_stranded");
export const at = (minute: number) =>
  DateTime.add(DateTime.makeUnsafe("2026-10-24T10:00:00.000Z"), { minutes: minute });

type Projection = OrchestrationV2ThreadProjection;
type Mutable = { -readonly [K in keyof Projection]: Projection[K] };

export function thread(id: ThreadId, parent: ThreadId | null = null, creationSource = "user") {
  return {
    id,
    deletedAt: null,
    providerInstanceId: instance,
    creationSource,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : "subagent",
      rootThreadId: PARENT,
    },
  };
}

export function run(
  id: string,
  ordinal: number,
  status: string,
  extra: Record<string, unknown> = {},
): Projection["runs"][number] {
  return {
    id: RunId.make(id),
    ordinal,
    status,
    providerThreadId: PROVIDER_THREAD,
    providerInstanceId: instance,
    rootNodeId: NodeId.make(`root:${id}`),
    completedAt: status === "running" ? null : at(ordinal),
    ...extra,
  } as never;
}

/** A native subagent: its parent row, node and turn item, plus its child thread's root turn. */
export function native(id: string, runId: string, childThreadId: ThreadId | null = null) {
  const nodeId = NodeId.make(id);
  return {
    row: {
      id: nodeId,
      runId: RunId.make(runId),
      origin: "provider_native",
      childThreadId,
      providerThreadId: PROVIDER_THREAD,
      driver,
      providerInstanceId: instance,
      title: `Task ${id}`,
      prompt: `Do ${id}`,
      status: "running",
    },
    node: { id: nodeId, runId: RunId.make(runId), kind: "subagent", status: "running" },
    item: {
      id: TurnItemId.make(`item:${id}`),
      runId: RunId.make(runId),
      nodeId,
      providerThreadId: PROVIDER_THREAD,
      type: "subagent",
      status: "running",
      subagentId: nodeId,
      origin: "provider_native",
      childThreadId,
      providerInstanceId: instance,
      title: `Task ${id}`,
      prompt: `Do ${id}`,
    },
  };
}

export function projection(input: {
  readonly thread: ReturnType<typeof thread>;
  readonly runs?: ReadonlyArray<Projection["runs"][number]>;
  readonly subagents?: ReadonlyArray<ReturnType<typeof native>>;
  readonly extraRows?: ReadonlyArray<unknown>;
  readonly extraItems?: ReadonlyArray<unknown>;
  readonly nodes?: ReadonlyArray<unknown>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly sessionId?: ProviderSessionId | null;
}): Mutable {
  const subagents = input.subagents ?? [];
  return {
    thread: input.thread,
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [
      {
        id: PROVIDER_THREAD,
        driver,
        providerInstanceId: instance,
        providerSessionId: input.sessionId === undefined ? SESSION : input.sessionId,
        status: "idle",
        pendingBackgroundTasks: [],
      },
    ],
    providerTurns: [],
    runs: input.runs ?? [],
    attempts: [],
    nodes: [...subagents.map((entry) => entry.node), ...(input.nodes ?? [])],
    subagents: [...subagents.map((entry) => entry.row), ...(input.extraRows ?? [])],
    messages: [],
    turnItems: [
      ...subagents.map((entry) => entry.item),
      ...(input.extraItems ?? []),
      ...(input.turnItems ?? []),
    ],
  } as unknown as Mutable;
}

/** A provider-native child thread whose only work is a runless root turn. */
export function nativeChild(id: ThreadId, parent: ThreadId) {
  const rootId = NodeId.make(`root:${id}`);
  return projection({
    thread: thread(id, parent, "provider"),
    nodes: [{ id: rootId, runId: null, kind: "root_turn", status: "running" }],
    turnItems: [
      {
        id: TurnItemId.make(`message:${id}`),
        runId: null,
        nodeId: rootId,
        type: "assistant_message",
        status: "running",
        streaming: true,
      },
    ],
  });
}

const replace = <T extends { readonly id: unknown }>(list: ReadonlyArray<T>, next: T) =>
  list.map((entry) => (entry.id === next.id ? next : entry));

/** An in-memory store that applies what the sweep commits, so a second sweep sees it. */
export function world(
  threads: ReadonlyArray<Mutable>,
  options: { readonly live?: (id: string) => boolean; readonly sessionOpen?: boolean } = {},
) {
  const state = new Map(threads.map((entry) => [entry.thread.id, entry]));
  const commits: Array<{ commandId: string; events: ReadonlyArray<OrchestrationV2DomainEvent> }> =
    [];
  const apply = (event: OrchestrationV2DomainEvent) => {
    const current = state.get(event.threadId);
    if (current === undefined) return;
    switch (event.type) {
      case "turn-item.updated":
        current.turnItems = replace(current.turnItems, event.payload);
        return;
      case "subagent.updated":
        current.subagents = replace(current.subagents, event.payload);
        return;
      case "node.updated":
        current.nodes = replace(current.nodes, event.payload);
        return;
      case "run.background-work-cancelled":
        current.runs = current.runs.map((entry) =>
          entry.id === event.payload.runId
            ? {
                ...entry,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : entry,
        );
        return;
      default:
        return;
    }
  };
  const openWork = (entry: Mutable) =>
    entry.subagents.some(
      (row) => row.origin === "provider_native" && isOpenWorkStatus(row.status),
    ) ||
    entry.turnItems.some(
      (item) =>
        item.type === "subagent" &&
        item.origin === "provider_native" &&
        isOpenWorkStatus(item.status),
    ) ||
    entry.nodes.some(
      (node) => node.kind === "root_turn" && node.runId === null && isOpenWorkStatus(node.status),
    );
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRecoveryThreadIds: () =>
        Effect.succeed([...state.values()].filter(openWork).map((entry) => entry.thread.id)),
      getRuntimeRecoveryProjection: (threadId) =>
        Effect.succeed(structuredClone(state.get(threadId)) as never),
      getThreadRecords: (threadId, fields, filter) => {
        const entry = state.get(threadId)!;
        return Effect.succeed(
          Object.fromEntries(
            fields.map((field) => {
              let value = entry[field as keyof Mutable] as ReadonlyArray<never>;
              if (field === "turnItems" && filter !== undefined) {
                value = (value as ReadonlyArray<Projection["turnItems"][number]>).filter(
                  (item) =>
                    (filter.turnItemRunIds === undefined ||
                      filter.turnItemRunIds.includes(item.runId as never)) &&
                    (filter.turnItemTypes === undefined ||
                      filter.turnItemTypes.includes(item.type)),
                ) as never;
              }
              return [field, value];
            }),
          ) as never,
        );
      },
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () =>
        Effect.succeed(
          options.sessionOpen === false
            ? Option.none()
            : Option.some({
                liveBackgroundWork: (providerThread: { id: string }) =>
                  Effect.sync(() => options.live?.(providerThread.id) ?? false),
              } as never),
        ),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      commitCommand: (input) =>
        Effect.sync(() => {
          if (commits.some((commit) => commit.commandId === input.commandId)) {
            return { committed: false, cancelledEffectCount: 0 } as never;
          }
          commits.push({ commandId: input.commandId, events: input.events });
          input.events.forEach(apply);
          return { committed: true, cancelledEffectCount: 0 } as never;
        }),
    }),
    IdAllocator.layer,
  );
  const sweep = Effect.flatMap(StrandedSubagents.make, (sweeper) =>
    Effect.gen(function* () {
      const counts: Array<number> = [];
      for (let index = 0; index < 3; index += 1) counts.push(yield* sweeper.sweep());
      return counts;
    }),
  ).pipe(Effect.provide(layer));
  return { state, commits, sweep };
}

const events = (commits: ReturnType<typeof world>["commits"]) =>
  commits.flatMap((commit) => commit.events);
export const rowStatus = (entry: Mutable, id: string) =>
  entry.subagents.find((row) => row.id === id) as { status: string; progress?: string };
export const notes = (entry: Mutable) =>
  entry.runs.flatMap((candidate) =>
    (candidate.restartCancelledBackgroundWork ?? []).map((work) => work.id),
  );

const LIMIT_PROGRESS = "Stopped when Claude's usage limit ended the parent's session";
