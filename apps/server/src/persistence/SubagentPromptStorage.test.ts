import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./OrchestrationEventStore.ts";
import * as Sqlite from "./Sqlite.ts";

const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const now = DateTime.makeUnsafe("2026-10-27T12:00:00Z");
let serial = 0;
let currentThread = "prompt-storage";
function event(
  key: string,
  prompt: string,
  item = false,
  thread = currentThread,
): OrchestrationV2DomainEvent {
  const threadId = ThreadId.make(thread);
  const base = { id: EventId.make(`prompt-event:${++serial}`), threadId, occurredAt: now };
  const agent = {
    runId: null,
    providerThreadId: null,
    origin: "provider_native" as const,
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    childThreadId: null,
    prompt,
    title: "Inspect storage",
    status: "running" as const,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  return item
    ? {
        ...base,
        type: "turn-item.updated",
        payload: {
          ...agent,
          id: TurnItemId.make(key),
          threadId,
          nodeId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "subagent",
          subagentId: NodeId.make(key),
        },
      }
    : {
        ...base,
        type: "subagent.updated",
        payload: {
          ...agent,
          id: NodeId.make(key),
          threadId,
          parentNodeId: NodeId.make("parent"),
          createdBy: "agent",
          nativeTaskRef: null,
          model: null,
        },
      };
}
const storedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    sequence: number;
    payload_json: string;
  }>`SELECT sequence, payload_json FROM orchestration_events WHERE stream_id = ${currentThread} ORDER BY sequence`;
});

it.layer(layer)("subagent prompt storage", (it) => {
  it.effect(
    "stores large prompts once and restores full payloads on command, global and thread replay",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.OrchestrationEventStore;
        const prompt = 'Analyze "quoted" data 🧪\\\n'.repeat(1000);
        for (const item of [false, true]) {
          const events = Array.from({ length: 8 }, () => event(`agent:${item}`, prompt, item));
          yield* store.appendAgentEvents({
            commandId: CommandId.make(`prompt-command:${item}`),
            events,
          });
          const command = yield* store
            .readAgentEvents({ commandId: CommandId.make(`prompt-command:${item}`) })
            .pipe(Stream.runCollect);
          assert.deepEqual(
            command.map((x) => x.event),
            events,
          );
        }
        const rows = yield* storedRows;
        assert.equal(rows.filter((x) => JSON.parse(x.payload_json).prompt === prompt).length, 2);
        assert.equal(
          rows.filter((x) => JSON.parse(x.payload_json).promptSequence !== undefined).length,
          14,
        );
        const threadReplay = yield* store
          .readAgentEvents({ threadId: ThreadId.make("prompt-storage") })
          .pipe(Stream.runCollect);
        const globalReplay = yield* store
          .readApplicationEvents({ afterSequence: 0, throughSequence: rows.at(-1)!.sequence })
          .pipe(Stream.runCollect);
        assert.equal(threadReplay.length, 16);
        assert.equal(globalReplay.length, 16);
        for (const row of threadReplay)
          assert.equal((row.event.payload as { prompt: string }).prompt, prompt);
        const stats = yield* store.getReplayStats({
          afterSequence: 0,
          throughSequence: rows.at(-1)!.sequence,
        });
        const threadStats = yield* store.getAgentReplayStats({
          threadId: ThreadId.make("prompt-storage"),
          afterSequence: 0,
          throughSequence: rows.at(-1)!.sequence,
          maxEvents: 100,
        });
        assert.isAbove(stats.rawPayloadBytes, prompt.length * 16);
        assert.equal(threadStats.rawPayloadBytes, stats.rawPayloadBytes);
      }),
  );

  it.effect("revalidates anchors after rollback and isolates keys by thread and event kind", () =>
    Effect.gen(function* () {
      currentThread = "prompt-rollback";
      const store = yield* Store.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .withTransaction(
          store
            .appendAgentEvents({ events: [event("rolled-back", "discard")] })
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.ignore);
      const events = [
        event("other", "discard"),
        event("rolled-back", "discard"),
        event("rolled-back", "discard"),
        event("rolled-back", "changed"),
        event("rolled-back", "changed"),
        event("rolled-back", "changed", false, "other-thread"),
      ];
      yield* store.appendAgentEvents({ events });
      const rows = yield* storedRows;
      const payloads = rows.map((x) => JSON.parse(x.payload_json));
      assert.equal(payloads[1].prompt, "discard");
      assert.equal(payloads[2].promptSequence, rows[1]!.sequence);
      assert.equal(payloads[3].prompt, "changed");
      assert.equal(payloads[4].promptSequence, rows[3]!.sequence);
      const otherRows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE stream_id = 'other-thread'`;
      assert.equal(JSON.parse(otherRows[0]!.payload_json).prompt, "changed");
      assert.deepEqual(
        (yield* store
          .readAgentEvents({ threadId: ThreadId.make(currentThread) })
          .pipe(Stream.runCollect)).map((x) => x.event),
        events.slice(0, 5),
      );
    }),
  );

  it.effect(
    "starts a fresh anchor after restart and eviction without breaking existing references",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.OrchestrationEventStore;
        currentThread = "prompt-eviction";
        const first = event("evicted", "keep me");
        yield* store.appendAgentEvents({ events: [first, event("evicted", "keep me")] });
        yield* store.appendAgentEvents({
          events: Array.from({ length: 4096 }, (_, i) => event(`cache:${i}`, "other")),
        });
        yield* store.appendAgentEvents({ events: [event("evicted", "keep me")] });
        const restarted = yield* Effect.gen(function* () {
          return yield* Store.OrchestrationEventStore;
        }).pipe(Effect.provide(Layer.fresh(Store.layer)));
        yield* restarted.appendAgentEvents({
          events: [event("evicted", "keep me"), event("evicted", "keep me")],
        });
        const rows = yield* storedRows;
        assert.equal(JSON.parse(rows[4098]!.payload_json).prompt, "keep me");
        assert.equal(JSON.parse(rows[4099]!.payload_json).prompt, "keep me");
        assert.equal(JSON.parse(rows[4100]!.payload_json).promptSequence, rows[4099]!.sequence);
        const replay = yield* restarted
          .readAgentEvents({ threadId: ThreadId.make(currentThread), limit: 2 })
          .pipe(Stream.runCollect);
        assert.deepEqual(replay[0]!.event, first);
        assert.equal((replay[1]!.event.payload as { prompt: string }).prompt, "keep me");
      }),
  );
});
