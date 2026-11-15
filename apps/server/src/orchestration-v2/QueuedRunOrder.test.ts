import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("merges completions and queued messages by request time, keeping each queue order", () => {
    const projection = {
      messages: [
        { id: "message:old" },
        { id: "message:moved" },
        { id: "message:earlier-completion", delegatedCompletion },
        { id: "message:later-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });

  it("does not hold a queued message behind completions that arrive after it", () => {
    const projection = {
      messages: [
        { id: "message:first-completion", delegatedCompletion },
        { id: "message:visible" },
        { id: "message:second-completion", delegatedCompletion },
        { id: "message:third-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:first-completion",
          ordinal: 2,
          queuePosition: 1,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:first-completion",
        },
        {
          id: "run:visible",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:01:00"),
          status: "queued",
          userMessageId: "message:visible",
        },
        {
          id: "run:second-completion",
          ordinal: 4,
          queuePosition: 3,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:second-completion",
        },
        {
          id: "run:third-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:third-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:first-completion",
      "run:visible",
      "run:second-completion",
      "run:third-completion",
    ]);
  });

  it("delivers a completion first when it was requested at the same time as a message", () => {
    const projection = {
      messages: [{ id: "message:visible" }, { id: "message:completion", delegatedCompletion }],
      runs: [
        {
          id: "run:visible",
          ordinal: 2,
          queuePosition: 1,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:visible",
        },
        {
          id: "run:completion",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:completion",
        },
        {
          id: "run:finished",
          ordinal: 1,
          queuePosition: null,
          requestedAt: at("09:00:00"),
          status: "completed",
          userMessageId: "message:visible",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:completion",
      "run:visible",
    ]);
  });
});
