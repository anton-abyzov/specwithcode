// The r5 review's reproductions for F1 and F2, run against the fixed behavior.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  childContinuationContext,
  childContinuationPointer,
  childResultRevision,
  deliveredChildResults,
  fitChildContinuations,
  pendingChildResults,
} from "./ChildContinuationContext.ts";

const now = DateTime.makeUnsafe("2026-10-24T12:00:00Z");
const child = {
  id: "receipt-1",
  threadId: "parent",
  childThreadId: "child",
  origin: "provider_native",
  status: "completed",
  prompt: "Read only review",
  result: "SHIP revision 2",
  updatedAt: now,
  startedAt: now,
  completedAt: now,
  providerThreadId: "old-account",
} as never;

type Pending = ReturnType<typeof pendingChildResults>;
const fit = (pending: Pending, budget: number) =>
  fitChildContinuations({
    children: pending.map((entry) => ({
      id: entry.id,
      revision: childResultRevision(entry),
      full: childContinuationContext({ child: entry, parentInstructions: "Continue" }),
      pointer: childContinuationPointer({ child: entry }),
    })),
    budget,
  });
const markers = (pending: Pending, included: ReturnType<typeof fit>["included"], attempt: string) =>
  deliveredChildResults(pending, included).map((entry) => ({
    type: "subagent_result",
    sourceThreadId: entry.childThreadId,
    sourceRevision: childResultRevision(entry),
    targetRunAttemptId: attempt,
    targetRunId: "replacement",
  }));

describe("r5 review reproductions", () => {
  it("F1: an omitted result stays pending, and a later inclusion delivers it once", () => {
    const input = {
      subagents: [child],
      runs: [{ id: "replacement", providerThreadId: "B", nativeThreadId: "native-B" }],
      providerTurns: [],
      currentRunId: "replacement",
      target: { providerThreadId: "B", nativeThreadId: "native-B" },
      attempts: [
        {
          id: "attempt-2",
          runId: "replacement",
          providerThreadId: "B",
          nativeThreadId: "native-B",
        },
        {
          id: "attempt-3",
          runId: "replacement",
          providerThreadId: "B",
          nativeThreadId: "native-B",
        },
      ],
      transfers: [],
    } as never as Parameters<typeof pendingChildResults>[0];
    const pending = pendingChildResults(input);
    const first = fit(pending, 200);
    expect(first.omitted).toBe(1);
    expect(first.text).not.toContain("receipt-1");
    expect(first.text).not.toContain("SHIP revision 2");
    const next = pendingChildResults({
      ...input,
      transfers: markers(pending, first.included, "attempt-2"),
      providerTurns: [{ status: "completed", runAttemptId: "attempt-2" }],
    } as never);
    expect(next).toHaveLength(1);
    const later = fit(next, 64_000);
    expect(later.included).toHaveLength(1);
    const transfers = markers(next, later.included, "attempt-3");
    const after = (status: string, subagents = [child]) =>
      pendingChildResults({
        ...input,
        subagents,
        transfers,
        providerTurns: [{ status, runAttemptId: "attempt-3" }],
      } as never);
    expect(after("failed")).toHaveLength(1);
    expect(after("completed")).toHaveLength(0);
    const revised = {
      ...(child as object),
      updatedAt: DateTime.makeUnsafe("2026-10-24T13:00:00Z"),
    } as never;
    expect(after("completed", [revised])).toHaveLength(1);
  });

  it("F2: no envelope exceeds the budget it was given", () => {
    for (const budget of [0, 1, 100]) {
      const fitted = fitChildContinuations({
        children: [{ full: "x".repeat(1000), pointer: "y".repeat(500) }] as never,
        budget,
      });
      expect(Buffer.byteLength(fitted.text)).toBeLessThanOrEqual(budget);
    }
    const small = fitChildContinuations({
      children: [{ full: "x", pointer: "y" }] as never,
      budget: 200,
    });
    expect(Buffer.byteLength(small.text)).toBeLessThanOrEqual(200);
  });
});
