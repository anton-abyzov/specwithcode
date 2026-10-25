import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import {
  decideToolItemPersist,
  TURN_ITEM_TIME_ONLY_REFRESH_MS,
  TOOL_ITEM_PERSIST_INTERVAL_MS,
  turnItemContentKey,
} from "./toolItemPersistence.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const command = (
  output: string,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("turn-item:gate"),
  threadId: ThreadId.make("thread:gate"),
  runId: null,
  nodeId: NodeId.make("node:gate"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: "Run build",
  startedAt: at(0),
  completedAt: null,
  updatedAt: at(0),
  type: "command_execution",
  input: "build",
  output,
  ...overrides,
});

describe("decideToolItemPersist", () => {
  it("stores the first update", () => {
    assert.equal(
      decideToolItemPersist({ previous: undefined, next: command("a"), now: 0 }),
      "emit",
    );
  });

  it("drops an update that only moves updatedAt", () => {
    const previous = { item: command("a"), at: 0 };
    assert.equal(
      decideToolItemPersist({ previous, next: command("a", { updatedAt: at(5_000) }), now: 5_000 }),
      "skip",
    );
  });

  it("stores an update that only moves updatedAt once the stored one is a minute old", () => {
    const previous = { item: command("a"), at: 0 };
    const unchangedAt = (now: number) =>
      decideToolItemPersist({ previous, next: command("a", { updatedAt: at(now) }), now });
    assert.equal(unchangedAt(TURN_ITEM_TIME_ONLY_REFRESH_MS - 1), "skip");
    assert.equal(unchangedAt(TURN_ITEM_TIME_ONLY_REFRESH_MS), "emit");
    assert.equal(unchangedAt(TURN_ITEM_TIME_ONLY_REFRESH_MS + 30_000), "emit");
  });

  it("holds progress inside the interval and stores it after", () => {
    const previous = { item: command("a"), at: 1_000 };
    assert.equal(decideToolItemPersist({ previous, next: command("ab"), now: 1_100 }), "hold");
    assert.equal(
      decideToolItemPersist({
        previous,
        next: command("ab"),
        now: 1_000 + TOOL_ITEM_PERSIST_INTERVAL_MS,
      }),
      "emit",
    );
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] as const)(
    "stores a %s end at once, even unchanged",
    (status) => {
      const previous = { item: command("a"), at: 0 };
      assert.equal(
        decideToolItemPersist({ previous, next: command("a", { status }), now: 1 }),
        "emit",
      );
    },
  );

  it("stores a status or title change at once", () => {
    const previous = { item: command("a"), at: 0 };
    assert.equal(
      decideToolItemPersist({ previous, next: command("a", { status: "waiting" }), now: 1 }),
      "emit",
    );
    assert.equal(
      decideToolItemPersist({ previous, next: command("a", { title: "Run tests" }), now: 1 }),
      "emit",
    );
  });

  it("compares with a precomputed key", () => {
    const item = command("a");
    const previous = { item, at: 0, key: turnItemContentKey(item) };
    assert.equal(
      decideToolItemPersist({
        previous,
        next: command("a", { updatedAt: at(9) }),
        nextKey: turnItemContentKey(command("a", { updatedAt: at(9) })),
        now: 9,
      }),
      "skip",
    );
  });
});
