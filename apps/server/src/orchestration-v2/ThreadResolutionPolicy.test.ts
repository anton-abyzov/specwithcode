import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { resolutionMergeAt, type ResolutionPullRequest } from "./ThreadResolutionPolicy.ts";

const now = Date.parse("2026-10-08T12:00:00Z");
const merged = now - 60_000;
const ready: ResolutionPullRequest = {
  state: "merged",
  mergedAt: DateTime.formatIso(DateTime.makeUnsafe(merged)),
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(merged)),
  observedAt: now,
  checksState: "passing",
  reviewDecision: "approved",
};
const resolve = (prs: ReadonlyArray<ResolutionPullRequest | null>, anchor = merged - 1) =>
  resolutionMergeAt(prs, anchor, now);

describe("resolutionMergeAt", () => {
  it("requires all relevant PRs, with no empty or unknown completion", () => {
    expect(resolve([])).toBeNull();
    expect(resolve([null])).toBeNull();
    expect(resolve([ready, null])).toBeNull();
    expect(resolve([ready, { ...ready, state: "open" }])).toBeNull();
    expect(resolve([ready, { ...ready, state: "closed" }])).toBeNull();
    expect(resolve([ready, ready])).toBe(merged);
  });
  it.each([
    { checksState: undefined },
    { checksState: null },
    { checksState: "pending" },
    { checksState: "failing" },
    { reviewDecision: undefined },
    { reviewDecision: null },
    { reviewDecision: "changes-requested" },
    { reviewDecision: "review-required" },
    { isDraft: true },
    { mergedAt: undefined },
    { mergedAt: "bad" },
    { updatedAt: null },
    { updatedAt: "bad" },
    { updatedAt: DateTime.formatIso(DateTime.makeUnsafe(merged - 1)) },
    { observedAt: undefined },
    { observedAt: Number.NaN },
    { observedAt: Number.POSITIVE_INFINITY },
    { observedAt: merged - 1 },
    { observedAt: now + 1 },
  ] satisfies Array<Partial<ResolutionPullRequest>>)(
    "keeps incomplete evidence active: %j",
    (patch) => {
      expect(resolve([ready, { ...ready, ...patch }])).toBeNull();
    },
  );
  it("accepts the merged snapshot observation without inventing head or QA evidence", () => {
    expect(
      resolve([{ ...ready, observedAt: undefined, syncedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) }]),
    ).toBe(merged);
  });
  it("keeps work requested after all merges active", () => {
    expect(resolve([ready], merged + 1)).toBeNull();
    expect(resolve([ready], merged)).toBe(merged);
    expect(resolve([ready], Number.NaN)).toBeNull();
    expect(resolutionMergeAt([ready], merged, Number.NaN)).toBeNull();
  });
  it("uses the last merge across a multi-PR task", () => {
    const earlier = { ...ready, mergedAt: DateTime.formatIso(DateTime.makeUnsafe(merged - 1_000)) };
    expect(resolve([earlier, ready])).toBe(merged);
  });
});
