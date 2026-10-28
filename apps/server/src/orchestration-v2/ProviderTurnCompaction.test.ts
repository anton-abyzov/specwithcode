import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
const now = DateTime.makeUnsafe("2026-10-28T12:00:00Z");
const threadId = ThreadId.make("thread:retained-provider-turns");
const providerInstanceId = ProviderInstanceId.make("codex");
let serial = 0;

const providerTurn = (
  key: string,
  revision: number,
  usedTokens?: number,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`retained-provider-turn:${++serial}`),
  type: "provider-turn.updated",
  threadId,
  occurredAt: now,
  payload: {
    id: ProviderTurnId.make(key),
    providerThreadId: ProviderThreadId.make("provider-thread:retained"),
    nodeId: NodeId.make("node:retained"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: key === "inherits" ? 1 : 2,
    status: revision === 9 ? "completed" : "running",
    startedAt: now,
    completedAt: revision === 9 ? now : null,
    ...(usedTokens === undefined
      ? {}
      : { tokenUsage: { usedTokens, updatedAt: `2026-10-28T12:00:0${revision}Z` } }),
  },
});

const createThread = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:retained-provider-turns"),
    title: "Provider turn retention",
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
        id: EventId.make(`retained-provider-thread:${++serial}`),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
});

const providerTurnRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    __rowid: number;
    provider_turn_id: string;
    payload_json: string;
  }>`SELECT rowid AS __rowid, provider_turn_id, payload_json FROM orchestration_v2_projection_provider_turns ORDER BY rowid`;
  return JSON.stringify(rows);
});

it.layer(layer)("provider turn snapshot retention", (it) => {
  it.effect("keeps the first, the latest and the latest snapshot with token usage", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* EventStore.EventStoreV2;
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      yield* createThread;
      for (let revision = 0; revision < 10; revision++) {
        // "inherits" records usage mid-turn, then later snapshots omit it.
        yield* sink.write({
          events: [
            providerTurn(
              "inherits",
              revision,
              revision === 3 || revision === 5 ? revision * 100 : undefined,
            ),
          ],
        });
        // "carries" records usage on every snapshot.
        yield* sink.write({ events: [providerTurn("carries", revision, revision * 10)] });
      }
      const before = yield* providerTurnRows;
      const highWater = yield* store.latestSequence();

      const dry = yield* maintenance.compactEventStoreWith({ dryRun: true, pageSize: 3 });
      const summary = yield* maintenance.compactEventStoreWith({ pageSize: 3 });
      assert.equal(dry.deletedEventCount, summary.deletedEventCount);
      assert.equal(summary.deletedByType["provider-turn.updated"], 7 + 8);
      assert.equal(yield* store.latestSequence(), highWater);

      const kept = yield* sql<{
        id: string;
        used: number | null;
      }>`SELECT json_extract(payload_json,'$.id') AS id, json_extract(payload_json,'$.tokenUsage.usedTokens') AS used FROM orchestration_events WHERE event_type='provider-turn.updated' ORDER BY sequence`;
      assert.deepEqual(
        kept.map((row) => [row.id, row.used]),
        [
          ["inherits", null],
          ["carries", 0],
          ["inherits", 500],
          ["inherits", null],
          ["carries", 90],
        ],
      );

      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal(yield* providerTurnRows, before);
      const inherited = yield* sql<{
        used: number;
      }>`SELECT json_extract(payload_json,'$.tokenUsage.usedTokens') AS used FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id='inherits'`;
      assert.equal(inherited[0]!.used, 500);
      assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 0);
    }),
  );
});
