import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { capTurnItemBody, DEFAULT_TURN_ITEM_BODY_CAP } from "./TurnItemBodyCap.ts";

const AT = DateTime.makeUnsafe("2026-03-01T00:00:00.000Z");
const threadId = ThreadId.make("thread:body-cap");
const base = {
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
};

/** A 617 KB file read, as Claude stores a Read result. */
const fileText = Array.from({ length: 14_000 }, (_, line) => `line ${line}: ${"x".repeat(40)}`)
  .join("\n")
  .slice(0, 617 * 1024);
const readItem = (output: unknown = fileText, toolName = "Read"): OrchestrationV2TurnItem => ({
  ...base,
  id: TurnItemId.make("turn-item:body-cap:read"),
  type: "dynamic_tool",
  toolName,
  input: { file_path: "/repo/big.log" },
  output,
});

describe("capTurnItemBody", () => {
  it("keeps the head and tail of a large read and records the cut", () => {
    const capped = capTurnItemBody(readItem());
    assert.equal(capped.type, "dynamic_tool");
    if (capped.type !== "dynamic_tool") return;
    const output = capped.output as string;
    // The note fits inside the cap: head, note and tail are 16 KB at most.
    assert.isAtMost(output.length, DEFAULT_TURN_ITEM_BODY_CAP.readChars);
    assert.isTrue(output.startsWith(fileText.slice(0, 11 * 1024)));
    assert.isTrue(output.endsWith(fileText.slice(-(3 * 1024))));
    assert.include(output, "SpecWithCode saved 16 KB of 617 KB");
    assert.deepEqual(capped.bodyCut?.fields, ["output"]);
    assert.equal(capped.bodyCut?.originalBytes, Buffer.byteLength(fileText));
    assert.equal(capped.bodyCut?.reason, "write-cap");
    assert.match(capped.bodyCut?.sha256 ?? "", /^[0-9a-f]{64}$/);
    // Capping again changes nothing: a re-emitted item keeps its first record.
    assert.strictEqual(capTurnItemBody(capped), capped);
  });

  it("caps output that quotes an earlier cut note like any other", () => {
    // A thread read or a grep can quote the note of an item cut before.
    const quoted = `${"q".repeat(1_000_000)}\n[… SpecWithCode saved 16 KB of 617 KB here: the start and the end, 601 KB cut …]\n${"r".repeat(1_000_000)}`;
    const capped = capTurnItemBody(readItem(quoted, "mcp__studio-code__studio_thread_read"));
    if (capped.type !== "dynamic_tool") return assert.fail("dynamic_tool");
    assert.isAtMost((capped.output as string).length, DEFAULT_TURN_ITEM_BODY_CAP.readChars);
    assert.deepEqual(capped.bodyCut?.fields, ["output"]);
    assert.strictEqual(capTurnItemBody(capped), capped);
  });

  it("saves a structure of many short strings as cut JSON text", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      id: index,
      text: `${index}:${"s".repeat(900)}`,
    }));
    const capped = capTurnItemBody(readItem({ structuredContent: { rows } }, "mcp__search__list"));
    if (capped.type !== "dynamic_tool") return assert.fail("dynamic_tool");
    const output = capped.output as string;
    assert.isString(output);
    assert.isAtMost(output.length, DEFAULT_TURN_ITEM_BODY_CAP.defaultChars);
    assert.isTrue(output.startsWith('{"structuredContent":{"rows":[{"id":0,'));
    assert.include(output, "SpecWithCode saved 64 KB of");
    assert.deepEqual(capped.bodyCut?.fields, ["output"]);
    assert.strictEqual(capTurnItemBody(capped), capped);
    // With an image among the strings the shape stays, images whole.
    const data = "C".repeat(10_000);
    const withImage = capTurnItemBody(
      readItem(
        { rows, image: { type: "image", data, mimeType: "image/png" } },
        "mcp__search__list",
      ),
    );
    if (withImage.type !== "dynamic_tool") return assert.fail("dynamic_tool");
    assert.equal((withImage.output as { image: { data: string } }).image.data, data);
  });

  it("leaves small items, images, HTML renders and other item types alone", () => {
    const small = readItem("short");
    assert.strictEqual(capTurnItemBody(small), small);
    const image = readItem([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(700_000) },
      },
    ]);
    assert.strictEqual(capTurnItemBody(image), image);
    const render: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("turn-item:body-cap:render"),
      type: "dynamic_tool",
      toolName: "mcp__studio-code__html_render",
      input: {},
      output: "h".repeat(200_000),
    };
    assert.strictEqual(capTurnItemBody(render), render);
    const message: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("turn-item:body-cap:message"),
      type: "assistant_message",
      messageId: "message:body-cap" as never,
      text: "t".repeat(300_000),
      streaming: false,
    };
    assert.strictEqual(capTurnItemBody(message), message);
  });

  it("cuts long text blocks around an image without touching the image", () => {
    const data = "B".repeat(400_000);
    const capped = capTurnItemBody(
      readItem({
        content: [
          { type: "text", text: "t".repeat(300_000) },
          { type: "image", data, mimeType: "image/png" },
        ],
      }),
    );
    if (capped.type !== "dynamic_tool") return assert.fail("dynamic_tool");
    const content = (capped.output as { content: Array<Record<string, string>> }).content;
    assert.equal(content[1]?.data, data);
    assert.isBelow(content[0]?.text?.length ?? 0, 17 * 1024);
  });

  it("caps command output at 64 KB and keeps file patches whole", () => {
    const command = capTurnItemBody({
      ...base,
      id: TurnItemId.make("turn-item:body-cap:command"),
      type: "command_execution",
      input: "cat big.log",
      output: "o".repeat(500_000),
    });
    if (command.type !== "command_execution") return assert.fail("command");
    assert.isBelow(command.output?.length ?? 0, 64 * 1024 + 300);
    assert.isAbove(command.output?.length ?? 0, 64 * 1024 - 1);
    const change: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("turn-item:body-cap:diff"),
      type: "file_change",
      fileName: "a.txt",
      changes: [{ operation: "update", path: "a.txt", diffStr: "+".repeat(300_000) }],
    };
    assert.strictEqual(capTurnItemBody(change), change);
  });
});

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(layerStores, EventSink.layer.pipe(Layer.provide(layerStores)));

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

describe("tool body cap on write", () => {
  it.effect("stores the same capped item in the event and the projection, and reads it back", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:body-cap:created"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: AT,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project:body-cap"),
              title: "Body cap",
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: AT,
              updatedAt: AT,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      // Running then completed, as adapters emit them: both snapshots are capped.
      for (const status of ["running", "completed"] as const) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:body-cap:read:${status}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: AT,
              payload: { ...readItem(), status },
            },
          ],
        });
      }
      const events = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'turn-item.updated'
        ORDER BY sequence
      `;
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
      `;
      assert.equal(events.length, 2);
      for (const event of events) assert.isBelow(event.payload_json.length, 17 * 1024);
      const item = yield* store.getTurnItem({
        threadId,
        itemId: TurnItemId.make("turn-item:body-cap:read"),
      });
      if (item?.type !== "dynamic_tool") return assert.fail("dynamic_tool");
      const output = item.output as string;
      assert.isTrue(output.startsWith(fileText.slice(0, 1000)));
      assert.isTrue(output.endsWith(fileText.slice(-1000)));
      assert.include(output, "SpecWithCode saved");
      assert.equal(item.bodyCut?.originalBytes, Buffer.byteLength(fileText));
      // The projection row holds exactly what the newest event holds.
      const fromEvent = JSON.parse(events.at(-1)?.payload_json ?? "{}") as { output: string };
      const fromRow = JSON.parse(rows[0]?.payload_json ?? "{}") as { output: string };
      assert.strictEqual(fromRow.output, fromEvent.output);
      assert.strictEqual(fromRow.output, output);
    }).pipe(Effect.provide(layerTest)),
  );
});
