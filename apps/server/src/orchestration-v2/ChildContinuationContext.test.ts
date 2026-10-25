import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2Subagent } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import {
  childContinuationContext,
  childContinuationPointer,
  childResultRevision,
  deliveredChildResults,
  fitChildContinuations,
  pendingChildResults,
  needsPortableChildContext,
} from "./ChildContinuationContext.ts";

const at = DateTime.makeUnsafe("2026-10-24T04:51:00Z");
const child = (id: string, result: string | null, status = "completed") =>
  ({
    id,
    threadId: "thread:parent",
    origin: "provider_native",
    prompt: `Review PR ${id} read-only. ${"Context. ".repeat(200)}`,
    result,
    status,
    childThreadId: `thread:child:${id}`,
    providerThreadId: "provider-thread:old-account",
    updatedAt: at,
  }) as unknown as OrchestrationV2Subagent;

// Committed under the old account generation, before the subscription switch.
const effects = [
  { id: "turn:7:email-send:3", target: "payment confirmation to club 12", outcome: "committed" },
  { id: "turn:7:backfill:3", target: "ledger backfill 2026-10", outcome: "committed" },
];
const brief = (subagent: OrchestrationV2Subagent) => ({
  id: subagent.id,
  revision: childResultRevision(subagent),
  full: childContinuationContext({ child: subagent, parentInstructions: "Continue", effects }),
  pointer: childContinuationPointer({
    child: subagent,
    effectIds: effects.map((effect) => effect.id),
  }),
});
const bytes = (text: string) => Buffer.byteLength(text);

describe("child continuation fit", () => {
  const children = [child("491", "Clean review"), child("492", null, "interrupted")].map(brief);

  it("sends whole briefs while they fit the measured room", () => {
    const fit = fitChildContinuations({ children, budget: 64_000 });
    assert.equal(fit.pointerOnly, 0);
    assert.equal(fit.omitted, 0);
    assert.include(fit.text, "Review PR 491");
    assert.include(fit.text, "NEVER REPLAY committed operations");
    assert.isAtMost(bytes(fit.text), 64_000);
  });

  it("falls back to pointers that keep identity, retrieval and no-replay", () => {
    const budget = bytes(children[0]!.full) + 600;
    const fit = fitChildContinuations({ children, budget: budget + 600 });
    assert.equal(fit.pointerOnly, 1);
    assert.include(fit.text, "Review PR 491");
    assert.include(fit.text, "Child continuation 492 (pointer only");
    assert.include(fit.text, 'studio_thread_read({threadId:"thread:child:492"');
    assert.include(
      fit.text,
      "NEVER REPLAY committed operations: turn:7:email-send:3, turn:7:backfill:3",
    );
    assert.include(fit.text, "receipt revision 2026-10-24T04:51:00.000Z");
    assert.notInclude(fit.text, "Review PR 492");
  });

  it("goes pointer-only for every child when the room is small", () => {
    const fit = fitChildContinuations({ children, budget: 1_400 });
    assert.equal(fit.pointerOnly, 2);
    assert.isAtMost(bytes(fit.text), 1_400);
    assert.notInclude(fit.text, "Context. Context.");
  });

  it("names children that do not fit even as pointers, without replay", () => {
    const fit = fitChildContinuations({ children, budget: 200 });
    assert.equal(fit.omitted, 2);
    assert.include(fit.text, "2 more child continuations did not fit");
    assert.include(fit.text, "never replay a committed operation");
  });

  it("never treats a missing effect inventory as proof that nothing ran", () => {
    const subagent = child("seo", null, "interrupted");
    assert.include(
      childContinuationPointer({ child: subagent }),
      "none listed; absence is not proof that none ran",
    );
    assert.include(
      childContinuationContext({ child: subagent, parentInstructions: "Continue" }),
      "Absence is not proof that no operation ran",
    );
  });
});

describe("child result delivery", () => {
  const review = child("review", "SHIP revision 2");
  const audit = child("audit", "Audit clean");
  // What the turn-start service records for the receipts an envelope delivered.
  const markers = (receipts: ReadonlyArray<OrchestrationV2Subagent>, attempt: string) =>
    receipts.map((receipt) => ({
      type: "subagent_result",
      sourceThreadId: receipt.childThreadId,
      sourceRevision: childResultRevision(receipt),
      targetRunAttemptId: attempt,
      targetRunId: "replacement",
    })) as never;
  const pending = (
    subagents: ReadonlyArray<OrchestrationV2Subagent>,
    transfers: never = [] as never,
  ) =>
    pendingChildResults({
      subagents,
      runs: [{ id: "replacement", providerThreadId: "B", nativeThreadId: "native-B" }] as never,
      providerTurns: [{ status: "completed", runAttemptId: "attempt-2" }] as never,
      currentRunId: "replacement",
      transfers,
      target: { providerThreadId: "B", nativeThreadId: "native-B" } as never,
      attempts: [
        {
          id: "attempt-2",
          runId: "replacement",
          providerThreadId: "B",
          nativeThreadId: "native-B",
        },
      ] as never,
    });

  it("keeps a result the envelope only counted pending after the target turn completes", () => {
    const receipts = pending([review]);
    const fit = fitChildContinuations({ children: receipts.map(brief), budget: 200 });
    assert.equal(fit.omitted, 1);
    assert.deepEqual(fit.included, []);
    assert.notInclude(fit.text, review.id);
    assert.notInclude(fit.text, "SHIP revision 2");
    const delivered = deliveredChildResults(receipts, fit.included);
    assert.deepEqual(delivered, []);
    assert.lengthOf(pending([review], markers(delivered, "attempt-2")), 1);
    // Negative control: marking every receipt, as before, loses the result.
    assert.lengthOf(pending([review], markers(receipts, "attempt-2")), 0);
  });

  it("consumes only the children named in full or by pointer, at their exact revision", () => {
    const receipts = pending([review, audit]);
    const children = receipts.map(brief);
    const budget = bytes(children[0]!.pointer) + 400;
    const fit = fitChildContinuations({ children, budget });
    assert.deepEqual(
      fit.included.map((delivery) => [delivery.id, delivery.form]),
      [["review", "pointer"]],
    );
    assert.equal(fit.omitted, 1);
    const delivered = deliveredChildResults(receipts, fit.included);
    assert.deepEqual(
      pending([review, audit], markers(delivered, "attempt-2")).map((child) => child.id),
      ["audit"],
    );
    // A revised result is a new revision: the earlier delivery does not consume it.
    const revised = { ...review, updatedAt: DateTime.makeUnsafe("2026-10-24T05:00:00Z") };
    assert.deepEqual(deliveredChildResults([revised], fit.included), []);
    // A marker for another attempt consumes nothing.
    assert.lengthOf(pending([review, audit], markers(delivered, "attempt-other")), 2);
  });

  it("keeps the whole envelope within the measured bytes, down to zero", () => {
    const children = [child("491", "Clean review"), child("492", null, "interrupted")].map(brief);
    const line = bytes(
      "2 more child continuations did not fit. Read the parent's subagents with studio_thread_read before resuming any of them; never replay a committed operation.",
    );
    for (const budget of [0, 1, 100, line - 1]) {
      const fit = fitChildContinuations({ children, budget });
      assert.equal(fit.text, "", `budget ${budget}`);
      assert.deepEqual(fit.included, []);
      assert.equal(fit.omitted, 2);
    }
    for (const budget of [line, line + 1, 200, 1_400, 3_000]) {
      const fit = fitChildContinuations({ children, budget });
      assert.isAtMost(bytes(fit.text), budget, `budget ${budget}`);
    }
    // Multi-byte text is measured in UTF-8 bytes, not characters.
    const wide = [{ id: "w", revision: "r", full: "é".repeat(60), pointer: "é".repeat(55) }];
    assert.equal(fitChildContinuations({ children: wide, budget: 100 }).text, "");
    assert.isAtMost(bytes(fitChildContinuations({ children: wide, budget: 200 }).text), 200);
    // Negative control: a brief that fits is sent whole.
    const small = fitChildContinuations({ children: [{ ...wide[0]!, full: "x" }], budget: 200 });
    assert.equal(small.text, "x");
  });
});

describe("native child context ownership", () => {
  it.each([
    ["same native conversation", "provider-thread:old-account", true, true, false],
    ["another subscription", "provider-thread:new-account", true, true, true],
    ["fresh replacement conversation", "provider-thread:old-account", false, true, true],
    ["different model on the same conversation", "provider-thread:old-account", true, false, true],
    ["another provider", "provider-thread:other-provider", false, false, true],
  ] as const)(
    "preserves the delivery boundary for %s",
    (_, targetProviderThreadId, sameNativeThread, sameSelection, expected) => {
      for (const status of ["completed", "failed", "interrupted"]) {
        assert.equal(
          needsPortableChildContext({
            child: child("review", "Read-only result", status),
            runs: [],
            targetProviderThreadId,
            sameNativeThread,
            sameSelection,
          }),
          expected,
        );
      }
    },
  );
});

it("keeps Codex child-conversation ids separate from parent-session ownership", () => {
  const receipt = {
    ...child("codex-review", "Done"),
    runId: "run:parent",
    providerThreadId: "provider-thread:child",
  } as unknown as OrchestrationV2Subagent;
  const runs = [
    { id: "run:parent", providerThreadId: "provider-thread:parent" },
  ] as unknown as Parameters<typeof needsPortableChildContext>[0]["runs"];
  assert.isFalse(
    needsPortableChildContext({
      child: receipt,
      runs,
      targetProviderThreadId: "provider-thread:parent",
      sameNativeThread: true,
      sameSelection: true,
    }),
  );
  assert.isTrue(
    needsPortableChildContext({
      child: receipt,
      runs,
      targetProviderThreadId: "provider-thread:replacement",
      sameNativeThread: true,
      sameSelection: true,
    }),
  );
});

it("delivers each revision once per target native conversation across B to C and fresh B", () => {
  const receipt = child("portable-result", "UNIQUE RESULT");
  const input = {
    subagents: [receipt],
    runs: [],
    currentRunId: "run-next",
    target: { providerThreadId: "B", nativeThreadId: "native-B" },
    attempts: [
      { id: "attempt-B", runId: "run-B", providerThreadId: "B", nativeThreadId: "native-B" },
    ],
    providerTurns: [{ status: "completed", runAttemptId: "attempt-B" }],
    transfers: [
      {
        type: "subagent_result",
        sourceThreadId: receipt.childThreadId,
        sourceRevision: childResultRevision(receipt),
        targetRunAttemptId: "attempt-B",
        targetRunId: "run-B",
      },
    ],
  } as unknown as Parameters<typeof pendingChildResults>[0];
  assert.lengthOf(pendingChildResults(input), 0);
  for (const target of [
    { providerThreadId: "C", nativeThreadId: "native-C" },
    { providerThreadId: "B", nativeThreadId: "fresh-B" },
    { providerThreadId: "C", nativeThreadId: "native-B" },
    { providerThreadId: "B" },
  ])
    assert.lengthOf(pendingChildResults({ ...input, target: target as never }), 1);
});

it("keeps an omitted old-native receipt eligible on later turns of a reused logical thread", () => {
  const receipt = {
    ...child("review", "UNIQUE RESULT"),
    runId: "old-run",
    providerThreadId: "logical-A",
  } as unknown as OrchestrationV2Subagent;
  const input = {
    subagents: [receipt],
    currentRunId: "next-run",
    runs: [{ id: "old-run", providerThreadId: "logical-A" }],
    target: { providerThreadId: "logical-A", nativeThreadId: "new-native" },
    attempts: [
      {
        id: "old-attempt",
        runId: "old-run",
        providerThreadId: "logical-A",
        nativeThreadId: "old-native",
      },
    ],
    providerTurns: [],
    transfers: [],
  } as unknown as Parameters<typeof pendingChildResults>[0];
  assert.equal(fitChildContinuations({ children: [brief(receipt)], budget: 0 }).included.length, 0);
  const pending = pendingChildResults(input);
  assert.lengthOf(
    pending.filter((entry) =>
      needsPortableChildContext({
        child: entry,
        runs: input.runs,
        attempts: input.attempts!,
        targetProviderThreadId: "logical-A",
        targetNativeThreadId: "new-native",
        sameNativeThread: true,
        sameSelection: true,
      }),
    ),
    1,
  );
});

it("preserves a child's earlier attempt when steering mutates its source run", () => {
  const receipt = {
    ...child("steered-review", "UNIQUE RESULT"),
    runId: "reused-run",
    providerThreadId: "A",
  } as unknown as OrchestrationV2Subagent;
  const attempts = [
    { id: "launch-A", runId: "reused-run", providerThreadId: "A", nativeThreadId: "native-A" },
    { id: "restart-B", runId: "reused-run", providerThreadId: "B", nativeThreadId: "native-B" },
  ] as unknown as ReadonlyArray<import("@specweave-studio/contracts").OrchestrationV2RunAttempt>;
  assert.isTrue(
    needsPortableChildContext({
      child: receipt,
      runs: [{ id: "reused-run", providerThreadId: "B" }] as never,
      attempts,
      targetProviderThreadId: "B",
      targetNativeThreadId: "native-B",
      sameNativeThread: true,
      sameSelection: true,
    }),
  );
});
