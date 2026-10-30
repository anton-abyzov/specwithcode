import { expect, it } from "vite-plus/test";
import {
  CommandId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { reopensClosedCard, userInputRuntimeRequest } from "./userInputRuntimeRequest.ts";

it("keeps card creation separate from original ask provenance and leaves normal requests unchanged", () => {
  const now = DateTime.makeUnsafe("2026-10-29T15:00:00Z");
  const command = {
    type: "user_input_request.record" as const,
    commandId: CommandId.make("record"),
    threadId: ThreadId.make("t"),
    runId: RunId.make("run"),
    nodeId: NodeId.make("root"),
    requestNodeId: NodeId.make("request-node"),
    requestId: RuntimeRequestId.make("update-reopen:q1"),
    turnItemId: TurnItemId.make("item"),
    questions: [],
  };
  const original = "2026-10-29T13:00:00Z";
  const reopened = userInputRuntimeRequest(
    { ...command, reopenedFromAskedAt: original },
    null,
    now,
  );
  expect(reopened.reopenedFromAskedAt).toBe(original);
  expect(reopened.createdAt).toEqual(now);
  expect(reopened.responseCapability).toEqual({ type: "message" });
  expect(userInputRuntimeRequest(command, null, now)).not.toHaveProperty("reopenedFromAskedAt");
  expect(
    userInputRuntimeRequest({ ...command, reopenedFromAskedAt: null }, null, now)
      .reopenedFromAskedAt,
  ).toBeNull();
});

it("puts back only a reopened card that a later update closed", () => {
  const command = {
    type: "user_input_request.record" as const,
    commandId: CommandId.make("record"),
    threadId: ThreadId.make("t"),
    runId: RunId.make("run"),
    nodeId: NodeId.make("root"),
    requestNodeId: NodeId.make("node:update-reopen:q1"),
    requestId: RuntimeRequestId.make("update-reopen:q1"),
    turnItemId: TurnItemId.make("turn-item:update-reopen:q1"),
    questions: [],
    reopenedFromAskedAt: null,
  };
  const dismissed = {
    kind: "user_input" as const,
    status: "resolved" as const,
    decision: "cancel" as const,
  };
  expect(reopensClosedCard(command, dismissed)).toBe(true);
  expect(reopensClosedCard(command, { kind: "user_input", status: "cancelled" })).toBe(true);
  // Open, or answered: left as it is.
  expect(reopensClosedCard(command, { kind: "user_input", status: "pending" })).toBe(false);
  expect(
    reopensClosedCard(command, {
      kind: "user_input",
      status: "resolved",
      answers: { q: "Postgres" },
    }),
  ).toBe(false);
  // An agent's own question, or a record that is no update reopen, is never put back.
  expect(
    reopensClosedCard({ ...command, requestId: RuntimeRequestId.make("ask-user:q1") }, dismissed),
  ).toBe(false);
  const { reopenedFromAskedAt: _omitted, ...plain } = command;
  expect(reopensClosedCard(plain, dismissed)).toBe(false);
});
