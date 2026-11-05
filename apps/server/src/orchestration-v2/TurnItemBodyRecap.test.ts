import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import { HTML_RENDER_TOOL_NAME } from "@specweave-studio/shared/htmlRender";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { capTurnItemBody, DEFAULT_TURN_ITEM_BODY_CAP } from "./TurnItemBodyCap.ts";
import * as TurnItemBodyRecap from "./TurnItemBodyRecap.ts";

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(layerStores, EventSink.layer.pipe(Layer.provide(layerStores)));
const fresh = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layerTest>>) =>
  effect.pipe(Effect.provide(layerTest));

const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeItem = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CREATED = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-01T00:00:00.000Z"));
/** Before the 7-day horizon, and inside it. */
const OLD = "2026-02-01T00:00:00.000Z";
const RECENT = "2026-02-28T00:00:00.000Z";

const makeThread = (threadId: ThreadId): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:body-recap"),
  title: `Thread ${threadId}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const active = ThreadId.make("thread:body-recap:active");
const archived = ThreadId.make("thread:body-recap:archived");

const base = (threadId: ThreadId, label: string, ordinal: number) => ({
  id: TurnItemId.make(`turn-item:body-recap:${label}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: CREATED,
  completedAt: CREATED,
  updatedAt: CREATED,
});

const BIG = 300_000;
const command = (
  threadId: ThreadId,
  label: string,
  ordinal: number,
  status: OrchestrationV2TurnItem["status"] = "completed",
): OrchestrationV2TurnItem => ({
  ...base(threadId, label, ordinal),
  status,
  type: "command_execution",
  input: "cat big.log",
  output: `${label} `.repeat(BIG / (label.length + 1)),
});

/** The uncapped items an old build saved, and when each row was last updated. */
const fixture: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem; readonly at: string }> = [
  { item: command(active, "old-command", 1), at: OLD },
  {
    item: {
      ...base(active, "old-read", 2),
      type: "dynamic_tool",
      toolName: "Read",
      input: { file_path: "/repo/big.log" },
      output: "r".repeat(100_000),
    },
    at: OLD,
  },
  { item: command(active, "recent-command", 3), at: RECENT },
  { item: command(active, "old-running", 4, "running"), at: OLD },
  {
    item: {
      ...base(active, "old-diff", 5),
      type: "file_change",
      fileName: "a.txt",
      changes: [{ operation: "update", path: "a.txt", diffStr: "+".repeat(BIG) }],
    },
    at: OLD,
  },
  {
    item: {
      ...base(active, "old-render", 6),
      type: "dynamic_tool",
      toolName: HTML_RENDER_TOOL_NAME,
      input: { html: "h".repeat(BIG) },
      output: "rendered",
    },
    at: OLD,
  },
  { item: command(archived, "archived-recent", 1), at: RECENT },
];

let serial = 0;
const eventId = () => EventId.make(`event:body-recap:${(serial += 1)}`);

/** Writes the threads and small items through the sink, then rewrites the rows as an old build saved them. */
const writeFixture = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  for (const threadId of [active, archived]) {
    yield* sink.write({
      events: [
        {
          id: eventId(),
          type: "thread.created",
          threadId,
          providerInstanceId,
          occurredAt: CREATED,
          payload: makeThread(threadId),
        },
      ],
    });
  }
  for (const { item } of fixture) {
    const small: OrchestrationV2DomainEvent = {
      id: eventId(),
      type: "turn-item.updated",
      threadId: item.threadId,
      occurredAt: CREATED,
      payload: item.type === "command_execution" ? { ...item, output: "small" } : item,
    };
    yield* sink.write({ events: [small] });
  }
  const archivedAt = DateTime.makeUnsafe(RECENT);
  yield* sink.write({
    events: [
      {
        id: eventId(),
        type: "thread.archived",
        threadId: archived,
        providerInstanceId,
        occurredAt: archivedAt,
        payload: { ...makeThread(archived), archivedAt, updatedAt: archivedAt },
      },
    ],
  });
  for (const { item, at } of fixture) {
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = ${encodeItem(item)}, updated_at = ${at}
      WHERE turn_item_id = ${item.id}
    `;
  }
});

const rowOf = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${id}
    `;
    return rows[0]?.payload_json ?? "";
  });

const eventsDigest = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly line: string }>`
    SELECT sequence || ':' || payload_json AS line FROM orchestration_events ORDER BY sequence
  `;
  return rows.map((row) => row.line).join("\n");
});

const bodyCutOf = (item: OrchestrationV2TurnItem) =>
  item.type === "command_execution" || item.type === "dynamic_tool" ? item.bodyCut : undefined;

const idOf = (label: string) => `turn-item:body-recap:${label}`;

describe("turn item body recap", () => {
  it.effect("caps old over-cap tool rows as the write path would, and nothing else", () =>
    fresh(
      Effect.gen(function* () {
        yield* writeFixture;
        const events = yield* eventsDigest;
        const before = new Map<string, string>();
        for (const { item } of fixture) before.set(item.id, yield* rowOf(item.id));

        const result = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: 7,
          nowMs: NOW_MS,
          batchSize: 1,
          scanWindow: 2,
        });
        assert.equal(result.cappedItemCount, 2);
        assert.equal(result.unchangedItemCount, 1);
        assert.isTrue(result.reachedEnd);
        assert.isFalse(result.interrupted);
        // The command loses all but 64 KB of 300 KB, the read all but 16 KB of 100 KB.
        assert.isAbove(result.savedBytes, BIG - 66 * 1024 + 80_000);

        for (const label of ["old-command", "old-read"]) {
          const original = fixture.find(({ item }) => item.id === idOf(label))?.item;
          if (original === undefined) return assert.fail(label);
          const stored = decodeItem(yield* rowOf(idOf(label)));
          // The same cap the write path applies, so the row is what a save today keeps.
          assert.deepStrictEqual(stored, capTurnItemBody(original));
          assert.isDefined(bodyCutOf(stored));
          assert.strictEqual(capTurnItemBody(stored), stored);
        }
        const read = decodeItem(yield* rowOf(idOf("old-read")));
        if (read.type !== "dynamic_tool") return assert.fail("read");
        assert.equal(read.bodyCut?.reason, "write-cap");
        assert.isAtMost((read.output as string).length, DEFAULT_TURN_ITEM_BODY_CAP.readChars);

        // Archiving can be undone: a recently archived thread is not cut sooner.
        for (const label of [
          "recent-command",
          "old-running",
          "old-diff",
          "old-render",
          "archived-recent",
        ]) {
          assert.equal(yield* rowOf(idOf(label)), before.get(idOf(label)), label);
        }
        assert.equal(yield* eventsDigest, events);

        const again = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: 7,
          nowMs: NOW_MS,
        });
        assert.equal(again.cappedItemCount, 0);
        assert.isTrue(again.reachedEnd);
        assert.equal(yield* eventsDigest, events);
      }),
    ),
  );

  it.effect("writes nothing while the gate is closed, and resumes where it stopped", () =>
    fresh(
      Effect.gen(function* () {
        yield* writeFixture;
        const oldCommand = yield* rowOf(idOf("old-command"));

        const stopped = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: 7,
          nowMs: NOW_MS,
          shouldContinue: Effect.succeed(false),
        });
        assert.isTrue(stopped.interrupted);
        assert.equal(stopped.cappedItemCount, 0);
        assert.equal(stopped.throughRowid, 0);

        // Open at the check, closed inside the transaction: the update helper's file appeared.
        const refused = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: 7,
          nowMs: NOW_MS,
          mayDelete: () => false,
        });
        assert.isTrue(refused.interrupted);
        assert.isFalse(refused.reachedEnd);
        assert.equal(refused.cappedItemCount, 0);
        assert.equal(yield* rowOf(idOf("old-command")), oldCommand);

        const resumed = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: 7,
          nowMs: NOW_MS,
          afterRowid: refused.throughRowid,
        });
        assert.equal(resumed.cappedItemCount, 2);
        assert.isTrue(resumed.reachedEnd);
      }),
    ),
  );

  it.effect("caps nothing when the horizon is off", () =>
    fresh(
      Effect.gen(function* () {
        yield* writeFixture;
        const before = yield* rowOf(idOf("old-command"));
        const result = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: null,
          nowMs: NOW_MS,
        });
        assert.equal(result.cappedItemCount, 0);
        assert.isTrue(result.reachedEnd);
        assert.equal(yield* rowOf(idOf("old-command")), before);
      }),
    ),
  );

  it.effect("keeps fields this build does not know, and walks past malformed rows", () =>
    fresh(
      Effect.gen(function* () {
        yield* writeFixture;
        const sql = yield* SqlClient.SqlClient;
        const stored = JSON.parse(yield* rowOf(idOf("old-command"))) as Record<string, unknown>;
        yield* sql`
          UPDATE orchestration_v2_projection_turn_items
          SET payload_json = ${JSON.stringify({ ...stored, futureField: { kept: true } })}
          WHERE turn_item_id = ${idOf("old-command")}
        `;
        // A thread row and an item row no JSON function can read must not stop the window.
        yield* sql`
          UPDATE orchestration_v2_projection_turn_items
          SET payload_json = ${"{not json" + "x".repeat(70_000)}
          WHERE turn_item_id = ${idOf("old-render")}
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads SET payload_json = ${"{broken"}
          WHERE thread_id = ${archived}
        `;
        const result = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: 7,
          nowMs: NOW_MS,
          scanWindow: 100,
        });
        assert.isTrue(result.reachedEnd);
        assert.equal(result.cappedItemCount, 2);
        const after = JSON.parse(yield* rowOf(idOf("old-command"))) as Record<string, unknown>;
        assert.deepStrictEqual(after.futureField, { kept: true });
        assert.isDefined(after.bodyCut);
        assert.isAtMost((after.output as string).length, DEFAULT_TURN_ITEM_BODY_CAP.defaultChars);
        assert.equal(after.input, stored.input);
      }),
    ),
  );
});
