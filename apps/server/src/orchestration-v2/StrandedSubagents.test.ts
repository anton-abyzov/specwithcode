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

import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as StrandedSubagents from "./StrandedSubagents.ts";
import { isOpenWorkStatus } from "./SubagentSettlement.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instance = ProviderInstanceId.make("claudeAgent");
const PARENT = ThreadId.make("thread_stranded_parent");
const PROVIDER_THREAD = ProviderThreadId.make("provider_thread_stranded");
const SESSION = ProviderSessionId.make("provider_session_stranded");
const at = (minute: number) =>
  DateTime.add(DateTime.makeUnsafe("2026-10-24T10:00:00.000Z"), { minutes: minute });

type Projection = OrchestrationV2ThreadProjection;
type Mutable = { -readonly [K in keyof Projection]: Projection[K] };

function thread(id: ThreadId, parent: ThreadId | null = null, creationSource = "user") {
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

function run(
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
function native(id: string, runId: string, childThreadId: ThreadId | null = null) {
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

function projection(input: {
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
function nativeChild(id: ThreadId, parent: ThreadId) {
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
function world(
  threads: ReadonlyArray<Mutable>,
  options: {
    readonly live?: () => boolean;
    readonly sessionOpen?: boolean;
    readonly held?: () => boolean;
  } = {},
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
                liveBackgroundWork: () => Effect.sync(() => options.live?.() ?? false),
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
    options.held === undefined
      ? Layer.empty
      : Layer.mock(ServiceUpdateHold.ServiceUpdateHold)({
          isHeld: Effect.sync(() => options.held!()),
          awaitReleased: Effect.void,
          current: Effect.succeedNone,
          installGated: Effect.succeed(false),
          recordRefusal: () => Effect.void,
        }),
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
const rowStatus = (entry: Mutable, id: string) =>
  entry.subagents.find((row) => row.id === id) as { status: string; progress?: string };
const notes = (entry: Mutable) =>
  entry.runs.flatMap((candidate) =>
    (candidate.restartCancelledBackgroundWork ?? []).map((work) => work.id),
  );

const LIMIT_PROGRESS = "Stopped when Claude's usage limit ended the parent's session";

it.effect("settles native subagents from this run and an earlier one after a usage limit", () => {
  const child = ThreadId.make("thread_stranded_child");
  const earlier = native("sub_earlier", "run_1");
  const current = native("sub_current", "run_2", child);
  const failed = run("run_2", 2, "failed");
  const { state, commits, sweep } = world(
    [
      projection({
        thread: thread(PARENT),
        runs: [run("run_1", 1, "completed"), failed],
        subagents: [earlier, current],
        turnItems: [
          {
            id: TurnItemId.make("error_run_2"),
            runId: failed.id,
            nodeId: failed.rootNodeId,
            type: "error",
            status: "failed",
            ordinal: 9,
            updatedAt: at(2),
            failure: { class: "usage_limit", message: "limit" },
          },
        ],
        sessionId: null,
      }),
      nativeChild(child, PARENT),
    ],
    { sessionOpen: false },
  );
  return Effect.gen(function* () {
    const counts = yield* sweep;
    // The first sweep only suspects; the second settles; the third finds nothing.
    assert.deepEqual(counts, [0, 1, 0]);
    const parent = state.get(PARENT)!;
    for (const id of ["sub_earlier", "sub_current"]) {
      assert.deepEqual(rowStatus(parent, id), {
        ...rowStatus(parent, id),
        status: "interrupted",
        progress: LIMIT_PROGRESS,
      });
    }
    assert.isFalse(parent.turnItems.some((item) => isOpenWorkStatus(item.status)));
    assert.isFalse(parent.nodes.some((node) => isOpenWorkStatus(node.status)));
    // The parent is told once, on the run the limit ended.
    assert.deepEqual(notes(parent), ["sub_earlier", "sub_current"]);
    assert.equal(
      events(commits).filter((event) => event.type === "run.background-work-cancelled").length,
      1,
    );
    assert.equal(
      parent.runs.find((entry) => entry.id === failed.id)!.restartCancelledBackgroundWork!.length,
      2,
    );
    // The child's own runless root turn stops showing work too.
    const settledChild = state.get(child)!;
    assert.equal(settledChild.nodes[0]!.status, "interrupted");
    assert.deepEqual(
      [
        settledChild.turnItems[0]!.status,
        (settledChild.turnItems[0] as { streaming?: boolean }).streaming,
      ],
      ["interrupted", false],
    );
  });
});

it.effect("settles work left by a process that exited after a completed parent turn", () => {
  let live = true;
  const { state, commits, sweep } = world(
    [
      projection({
        thread: thread(PARENT),
        runs: [run("run_1", 1, "completed")],
        subagents: [native("sub_background", "run_1")],
      }),
    ],
    { live: () => live },
  );
  return Effect.gen(function* () {
    // While the process still runs it, nothing is touched however often the sweep runs.
    assert.deepEqual(yield* sweep, [0, 0, 0]);
    assert.equal(commits.length, 0);
    live = false;
    assert.deepEqual(yield* sweep, [0, 1, 0]);
    const parent = state.get(PARENT)!;
    assert.deepEqual(
      [rowStatus(parent, "sub_background").status, rowStatus(parent, "sub_background").progress],
      ["interrupted", "Stopped when the provider session ended"],
    );
    assert.deepEqual(notes(parent), ["sub_background"]);
  });
});

it.effect("settles nothing while the service is held for an update", () => {
  let held = true;
  const { state, commits, sweep } = world(
    [
      projection({
        thread: thread(PARENT),
        runs: [run("run_1", 1, "completed")],
        subagents: [native("sub_background", "run_1")],
      }),
    ],
    { live: () => false, held: () => held },
  );
  return Effect.gen(function* () {
    // The update reads the database while it holds: a sweep then would write and make it read
    // everything again.
    assert.deepEqual(yield* sweep, [0, 0, 0]);
    assert.equal(commits.length, 0);
    held = false;
    assert.deepEqual(yield* sweep, [0, 1, 0]);
    assert.equal(rowStatus(state.get(PARENT)!, "sub_background").status, "interrupted");
  });
});

it.effect("records a person's Stop as cancelled and tells the parent nothing", () => {
  const stopped = run("run_1", 1, "interrupted");
  const { state, sweep } = world(
    [
      projection({
        thread: thread(PARENT),
        runs: [stopped],
        subagents: [native("sub_stopped", "run_1")],
        turnItems: [
          {
            id: TurnItemId.make("interrupt_run_1"),
            runId: stopped.id,
            nodeId: stopped.rootNodeId,
            type: "run_interrupt_request",
            status: "completed",
            message: "Stopped",
            cause: "user",
          },
        ],
        sessionId: null,
      }),
    ],
    { sessionOpen: false },
  );
  return Effect.gen(function* () {
    assert.deepEqual(yield* sweep, [0, 1, 0]);
    const parent = state.get(PARENT)!;
    assert.deepEqual(
      [rowStatus(parent, "sub_stopped").status, rowStatus(parent, "sub_stopped").progress],
      ["cancelled", "Stopped by you"],
    );
    assert.deepEqual(notes(parent), []);
  });
});

it.effect("leaves a delegated task to its own thread and settles the native child below it", () => {
  const delegatedThread = ThreadId.make("thread:delegated-task:task_1");
  const delegatedRow = {
    id: NodeId.make("task_1"),
    runId: RunId.make("run_1"),
    origin: "app_owned",
    childThreadId: delegatedThread,
    driver,
    providerInstanceId: instance,
    title: "Delegated",
    prompt: "Delegated",
    status: "running",
  };
  const delegatedItem = {
    id: TurnItemId.make("item:task_1"),
    runId: RunId.make("run_1"),
    nodeId: delegatedRow.id,
    providerThreadId: PROVIDER_THREAD,
    type: "subagent",
    status: "running",
    subagentId: delegatedRow.id,
    origin: "app_owned",
    childThreadId: delegatedThread,
    providerInstanceId: instance,
  };
  const { state, commits, sweep } = world(
    [
      projection({
        thread: thread(PARENT),
        runs: [run("run_1", 1, "completed")],
        extraRows: [delegatedRow],
        extraItems: [delegatedItem],
        nodes: [
          { id: delegatedRow.id, runId: RunId.make("run_1"), kind: "subagent", status: "running" },
        ],
      }),
      projection({
        thread: thread(delegatedThread, PARENT, "agent"),
        runs: [run("run_child_1", 1, "failed")],
        subagents: [native("sub_nested", "run_child_1")],
      }),
    ],
    { live: () => false },
  );
  return Effect.gen(function* () {
    assert.deepEqual(yield* sweep, [0, 1, 0]);
    assert.isTrue(
      commits.every((commit) => commit.events.every((event) => event.threadId === delegatedThread)),
    );
    const parent = state.get(PARENT)!;
    assert.equal(rowStatus(parent, "task_1").status, "running");
    assert.equal(parent.turnItems[0]!.status, "running");
    assert.equal(rowStatus(state.get(delegatedThread)!, "sub_nested").status, "interrupted");
  });
});

it.effect("waits for a run in progress to settle its own subagents", () => {
  const { commits, sweep } = world(
    [
      projection({
        thread: thread(PARENT),
        runs: [run("run_1", 1, "completed"), run("run_2", 2, "running")],
        subagents: [native("sub_old", "run_1")],
      }),
    ],
    { live: () => false },
  );
  return Effect.gen(function* () {
    assert.deepEqual(yield* sweep, [0, 0, 0]);
    assert.equal(commits.length, 0);
  });
});

it.effect("settles a native child whose parent row already ended", () => {
  const child = ThreadId.make("thread_stranded_orphan_child");
  const done = native("sub_done", "run_1", child);
  const { state, sweep } = world([
    projection({
      thread: thread(PARENT),
      runs: [run("run_1", 1, "completed")],
      subagents: [
        {
          row: { ...done.row, status: "completed" },
          node: { ...done.node, status: "completed" },
          item: { ...done.item, status: "completed" },
        },
      ],
    }),
    nativeChild(child, PARENT),
  ]);
  return Effect.gen(function* () {
    assert.deepEqual(yield* sweep, [0, 1, 0]);
    assert.equal(state.get(child)!.nodes[0]!.status, "completed");
  });
});
