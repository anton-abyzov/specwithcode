/**
 * Away mode carries a thread's queued messages to its continuation (1267
 * AC-04): in delivery order, each cancelled here only once it is there, and
 * a message that cannot go stops the rest, which stay queued here.
 */
import type { RunId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  carryQueuedMessages,
  type QueuedMessage,
  queuedCarryText,
  queuedMessagesFrom,
} from "./HandoffMoves.ts";

const message = (id: string, text: string, attachments = 0): QueuedMessage => ({
  runId: id as RunId,
  text,
  attachments,
});

describe("queuedMessagesFrom", () => {
  it("lists queued runs in delivery order and leaves a child's completion here", () => {
    const records = {
      runs: [
        { id: "r2", status: "queued", userMessageId: "m2", ordinal: 2, queuePosition: 2 },
        { id: "r1", status: "queued", userMessageId: "m1", ordinal: 1, queuePosition: 1 },
        { id: "r0", status: "completed", userMessageId: "m0", ordinal: 0 },
        { id: "r3", status: "queued", userMessageId: "m3", ordinal: 3, queuePosition: 3 },
      ],
      messages: [
        { id: "m0", text: "done", attachments: [] },
        { id: "m1", text: "first", attachments: [] },
        { id: "m2", text: "second", attachments: [{}] },
        { id: "m3", text: "child done", attachments: [], delegatedCompletion: {} },
      ],
    } as never;
    // The child's completion is delivered first here, and never carried.
    expect(queuedMessagesFrom(records)).toEqual([
      { runId: "r1", text: "first", attachments: 0 },
      { runId: "r2", text: "second", attachments: 1 },
    ]);
  });
});

describe("carryQueuedMessages", () => {
  it.effect("sends each in order and cancels it here after it is there", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const text = yield* carryQueuedMessages({
        queued: [message("r1", "first"), message("r2", "second")],
        send: (entry) => Effect.sync(() => (log.push(`send:${entry.runId}`), true)),
        cancel: (entry) => Effect.sync(() => void log.push(`cancel:${entry.runId}`)),
      });
      expect(log).toEqual(["send:r1", "cancel:r1", "send:r2", "cancel:r2"]);
      expect(text).toBe("Its 2 queued messages went too.");
    }),
  );

  it.effect("stops at a message that does not go and keeps the rest here", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const text = yield* carryQueuedMessages({
        queued: [message("r1", "first"), message("r2", "with a file", 1), message("r3", "third")],
        send: (entry) => Effect.sync(() => (log.push(`send:${entry.runId}`), true)),
        cancel: (entry) => Effect.sync(() => void log.push(`cancel:${entry.runId}`)),
      });
      expect(log).toEqual(["send:r1", "cancel:r1"]);
      expect(text).toBe("1 of 3 queued messages went; 2 stay here.");
    }),
  );

  it.effect("cancels nothing here when the other machine refuses", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const text = yield* carryQueuedMessages({
        queued: [message("r1", "first")],
        send: () => Effect.succeed(false),
        cancel: (entry) => Effect.sync(() => void log.push(`cancel:${entry.runId}`)),
      });
      expect(log).toEqual([]);
      expect(text).toBe("Its queued message stays here; send it again on the other machine.");
    }),
  );
});

describe("queuedCarryText", () => {
  it("says nothing without a queue", () => {
    expect(queuedCarryText(0, 0)).toBe("");
    expect(queuedCarryText(1, 1)).toBe("Its queued message went too.");
  });
});
