import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Maintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const layer = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  Maintenance.layer.pipe(Layer.provide(stores)),
);
const now = DateTime.makeUnsafe("2026-10-27T12:00:00Z");
const threadId = ThreadId.make("thread:retained-items");
const providerInstanceId = ProviderInstanceId.make("codex");
let serial = 0;
const item = (
  key: string,
  revision: number,
  type: "command_execution" | "reasoning" | "todo_list" | "subagent" = "command_execution",
): OrchestrationV2DomainEvent => {
  const base = {
    id: TurnItemId.make(key),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: key.charCodeAt(0),
    status: "completed" as const,
    title: key,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const text = `${key}:${revision}:` + "x".repeat(1000 + revision);
  const payload: OrchestrationV2TurnItem =
    type === "command_execution"
      ? { ...base, type, input: "test", output: text }
      : type === "reasoning"
        ? { ...base, type, text, streaming: false }
        : type === "todo_list"
          ? {
              ...base,
              type,
              planId: PlanId.make("retained-plan"),
              steps: [{ id: "step", text, status: "completed" }],
            }
          : {
              ...base,
              type,
              subagentId: NodeId.make(key),
              origin: "provider_native",
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId,
              childThreadId: null,
              prompt: `prompt:${revision % 2}`,
              result: text,
            };
  return {
    id: EventId.make(`retained-item:${++serial}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  };
};
const createThread = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:retained-items"),
    title: "Retention",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`retained-thread:${++serial}`),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
});
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'orchestration_v2_projection_%' OR name='orchestration_v2_turn_item_positions') ORDER BY name`;
  const result: Record<string, unknown> = {};
  for (const { name } of tables) {
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`,
    );
    result[name] = name.endsWith("metadata") ? rows.map(({ updated_at: _, ...row }) => row) : rows;
  }
  return JSON.stringify(result);
});

it.layer(layer)("turn snapshot retention", (it) => {
  it.effect(
    "retains first/latest outputs, command replay and all subagent anchors with identical rebuild positions",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* EventStore.EventStoreV2;
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
        const sql = yield* SqlClient.SqlClient;
        yield* createThread;
        const commandId = CommandId.make("retained-command");
        for (let revision = 0; revision < 20; revision++) {
          for (const type of ["command_execution", "reasoning", "todo_list", "subagent"] as const)
            yield* sink.write({ events: [item(type, revision, type)] });
          yield* sink.write({ commandId, events: [item("commanded", revision)] });
        }
        const before = yield* snapshot;
        const highWater = yield* store.latestSequence();
        const commandBefore = yield* store.readByCommandId({ commandId }).pipe(Stream.runCollect);
        const allBefore = yield* store.read().pipe(Stream.runCollect);
        const cursor = allBefore[30]!.sequence;
        const dry = yield* maintenance.compactEventStoreWith({ dryRun: true, pageSize: 3 });
        const summary = yield* maintenance.compactEventStoreWith({ pageSize: 3 });
        assert.equal(summary.deletedByType["turn-item.updated"], 54);
        assert.equal(summary.deletedEventCount, dry.deletedEventCount);
        assert.equal(yield* store.latestSequence(), highWater);
        assert.deepEqual(
          yield* store.readByCommandId({ commandId }).pipe(Stream.runCollect),
          commandBefore,
        );
        const catchup = yield* store.read({ afterSequence: cursor }).pipe(Stream.runCollect);
        const latestItems = (events: typeof allBefore) => {
          const items = new Map<string, unknown>();
          for (const { event } of events)
            if (event.type === "turn-item.updated") items.set(event.payload.id, event.payload);
          return [...items];
        };
        assert.deepEqual(
          latestItems([...allBefore.filter((x) => x.sequence <= cursor), ...catchup]),
          latestItems(allBefore),
        );
        const counts = yield* sql<{
          kind: string;
          n: number;
        }>`SELECT json_extract(payload_json,'$.type') AS kind,COUNT(*) AS n FROM orchestration_events WHERE event_type='turn-item.updated' GROUP BY kind`;
        assert.deepEqual(Object.fromEntries(counts.map((x) => [x.kind, x.n])), {
          command_execution: 22,
          reasoning: 2,
          todo_list: 2,
          subagent: 20,
        });
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal(yield* snapshot, before);
        assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 0);
        const replay = yield* store.read({ afterSequence: 0 }).pipe(Stream.runCollect);
        const agents = replay.filter(
          (x) => x.event.type === "turn-item.updated" && x.event.payload.type === "subagent",
        );
        assert.equal(agents.length, 20);
        for (const [index, row] of agents.entries())
          assert.equal((row.event.payload as { prompt: string }).prompt, `prompt:${index % 2}`);
      }),
  );

  it.effect(
    "bounds a pass before new writes and compacts new snapshots on the next incremental pass",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* EventStore.EventStoreV2;
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
        const sql = yield* SqlClient.SqlClient;
        yield* createThread;
        for (let i = 0; i < 8; i++) yield* sink.write({ events: [item("busy", i)] });
        let appended = false;
        const first = yield* maintenance.compactEventStoreWith({
          pageSize: 2,
          betweenPages: Effect.gen(function* () {
            if (appended) return;
            appended = true;
            for (let i = 8; i < 11; i++) yield* sink.write({ events: [item("busy", i)] });
          }).pipe(Effect.orDie),
        });
        const fresh = yield* sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM orchestration_events WHERE sequence > ${first.throughSequence}`;
        assert.equal(fresh[0]!.n, 3);
        const before = yield* snapshot;
        const second = yield* maintenance.compactEventStoreWith({
          sinceSequence: first.throughSequence,
          pageSize: 2,
        });
        assert.equal(second.scannedStreamCount, 1);
        assert.equal(second.deletedByType["turn-item.updated"], 3);
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal(yield* snapshot, before);
        assert.equal(yield* store.latestSequence(), first.throughSequence + 3);
      }),
  );
});

it.layer(layer)("retention savings", (it) => {
  it.effect("reduces 1800 eligible snapshots to 18 with identical rebuilt state", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      yield* createThread;
      for (let revision = 0; revision < 200; revision++) {
        for (const type of ["command_execution", "reasoning", "todo_list"] as const) {
          for (let lane = 0; lane < 3; lane++)
            yield* sink.write({ events: [item(`benchmark:${type}:${lane}`, revision, type)] });
        }
      }
      const readSize = sql<{
        n: number;
        bytes: number;
      }>`SELECT COUNT(*) AS n,SUM(octet_length(payload_json)) AS bytes FROM orchestration_events WHERE event_type='turn-item.updated' AND json_extract(payload_json,'$.id') LIKE 'benchmark:%'`;
      const before = (yield* readSize)[0]!;
      const projected = yield* snapshot;
      const summary = yield* maintenance.compactEventStoreWith({ pageSize: 50 });
      const after = (yield* readSize)[0]!;
      assert.equal(before.n, 1800);
      assert.equal(after.n, 18);
      assert.isBelow(after.bytes, before.bytes * 0.02);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal(yield* snapshot, projected);
      yield* Effect.logInfo("Synthetic retention bytes", {
        before,
        after,
        deleted: summary.deletedEventCount,
      });
    }),
  );
});
