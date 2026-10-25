import { assert, it } from "@effect/vitest";
import { ProviderThreadId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { childContinuationContext, pendingChildResults } from "./ChildContinuationContext.ts";
import { nativeChildTerminalReceipt } from "./NativeChildTerminalReceipt.ts";
import { settleNativeSubagents } from "./SubagentSettlement.ts";
import {
  at,
  native,
  nativeChild,
  notes,
  PARENT,
  projection,
  PROVIDER_THREAD,
  rowStatus,
  run,
  thread,
  world,
} from "./SubagentHandoffContinuity.testkit.ts";

for (const transition of ["A to B", "A to B to A", "same-provider subscription switch"]) {
  it.effect(`settles only the retired session across ${transition}`, () =>
    Effect.gen(function* () {
      const next = ProviderThreadId.make("new-generation");
      const old = native("old", "first");
      const fresh = native("fresh", "second");
      fresh.item.providerThreadId = next;
      fresh.row.providerThreadId = next;
      const parent = projection({
        thread: thread(PARENT),
        runs: [
          run("first", 1, "completed"),
          run("second", 2, "running", { providerThreadId: next }),
        ],
        subagents: [old, fresh],
      });
      parent.providerThreads = [
        ...parent.providerThreads,
        { ...parent.providerThreads[0]!, id: next },
      ];
      const fixture = world([parent], { live: (id) => id === next });
      yield* fixture.sweep;
      assert.equal(rowStatus(parent, "old").status, "interrupted");
      assert.equal(rowStatus(parent, "fresh").status, "running");
      assert.deepEqual(notes(parent), ["old"]);
    }),
  );
}

it.effect("preserves an old process proved live and settles it only after it is gone", () =>
  Effect.gen(function* () {
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "completed")],
      subagents: [native("live", "first")],
    });
    let live = true;
    const fixture = world([parent], { live: () => live });
    yield* fixture.sweep;
    assert.equal(rowStatus(parent, "live").status, "running");
    live = false;
    yield* fixture.sweep;
    assert.equal(rowStatus(parent, "live").status, "interrupted");
  }),
);

it.effect("reconciles the SEO three quota failures and one completion before any outage", () =>
  Effect.gen(function* () {
    const agents = ["quota1", "quota2", "quota3", "success"].map((id) => native(id, "first"));
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "failed")],
      subagents: agents,
    });
    parent.subagents = parent.subagents.map((child) => ({
      ...child,
      status: child.id === "success" ? "completed" : "failed",
      result: child.id === "success" ? "SEO audit delivered" : "Quota failed",
      completedAt: at(2),
      updatedAt: at(2),
    }));
    const fixture = world([parent], { sessionOpen: false });
    yield* fixture.sweep;
    assert.deepEqual(
      parent.turnItems.map((item) => item.status),
      ["failed", "failed", "failed", "completed"],
    );
    assert.equal(parent.subagents[3]!.result, "SEO audit delivered");
    assert.deepEqual(notes(parent), []);
  }),
);

it.effect("settles a nested native owner chain and leaves app-owned execution linked", () =>
  Effect.gen(function* () {
    const childId = ThreadId.make("nested-child");
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "completed")],
      subagents: [native("nested", "first", childId)],
      extraRows: [
        {
          ...native("delegated", "first").row,
          origin: "app_owned",
          childThreadId: ThreadId.make("delegate"),
        },
      ],
    });
    const child = nativeChild(childId, PARENT);
    const fixture = world([parent, child], { sessionOpen: false });
    yield* fixture.sweep;
    assert.equal(rowStatus(parent, "nested").status, "interrupted");
    assert.equal(rowStatus(parent, "delegated").status, "running");
    assert.equal(child.nodes[0]!.status, "interrupted");
  }),
);

it.effect("preserves a person's Stop as final without a rerun note", () =>
  Effect.gen(function* () {
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "cancelled")],
      subagents: [native("stopped", "first")],
      turnItems: [
        { type: "run_interrupt_request", runId: "first", cause: "user", message: "Stop" },
      ],
    });
    yield* world([parent], { sessionOpen: false }).sweep;
    assert.equal(rowStatus(parent, "stopped").progress, "Stopped by you");
    assert.deepEqual(notes(parent), []);
  }),
);

it("keeps a terminal receipt independently of failed reopen and accepts revised results once", () => {
  const child = {
    ...native("review", "first").row,
    result: null,
    completedAt: null,
    updatedAt: at(0),
  } as never;
  const first = nativeChildTerminalReceipt({
    task: child,
    rootNodeId: "root" as never,
    childRootNodeId: "childroot" as never,
    turnItemId: "item" as never,
    turnItemOrdinal: 1,
    status: "completed",
    result: "First review",
    now: at(1),
  });
  const input = {
    subagents: [first.task],
    runs: [],
    providerTurns: [],
    currentRunId: "replacement",
    target: { providerThreadId: PROVIDER_THREAD, nativeThreadId: "native-B" },
    attempts: [
      {
        id: "attempt",
        runId: "replacement",
        providerThreadId: PROVIDER_THREAD,
        nativeThreadId: "native-B",
      },
    ] as never,
    transfers: [],
  };
  assert.equal(pendingChildResults(input)[0]!.result, "First review");
  // No accepted replacement prompt: an open failure cannot consume the receipt.
  assert.equal(pendingChildResults(input).length, 1);
  const deliveredRun = run("replacement", 2, "completed", {
    activeAttemptId: "attempt",
    nativeThreadId: "native-B",
  });
  const nextRun = run("next", 3, "running", { nativeThreadId: "native-B" });
  const transfer = {
    type: "subagent_result",
    sourceThreadId: first.task.childThreadId,
    sourceRevision: "2026-10-24T10:01:00.000Z",
    targetRunAttemptId: "attempt",
    targetRunId: "replacement",
  } as never;
  const deliveredTurn = { runAttemptId: "attempt", status: "completed", startedAt: at(2) } as never;
  assert.equal(
    pendingChildResults({
      ...input,
      runs: [deliveredRun, nextRun],
      providerTurns: [deliveredTurn],
      currentRunId: "next",
    }).length,
    1,
  );
  assert.equal(
    pendingChildResults({
      ...input,
      runs: [deliveredRun, nextRun],
      providerTurns: [deliveredTurn],
      transfers: [transfer],
      currentRunId: "next",
    }).length,
    0,
  );
  const revised = nativeChildTerminalReceipt({
    task: first.task,
    rootNodeId: "root" as never,
    childRootNodeId: "childroot" as never,
    turnItemId: "item" as never,
    turnItemOrdinal: 1,
    status: "completed",
    result: "Revised review",
    now: at(3),
  });
  assert.equal(
    pendingChildResults({
      ...input,
      subagents: [revised.task],
      runs: [deliveredRun, nextRun],
      providerTurns: [deliveredTurn],
      transfers: [transfer],
      currentRunId: "next",
    })[0]!.result,
    "Revised review",
  );
  assert.equal(revised.events.at(-1)!.type, "subagent.updated");
});

it("carries the original brief, evidence, parent correction and never-replay effects", () => {
  const text = childContinuationContext({
    child: { ...native("payment", "first").row, result: null } as never,
    parentInstructions: "Read only. No resend.",
    plan: "/plans/1053/spec.md T-02 AC-04",
    evidence: ["/proof/mail-receipt"],
    effects: [
      { id: "mail-1", target: "confirmation email", outcome: "committed" },
      { id: "import-1", target: "import", outcome: "outcome-unknown" },
    ],
  });
  for (const expected of [
    "Do payment",
    "No resend",
    "T-02 AC-04",
    "/proof/mail-receipt",
    "NEVER REPLAY",
    "mail-1",
    "outcome-unknown",
    "Stop stays final",
    "billing",
  ])
    assert.include(text, expected);
});

it.effect("does not apply an old terminal item to a resumed row after a partial write", () =>
  Effect.gen(function* () {
    const child = native("resumed-review", "first");
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "completed")],
      subagents: [child],
    });
    parent.subagents = parent.subagents.map((row) => ({
      ...row,
      startedAt: at(2),
      updatedAt: at(2),
      result: null,
    }));
    parent.turnItems = parent.turnItems.map(
      (item) =>
        ({
          ...item,
          status: "completed",
          startedAt: at(0),
          completedAt: at(1),
          updatedAt: at(1),
          result: "SHIP old changes",
        }) as never,
    );
    const settled = yield* settleNativeSubagents({
      projection: parent,
      status: "interrupted",
      now: at(3),
      allocateEventId: () => Effect.succeed("event" as never),
    });
    const update = settled.events.find((event) => event.type === "subagent.updated");
    assert.equal(update?.payload.status, "interrupted");
    assert.equal((update?.payload as (typeof parent.subagents)[number]).result, null);
    assert.deepEqual([...settled.lostWork.keys()], [PROVIDER_THREAD]);
  }),
);

it.effect("the full sweep interrupts a resumed child instead of applying an old receipt", () =>
  Effect.gen(function* () {
    const childId = ThreadId.make("resumed-child-generation");
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "completed")],
      subagents: [native("resumed-review", "first", childId)],
    });
    parent.subagents = parent.subagents.map((row) => ({
      ...row,
      startedAt: at(2),
      updatedAt: at(2),
      result: null,
    }));
    parent.turnItems = parent.turnItems.map(
      (item) =>
        ({
          ...item,
          status: "completed",
          startedAt: at(0),
          completedAt: at(1),
          updatedAt: at(1),
          result: "SHIP old changes",
        }) as never,
    );
    const child = nativeChild(childId, PARENT);
    child.nodes = child.nodes.map((node) => ({ ...node, startedAt: at(2) }));
    yield* world([parent, child], { sessionOpen: false }).sweep;
    assert.equal(parent.subagents[0]?.status, "interrupted");
    assert.equal(child.nodes[0]?.status, "interrupted");
    assert.equal(child.turnItems[0]?.status, "interrupted");
  }),
);

it.effect("the sweep preserves a valid row receipt when only its item needs closing", () =>
  Effect.gen(function* () {
    const childId = ThreadId.make("completed-row-open-item");
    const parent = projection({
      thread: thread(PARENT),
      runs: [run("first", 1, "completed")],
      subagents: [native("completed-review", "first", childId)],
    });
    parent.subagents = parent.subagents.map((row) => ({
      ...row,
      status: "completed",
      startedAt: at(0),
      completedAt: at(1),
      updatedAt: at(1),
      result: "SHIP current changes",
    }));
    parent.turnItems = parent.turnItems.map((item) => ({ ...item, startedAt: at(0) }) as never);
    const child = nativeChild(childId, PARENT);
    child.nodes = child.nodes.map((node) => ({ ...node, startedAt: at(0) }));
    yield* world([parent, child], { sessionOpen: false }).sweep;
    assert.equal(parent.subagents[0]?.status, "completed");
    assert.equal(child.nodes[0]?.status, "completed");
    assert.equal(child.turnItems[0]?.status, "completed");
  }),
);
