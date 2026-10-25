import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);
const layerSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStores, SqlitePersistence.layerMemory)),
);
const layerTest = Layer.mergeAll(
  layerStores,
  layerSink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerStores, layerSink, IdAllocator.layer, ThreadCommandExecutor.layer),
    ),
  ),
);

// Ingestion is the same for every provider; Cursor is one whose receipt can
// land without the child's own root update.
const DRIVER = ProviderDriverKind.make("cursor");
const instanceId = ProviderInstanceId.make("cursor");
const modelSelection = { instanceId, model: "composer-2" };

/**
 * A parent thread with one provider-native child, its runless root and its
 * parent row, both running since `startedAt`. Returns an ingest function and
 * readers for the child's root and shell.
 */
const nativeChild = (name: string, startedAt: DateTime.Utc) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName: name });
    const parentId = yield* idAllocator.allocate.thread({ fixtureName: name, projectId });
    const childThreadId = idAllocator.derive.threadFromProviderThread({
      driver: DRIVER,
      nativeThreadId: `${name}-child`,
    });
    const parent: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: parentId,
      projectId,
      title: "Parent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
      forkedFrom: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: parentId }),
          type: "thread.created",
          threadId: parentId,
          occurredAt: startedAt,
          payload: parent,
        },
      ],
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: instanceId,
      threadId: parentId,
    });
    const ingest = (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) =>
      ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: instanceId,
        threadId: parentId,
        event,
      });
    yield* ingest({
      type: "app_thread.created",
      driver: DRIVER,
      appThread: {
        ...parent,
        id: childThreadId,
        title: "Review",
        createdBy: "agent",
        creationSource: "provider",
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "subagent",
          rootThreadId: parentId,
        },
      },
    });
    const rootId = NodeId.make(`node:${name}:child-root`);
    const root = (status: OrchestrationV2ExecutionNode["status"], at: DateTime.Utc) =>
      ({
        type: "node.updated",
        driver: DRIVER,
        node: {
          id: rootId,
          threadId: childThreadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: rootId,
          kind: "root_turn",
          status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at,
          completedAt: status === "running" ? null : at,
        },
      }) satisfies ProviderEventIngestor.ProviderEventIngestInput["event"];
    const row = (
      status: OrchestrationV2Subagent["status"],
      runStartedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null = null,
    ) =>
      ({
        type: "subagent.updated",
        driver: DRIVER,
        subagent: {
          id: NodeId.make(`node:${name}:subagent`),
          threadId: parentId,
          runId: null,
          parentNodeId: NodeId.make(`node:${name}:root`),
          origin: "provider_native",
          createdBy: "agent",
          driver: DRIVER,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Review the change",
          title: "Review",
          model: null,
          status,
          result: status === "completed" ? "SHIP" : null,
          startedAt: runStartedAt,
          completedAt,
          updatedAt: completedAt ?? runStartedAt,
        },
      }) satisfies ProviderEventIngestor.ProviderEventIngestInput["event"];
    yield* ingest(root("running", startedAt));
    yield* ingest(row("running", startedAt));
    const childRoot = projections
      .getThreadRecords(childThreadId, ["nodes"])
      .pipe(Effect.map(({ nodes }) => nodes.find((node) => node.id === rootId)));
    const childActivity = projections
      .getThreadShell(childThreadId)
      .pipe(Effect.map((shell) => shell?.activityRunStatus ?? null));
    const inputFor = (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) => ({
      providerSessionId,
      providerInstanceId: instanceId,
      threadId: parentId,
      event,
    });
    const parentRow = projections
      .getThreadRecords(parentId, ["subagents"])
      .pipe(Effect.map(({ subagents }) => subagents[0]));
    return {
      ingest,
      root,
      row,
      childRoot,
      childActivity,
      childThreadId,
      parentId,
      parentRow,
      inputFor,
      normalize: (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) =>
        ingestor.normalize(inputFor(event)),
      eventSink,
      projections,
    };
  });

type Child = Effect.Success<ReturnType<typeof nativeChild>>;

/**
 * An ingestor whose real SQLite sink lets `before` commit other ingestions
 * immediately before it forwards the first write that closes the child.
 */
const racingIngestor = <E>(child: Child, before: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const raced = { done: false };
    const sink: typeof child.eventSink = {
      ...child.eventSink,
      write: (input) =>
        Effect.gen(function* () {
          const closesChild = input.events.some(
            (event) =>
              event.threadId === child.childThreadId &&
              event.type === "node.updated" &&
              event.payload.status === "completed",
          );
          if (!raced.done && closesChild) {
            raced.done = true;
            yield* Effect.orDie(before);
          }
          return yield* child.eventSink.write(input);
        }),
    };
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
      Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
      Effect.provideService(EventSink.EventSinkV2, sink),
    );
    return { ingestor, raced };
  });

/**
 * The web's own list functions, loaded at run time: their imports do not
 * resolve under the server's module settings, so the server typecheck must
 * not follow them.
 */
const WEB_SUBAGENT_LISTS = new URL("../../../web/src/studio/threadSubagents.ts", import.meta.url)
  .href;
interface WebSubagentLists {
  readonly threadSubagentEntries: (input: {
    readonly parent: object;
    readonly projected: ReadonlyArray<OrchestrationV2Subagent>;
    readonly shells: ReadonlyArray<object>;
  }) => ReadonlyArray<unknown>;
  readonly listedRunningSubagents: (input: {
    readonly threads: ReadonlyArray<object>;
    readonly shells: ReadonlyArray<object>;
    readonly coordinatorIds: ReadonlySet<string>;
    readonly selected: object | null;
    readonly selectedEntries: ReadonlyArray<unknown>;
  }) => ReadonlyMap<string, number>;
}

/** "Working · N" for the parent: not selected, selected, not selected again. */
const listedCounts = (child: Child, at: DateTime.Utc) =>
  Effect.gen(function* () {
    const { threadSubagentEntries, listedRunningSubagents } = yield* Effect.promise(
      () => import(/* @vite-ignore */ WEB_SUBAGENT_LISTS) as Promise<WebSubagentLists>,
    );
    const { subagents } = yield* child.projections.getThreadRecords(child.parentId, ["subagents"]);
    const activity = yield* child.childActivity;
    const parent = {
      id: child.parentId,
      environmentId: "env",
      runtime: { status: "running" },
      pendingBackgroundTasks: [],
    };
    const shell = {
      id: child.childThreadId,
      environmentId: "env",
      deletedAt: null,
      lineage: {
        parentThreadId: child.parentId,
        relationshipToParent: "subagent",
        rootThreadId: child.parentId,
      },
      createdAt: DateTime.formatIso(at),
      modelSelection,
      runtime: activity === null ? null : { status: activity },
      latestRun: null,
      source: { creationSource: "provider" },
    };
    const shells = [parent, shell];
    const entries = threadSubagentEntries({ parent, shells, projected: subagents });
    return [null, parent, null].map(
      (selected) =>
        listedRunningSubagents({
          threads: [parent],
          shells,
          coordinatorIds: new Set(),
          selected,
          selectedEntries: selected === null ? [] : entries,
        }).get(`env:${child.parentId}`) ?? 0,
    );
  });

const childEvents = (
  stored: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }>,
  childThreadId: ThreadId,
) =>
  stored
    .filter((entry) => entry.event.threadId === childThreadId)
    .map((entry) => [entry.event.type, (entry.event.payload as { status?: string }).status]);

const layer = it.layer(layerTest);

layer("native child receipt ingestion", (it) => {
  it.effect("closes the child's root in the receipt's own write, whatever its parent does", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const t1 = DateTime.add(t0, { seconds: 30 });
      const child = yield* nativeChild("receipt-closes", t0);
      assert.equal(yield* child.childActivity, "running");

      // The receipt arrives without the child root's own update.
      const stored = yield* child.ingest(child.row("completed", t0, t1));

      assert.deepEqual(
        stored.map((entry) => [entry.event.type, entry.event.threadId]),
        [
          ["subagent.updated", child.parentId],
          ["node.updated", child.childThreadId],
        ],
      );
      assert.equal((yield* child.childRoot)?.status, "completed");
      assert.isNull(yield* child.childActivity);
      // A repeated receipt finds nothing open and adds nothing.
      assert.deepEqual(
        childEvents(yield* child.ingest(child.row("completed", t0, t1)), child.childThreadId),
        [],
      );
    }),
  );

  it.effect("ends the root the way the receipt ended, and leaves an ended root alone", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const t1 = DateTime.add(t0, { seconds: 5 });
      const stopped = yield* nativeChild("receipt-stopped", t0);
      assert.deepEqual(
        childEvents(yield* stopped.ingest(stopped.row("cancelled", t0, t1)), stopped.childThreadId),
        [["node.updated", "cancelled"]],
      );

      // Claude, ACP and Cursor usually close the root just before the receipt.
      const closed = yield* nativeChild("receipt-after-root", t0);
      yield* closed.ingest(closed.root("failed", t0));
      assert.deepEqual(
        childEvents(yield* closed.ingest(closed.row("completed", t0, t1)), closed.childThreadId),
        [],
      );
      assert.equal((yield* closed.childRoot)?.status, "failed");
    }),
  );

  it.effect("never closes a resumed child with a late receipt", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const t1 = DateTime.add(t0, { seconds: 30 });
      const t2 = DateTime.add(t0, { minutes: 2 });

      // The row already records the resumed run; the first run's receipt is late.
      const resumed = yield* nativeChild("receipt-late-row", t0);
      yield* resumed.ingest(resumed.root("running", t2));
      yield* resumed.ingest(resumed.row("running", t2));
      assert.deepEqual(
        childEvents(yield* resumed.ingest(resumed.row("completed", t0, t1)), resumed.childThreadId),
        [],
      );
      assert.equal((yield* resumed.childRoot)?.status, "running");
      assert.equal(yield* resumed.childActivity, "running");

      // The root reopened after the receipt's run ended, before the row did.
      const reopened = yield* nativeChild("receipt-late-root", t0);
      yield* reopened.ingest(reopened.root("running", t2));
      assert.deepEqual(
        childEvents(
          yield* reopened.ingest(reopened.row("completed", t0, t1)),
          reopened.childThreadId,
        ),
        [],
      );
      assert.equal((yield* reopened.childRoot)?.status, "running");
    }),
  );

  it.effect("fences the receipt on the child generation stored when it writes", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const t1 = DateTime.add(t0, { seconds: 30 });
      const t2 = DateTime.add(t0, { minutes: 2 });

      // The child resumes, root and row, between normalization and write.
      const resumed = yield* nativeChild("fence-resumed", t0);
      const first = yield* racingIngestor(
        resumed,
        Effect.all([
          resumed.ingest(resumed.root("running", t2)),
          resumed.ingest(resumed.row("running", t2)),
        ]),
      );
      const stored = yield* first.ingestor.ingestNormalized(
        resumed.inputFor(resumed.row("completed", t0, t1)),
      );
      assert.isTrue(first.raced.done);
      assert.deepEqual(stored, []);
      const root = yield* resumed.childRoot;
      assert.equal(root?.status, "running");
      assert.equal(DateTime.toEpochMillis(root!.startedAt!), DateTime.toEpochMillis(t2));
      assert.equal(yield* resumed.childActivity, "running");
      const row = yield* resumed.parentRow;
      assert.equal(row?.status, "running");
      assert.equal(DateTime.toEpochMillis(row!.startedAt!), DateTime.toEpochMillis(t2));

      // Only the child root moved on: the receipt lands, the stale close does not.
      const reopened = yield* nativeChild("fence-reopened", t0);
      const second = yield* racingIngestor(reopened, reopened.ingest(reopened.root("running", t2)));
      const kept = yield* second.ingestor.ingestNormalized(
        reopened.inputFor(reopened.row("completed", t0, t1)),
      );
      assert.isTrue(second.raced.done);
      assert.deepEqual(
        kept.map((entry) => [entry.event.type, entry.event.threadId]),
        [["subagent.updated", reopened.parentId]],
      );
      assert.equal((yield* reopened.parentRow)?.status, "completed");
      assert.equal((yield* reopened.childRoot)?.status, "running");
      assert.equal(yield* reopened.childActivity, "running");
    }),
  );

  it.effect("drops a late receipt after a resume, so every list reads the same count", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const t1 = DateTime.add(t0, { seconds: 30 });
      const t2 = DateTime.add(t0, { minutes: 2 });
      const child = yield* nativeChild("late-count", t0);
      yield* child.ingest(child.root("running", t2));
      yield* child.ingest(child.row("running", t2));

      assert.deepEqual(yield* child.ingest(child.row("completed", t0, t1)), []);
      assert.equal((yield* child.parentRow)?.status, "running");
      assert.equal(yield* child.childActivity, "running");
      assert.deepEqual(yield* listedCounts(child, t0), [1, 1, 1]);

      // The resumed run's own receipt still closes it.
      const t3 = DateTime.add(t2, { seconds: 30 });
      assert.deepEqual(
        childEvents(yield* child.ingest(child.row("completed", t2, t3)), child.childThreadId),
        [["node.updated", "completed"]],
      );
      assert.deepEqual(yield* listedCounts(child, t0), [0, 0, 0]);
    }),
  );

  it.effect("closes the root once when two receipts are normalized before either writes", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const child = yield* nativeChild("receipt-twice", t0);
      const receipt = child.row("completed", t0, DateTime.add(t0, { seconds: 30 }));
      const first = yield* child.normalize(receipt);
      const second = yield* child.normalize(receipt);
      assert.deepEqual(
        childEvents(
          first.map((event) => ({ event })),
          child.childThreadId,
        ),
        [["node.updated", "completed"]],
      );
      assert.deepEqual(
        childEvents(
          second.map((event) => ({ event })),
          child.childThreadId,
        ),
        [["node.updated", "completed"]],
      );

      const a = yield* child.eventSink.write({ events: first });
      const b = yield* child.eventSink.write({ events: second });
      assert.deepEqual(childEvents([...a, ...b], child.childThreadId), [
        ["node.updated", "completed"],
      ]);
      assert.equal((yield* child.childRoot)?.status, "completed");
      assert.isNull(yield* child.childActivity);
      assert.deepEqual(childEvents(yield* child.ingest(receipt), child.childThreadId), []);
    }),
  );

  it.effect("stores the receipt even when the child's thread cannot be read", () =>
    Effect.gen(function* () {
      const t0 = yield* DateTime.now;
      const child = yield* nativeChild("receipt-missing-child", t0);
      const orphan = child.row("completed", t0, DateTime.add(t0, { seconds: 1 }));
      const stored = yield* child.ingest({
        ...orphan,
        subagent: { ...orphan.subagent, childThreadId: "thread:missing" as ThreadId },
      });
      assert.deepEqual(
        stored.map((entry) => entry.event.type),
        ["subagent.updated"],
      );
    }),
  );
});
