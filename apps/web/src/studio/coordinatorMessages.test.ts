import type { CoordinatorMessageView } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  coordinatorMessageRow,
  coordinatorMessageStartsOpen,
  coordinatorMessageStateLabel,
  placeOutgoingMessages,
  coordinatorMessageRoots,
  repliesTo,
  rowMessages,
  stepNotification,
  stepsToNotify,
  stepsToRaise,
  coordinatorStepEventKey,
} from "./coordinatorMessages";

const ID = `cm-${"a".repeat(40)}`;
const OTHER = `cm-${"b".repeat(40)}`;

function message(over: Partial<CoordinatorMessageView> = {}): CoordinatorMessageView {
  return {
    id: ID,
    externalId: "ext-1",
    direction: "incoming",
    peerEnvironmentId: "env-m5",
    kind: "finding",
    subject: "Tests fail on main",
    text: "Two tests fail.",
    refs: [],
    count: 1,
    state: "delivered",
    receivedAt: 1,
    updatedAt: 1,
    ...over,
  } as CoordinatorMessageView;
}

describe("coordinatorMessageRow", () => {
  it("reads the record id from a single message and a digest", () => {
    expect(coordinatorMessageRow(`coordinator-message:${ID}:2`)).toEqual({
      recordId: ID,
      digest: false,
    });
    expect(coordinatorMessageRow(`coordinator-message:${ID}:2:1`)).toEqual({
      recordId: ID,
      digest: false,
    });
    expect(coordinatorMessageRow(`coordinator-message-digest:${ID}:${"c".repeat(24)}`)).toEqual({
      recordId: ID,
      digest: true,
    });
  });
  it("ignores every other conversation message", () => {
    expect(coordinatorMessageRow("msg-1")).toBeNull();
    expect(coordinatorMessageRow(`coordinator-message:${ID}`)).toBeNull();
    expect(coordinatorMessageRow(`coordinator-message:cm-xyz:1`)).toBeNull();
  });
});

describe("rowMessages", () => {
  it("shows one message, or every message a digest's turn carried", () => {
    const first = message({ wokenRunId: "run-9", receivedAt: 2 });
    const second = message({ id: OTHER, wokenRunId: "run-9", receivedAt: 1 });
    const other = message({ id: `cm-${"d".repeat(40)}`, wokenRunId: "run-1" });
    const all = [first, second, other];
    const byId = new Map(all.map((each) => [each.id, each]));
    expect(rowMessages({ recordId: ID, digest: false }, byId, all)).toEqual([first]);
    expect(rowMessages({ recordId: ID, digest: true }, byId, all)).toEqual([second, first]);
    expect(rowMessages({ recordId: `cm-${"9".repeat(40)}`, digest: false }, byId, all)).toEqual([]);
  });
});

describe("coordinatorMessageStartsOpen", () => {
  it("opens only a problem with a step", () => {
    const step = { environmentId: "env-m5", text: "Sign in to Claude" };
    expect(
      coordinatorMessageStartsOpen(message({ kind: "problem", userStep: step } as never)),
    ).toBe(true);
    expect(coordinatorMessageStartsOpen(message({ kind: "problem" }))).toBe(false);
    expect(
      coordinatorMessageStartsOpen(message({ kind: "request", userStep: step } as never)),
    ).toBe(false);
  });
});

describe("repliesTo", () => {
  it("matches the sender's id or the receiver's, oldest first", () => {
    const asked = message({ direction: "outgoing", externalId: "out-1" as never });
    const late = message({ id: OTHER, kind: "reply", replyTo: "out-1" as never, receivedAt: 9 });
    const early = message({
      id: `cm-${"d".repeat(40)}`,
      kind: "reply",
      replyTo: "out-1" as never,
      receivedAt: 3,
    });
    const unrelated = message({ id: `cm-${"e".repeat(40)}`, kind: "reply", replyTo: "x" as never });
    expect(repliesTo(asked, [late, unrelated, early, asked]).map((m) => m.receivedAt)).toEqual([
      3, 9,
    ]);
    const byReceiver = message({ receiverMessageId: "rcv-1" as never });
    const reply = message({ id: OTHER, kind: "reply", replyTo: "rcv-1" as never });
    expect(repliesTo(byReceiver, [reply])).toEqual([reply]);
  });
});

describe("coordinatorMessageRoots", () => {
  it("lists each reply once, under its message, oldest first", () => {
    const asked = message({ direction: "outgoing", externalId: "out-1" as never, receivedAt: 5 });
    const reply = message({ id: OTHER, kind: "reply", replyTo: "out-1" as never, receivedAt: 9 });
    const orphan = message({
      id: `cm-${"e".repeat(40)}`,
      kind: "reply",
      replyTo: "gone" as never,
      receivedAt: 2,
    });
    expect(coordinatorMessageRoots([reply, asked, orphan]).map((m) => m.receivedAt)).toEqual([
      2, 5,
    ]);
  });
});

describe("coordinatorMessageStateLabel", () => {
  it("names each state in words, with the machine where it matters", () => {
    expect(coordinatorMessageStateLabel(message({ state: "queued" }), "M5")?.text).toBe("Queued");
    expect(
      coordinatorMessageStateLabel(message({ state: "delivered", direction: "outgoing" }), "M5")
        ?.text,
    ).toBe("Delivered");
    expect(coordinatorMessageStateLabel(message({ state: "delivered" }), "M5")).toBeNull();
    expect(coordinatorMessageStateLabel(message({ state: "not_delivered" }), "M5")).toEqual({
      text: "Not delivered: {machine} was offline for 24 hours",
      values: { machine: "M5" },
      tone: "warning",
    });
    expect(coordinatorMessageStateLabel(message({ state: "revoked" }), "M5")?.values).toEqual({
      machine: "M5",
    });
    expect(coordinatorMessageStateLabel(message({ state: "folded" }), "M5")?.text).toBe("Arriving");
    expect(coordinatorMessageStateLabel(message({ state: "quiet" }), "M5")).toBeNull();
  });
});

describe("placeOutgoingMessages", () => {
  it("puts each sent message under the last row of the turn that sent it", () => {
    const sent = message({ direction: "outgoing", sourceRunId: "run-1", receivedAt: 5 });
    const lost = message({
      id: OTHER,
      direction: "outgoing",
      sourceRunId: "run-gone",
      receivedAt: 6,
    });
    const incoming = message({ id: `cm-${"f".repeat(40)}` });
    const placed = placeOutgoingMessages(
      [lost, incoming, sent],
      [
        { id: "a", runId: "run-1" },
        { id: "b", runId: "run-1" },
        { id: "c", runId: null },
      ],
    );
    expect([...placed.byRow.entries()]).toEqual([["b", [sent]]]);
    expect(placed.rest).toEqual([lost]);
  });
});

describe("stepsToNotify", () => {
  const step = { environmentId: "env-m4", text: "Sign in" };
  it("notifies an incoming step once", () => {
    const withStep = message({ userStep: step } as never);
    expect(stepsToNotify([withStep], new Set())).toEqual([withStep]);
    expect(stepsToNotify([withStep], new Set([ID]))).toEqual([]);
  });
  it("skips sent messages, ones without a step and ones not yet delivered", () => {
    expect(
      stepsToNotify(
        [
          message({ userStep: step, direction: "outgoing" } as never),
          message({ id: OTHER }),
          message({ userStep: step, state: "settling" } as never),
          message({ userStep: step, state: "revoked" } as never),
        ],
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe("stepNotification", () => {
  it("leads with the machine the step is done on", () => {
    const tx = (text: string, values: Readonly<Record<string, string>>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
    expect(
      stepNotification({
        step: "Sign in to Claude",
        stepMachine: "M4",
        sender: "M5",
        project: "specweave",
        tx,
      }),
    ).toEqual({
      title: "On M4: Sign in to Claude",
      body: "From M5's coordinator · specweave",
    });
  });
});

describe("stepsToRaise", () => {
  const step = { environmentId: "env-m4", text: "Sign in" };
  it("raises a step received after the baseline, once", () => {
    const fresh = message({ userStep: step, receivedAt: 2_000 } as never);
    expect(stepsToRaise([fresh], new Set(), 1_000)).toEqual([fresh]);
    expect(stepsToRaise([fresh], new Set([ID]), 1_000)).toEqual([]);
  });
  it("leaves history from before the window opened alone", () => {
    const old = message({ userStep: step, receivedAt: 500 } as never);
    expect(stepsToRaise([old], new Set(), 1_000)).toEqual([]);
  });
  it("keys the notification by machine and message, so a merged repeat stays silent", () => {
    expect(coordinatorStepEventKey("env-m5", ID)).toBe(coordinatorStepEventKey("env-m5", ID));
    expect(coordinatorStepEventKey("env-m5", ID)).not.toBe(coordinatorStepEventKey("env-m4", ID));
  });
});
