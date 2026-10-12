import { describe, expect, it } from "vite-plus/test";

import {
  CoordinatorReplyWaiter,
  REPLY_SETTLE_MS,
  REPLY_TIMEOUT_MESSAGE,
  REPLY_TIMEOUT_MS,
  type CoordinatorReplySnapshot,
} from "./voiceCallReply";

type Message = CoordinatorReplySnapshot["messages"][number];
type Run = CoordinatorReplySnapshot["runs"][number];

const message = (
  id: string,
  role: Message["role"],
  options: { text?: string; streaming?: boolean; runId?: string | null } = {},
): Message => ({
  id,
  role,
  text: options.text ?? id,
  streaming: options.streaming ?? false,
  runId: options.runId ?? null,
});

const run = (id: string, userMessageId: string, status: string, ordinal = 1): Run => ({
  id,
  userMessageId,
  status,
  ordinal,
});

const snapshot = (
  messages: Message[],
  runs: Run[] = [],
  failure: CoordinatorReplySnapshot["failure"] = null,
): CoordinatorReplySnapshot => ({ loaded: true, messages, runs, failure });

describe("CoordinatorReplyWaiter", () => {
  const history = [
    message("u0", "user"),
    message("a0", "assistant", { text: "old answer", runId: "r0" }),
  ];
  const oldRun = run("r0", "u0", "completed");

  it("waits for the spoken message, its turn and a finished reply", () => {
    const waiter = new CoordinatorReplyWaiter(snapshot(history), "status?");
    expect(waiter.observe(snapshot(history, [oldRun]), 0)).toEqual({ kind: "pending" });
    const asked = [...history, message("u1", "user", { text: "status?" })];
    expect(waiter.observe(snapshot(asked, [oldRun]), 0)).toEqual({ kind: "pending" });
    expect(waiter.observe(snapshot(asked, [oldRun, run("r1", "u1", "queued", 2)]), 0)).toEqual({
      kind: "pending",
    });
    const streaming = [...asked, message("a1", "assistant", { streaming: true, runId: "r1" })];
    expect(waiter.observe(snapshot(streaming, [oldRun, run("r1", "u1", "running", 2)]), 0)).toEqual(
      { kind: "pending" },
    );
    const done = [
      ...asked,
      message("a1", "assistant", { text: "Looking.", runId: "r1" }),
      message("a2", "assistant", { text: "All green.", runId: "r1" }),
    ];
    expect(waiter.observe(snapshot(done, [oldRun, run("r1", "u1", "completed", 2)]), 0)).toEqual({
      kind: "reply",
      text: "All green.",
    });
  });

  it("gives a finished turn time for its message to arrive, then ends with no text", () => {
    const waiter = new CoordinatorReplyWaiter(snapshot(history), "status?");
    const asked = snapshot(
      [...history, message("u1", "user", { text: "status?" })],
      [run("r1", "u1", "completed", 2)],
    );
    expect(waiter.observe(asked, 1_000)).toEqual({ kind: "pending" });
    expect(waiter.observe(asked, 1_000 + REPLY_SETTLE_MS)).toEqual({ kind: "reply", text: null });
  });

  it("reports the failure of its own turn", () => {
    const waiter = new CoordinatorReplyWaiter(snapshot(history), "status?");
    const asked = [...history, message("u1", "user", { text: "status?" })];
    expect(
      waiter.observe(
        snapshot(asked, [run("r1", "u1", "failed", 2)], {
          runId: "r1",
          message: "Provider is offline.",
        }),
        0,
      ),
    ).toEqual({ kind: "failed", message: "Provider is offline." });
  });

  it("ignores host-written user messages and answers the caller's own", () => {
    const waiter = new CoordinatorReplyWaiter(snapshot(history), "status?");
    const finished = {
      ...message("n1", "user", { text: "Worker thread finished." }),
      delegatedCompletion: { parentRunId: "r0", generation: 1, taskIds: [] },
    };
    const messages = [
      ...history,
      finished,
      message("a1", "assistant", { text: "Noted the worker.", runId: "rn" }),
      message("u1", "user", { text: "status?" }),
      message("a2", "assistant", { text: "All green.", runId: "r1" }),
    ];
    const runs = [run("rn", "n1", "completed", 2), run("r1", "u1", "completed", 3)];
    expect(waiter.observe(snapshot(messages, runs), 0)).toEqual({
      kind: "reply",
      text: "All green.",
    });
  });

  it("does not take an earlier identical question for the new one", () => {
    const repeated = [
      message("u0", "user", { text: "status?" }),
      message("a0", "assistant", { text: "old answer", runId: "r0" }),
    ];
    const waiter = new CoordinatorReplyWaiter(snapshot(repeated), "status?");
    expect(waiter.observe(snapshot(repeated, [run("r0", "u0", "completed")]), 0)).toEqual({
      kind: "pending",
    });
  });

  it("stops waiting after the reply timeout", () => {
    const waiter = new CoordinatorReplyWaiter(snapshot(history), "status?");
    const asked = snapshot(
      [...history, message("u1", "user", { text: "status?" })],
      [run("r1", "u1", "running", 2)],
    );
    expect(waiter.observe(asked, 1_000)).toEqual({ kind: "pending" });
    expect(waiter.observe(asked, 1_000 + REPLY_TIMEOUT_MS)).toEqual({
      kind: "failed",
      message: REPLY_TIMEOUT_MESSAGE,
    });
  });
});
