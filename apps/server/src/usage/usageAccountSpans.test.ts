import { describe, expect, it } from "vite-plus/test";

import {
  type AccountSpanState,
  MAX_SPANS_PER_INSTANCE,
  SPAN_RETENTION_MS,
  decodeSpansFile,
  encodeSpansFile,
  makeAccountResolver,
  nearestReading,
  pruneSpans,
  recordSighting,
  spanAt,
} from "./usageAccountSpans.ts";

const HOUR = 60 * 60_000;
const t0 = Date.parse("2026-11-10T10:00:00.000Z");
const A = "claudeAgent:a@example.com";
const B = "claudeAgent:b@example.com";

describe("recordSighting", () => {
  it("extends the span of the same account and opens one for another", () => {
    const state: AccountSpanState = new Map();
    expect(recordSighting(state, "one", A, t0)).toBe(true);
    expect(recordSighting(state, "one", A, t0 + HOUR)).toBe(true);
    expect(recordSighting(state, "one", B, t0 + 2 * HOUR)).toBe(true);
    expect(state.get("one")).toEqual([
      { accountKey: A, from: t0, to: t0 + HOUR },
      { accountKey: B, from: t0 + 2 * HOUR, to: t0 + 2 * HOUR },
    ]);
  });

  it("ignores a sighting that is not newer than the last", () => {
    const state: AccountSpanState = new Map();
    recordSighting(state, "one", A, t0 + HOUR);
    expect(recordSighting(state, "one", B, t0)).toBe(false);
    expect(recordSighting(state, "one", A, t0 + HOUR)).toBe(false);
    expect(state.get("one")).toHaveLength(1);
  });

  it("keeps the newest spans when an instance switches too often", () => {
    const state: AccountSpanState = new Map();
    for (let index = 0; index < MAX_SPANS_PER_INSTANCE + 5; index += 1) {
      recordSighting(state, "one", index % 2 === 0 ? A : B, t0 + index * HOUR);
    }
    const spans = state.get("one")!;
    expect(spans).toHaveLength(MAX_SPANS_PER_INSTANCE);
    expect(spans.at(-1)!.from).toBe(t0 + (MAX_SPANS_PER_INSTANCE + 4) * HOUR);
  });
});

describe("pruneSpans", () => {
  it("drops spans that ended before the retention window", () => {
    const state: AccountSpanState = new Map();
    recordSighting(state, "old", A, t0);
    recordSighting(state, "mixed", A, t0);
    recordSighting(state, "mixed", B, t0 + SPAN_RETENTION_MS);
    expect(pruneSpans(state, t0 + SPAN_RETENTION_MS + HOUR)).toBe(true);
    expect(state.has("old")).toBe(false);
    expect(state.get("mixed")).toEqual([
      { accountKey: B, from: t0 + SPAN_RETENTION_MS, to: t0 + SPAN_RETENTION_MS },
    ]);
    expect(pruneSpans(state, t0 + SPAN_RETENTION_MS + HOUR)).toBe(false);
  });
});

describe("spanAt", () => {
  const spans = [
    { accountKey: A, from: t0, to: t0 + 2 * HOUR },
    { accountKey: B, from: t0 + 6 * HOUR, to: t0 + 8 * HOUR },
  ];

  it("names nothing before the first sighting", () => {
    expect(spanAt(spans, t0 - 1)).toBeNull();
    expect(spanAt([], t0)).toBeNull();
  });

  it("takes the nearer side of a gap between two accounts", () => {
    expect(spanAt(spans, t0 + 3 * HOUR)?.accountKey).toBe(A);
    expect(spanAt(spans, t0 + 5 * HOUR)?.accountKey).toBe(B);
  });

  it("keeps the last account after the last sighting", () => {
    expect(spanAt(spans, t0 + 30 * HOUR)?.accountKey).toBe(B);
  });
});

describe("nearestReading", () => {
  it("finds the reading closest in time", () => {
    const readings = [
      { at: t0, accountKey: A },
      { at: t0 + 10 * HOUR, accountKey: B },
    ];
    expect(nearestReading(readings, t0 - HOUR)?.accountKey).toBe(A);
    expect(nearestReading(readings, t0 + 4 * HOUR)?.accountKey).toBe(A);
    expect(nearestReading(readings, t0 + 6 * HOUR)?.accountKey).toBe(B);
    expect(nearestReading(readings, t0 + 99 * HOUR)?.accountKey).toBe(B);
    expect(nearestReading([], t0)).toBeNull();
  });
});

describe("makeAccountResolver", () => {
  const unknown = "claudeAgent:unknown";

  it("charges a record to the account signed in when it was written", () => {
    const resolve = makeAccountResolver({
      spans: [
        [
          { accountKey: A, from: t0, to: t0 + 2 * HOUR },
          { accountKey: B, from: t0 + 3 * HOUR, to: t0 + 9 * HOUR },
        ],
      ],
      readings: [],
      currentAccountKey: B,
      unknownAccountKey: unknown,
    });
    expect(resolve(t0 + HOUR)).toEqual({ accountKey: A, rule: "recorded" });
    // Asked twice, so the remembered answer is exercised too.
    expect(resolve(t0 + HOUR + 1)).toEqual({ accountKey: A, rule: "recorded" });
    expect(resolve(t0 + 4 * HOUR)).toEqual({ accountKey: B, rule: "recorded" });
    expect(resolve(t0 + HOUR)).toEqual({ accountKey: A, rule: "recorded" });
  });

  it("falls back to the limit history before spans were kept", () => {
    const resolve = makeAccountResolver({
      spans: [[{ accountKey: B, from: t0, to: t0 + HOUR }]],
      readings: [{ at: t0 - 20 * HOUR, accountKey: A }],
      currentAccountKey: B,
      unknownAccountKey: unknown,
    });
    expect(resolve(t0 - 19 * HOUR)).toEqual({ accountKey: A, rule: "history" });
  });

  it("does not trust the history when the driver has several instances", () => {
    const resolve = makeAccountResolver({
      spans: [[]],
      readings: null,
      currentAccountKey: B,
      unknownAccountKey: unknown,
    });
    expect(resolve(t0)).toEqual({ accountKey: B, rule: "current" });
  });

  it("says unknown when nothing names an account", () => {
    const resolve = makeAccountResolver({
      spans: [],
      readings: [],
      currentAccountKey: null,
      unknownAccountKey: unknown,
    });
    expect(resolve(t0)).toEqual({ accountKey: unknown, rule: "unknown" });
  });

  it("takes the newest sign-in when instances share a folder, and marks it weaker", () => {
    const resolve = makeAccountResolver({
      spans: [
        [{ accountKey: A, from: t0, to: t0 + 9 * HOUR }],
        [{ accountKey: B, from: t0 + 2 * HOUR, to: t0 + 9 * HOUR }],
      ],
      readings: null,
      currentAccountKey: null,
      unknownAccountKey: unknown,
    });
    expect(resolve(t0 + 4 * HOUR)).toEqual({ accountKey: B, rule: "current" });
    expect(resolve(t0 + HOUR)).toEqual({ accountKey: A, rule: "recorded" });
  });
});

describe("spans file", () => {
  it("round-trips", () => {
    const state: AccountSpanState = new Map();
    recordSighting(state, "one", A, t0);
    recordSighting(state, "one", B, t0 + HOUR);
    recordSighting(state, "two", A, t0);
    expect(decodeSpansFile(encodeSpansFile(state))).toEqual(state);
  });

  it("reads a missing, damaged or newer file as empty", () => {
    expect(decodeSpansFile("").size).toBe(0);
    expect(decodeSpansFile("{nope").size).toBe(0);
    expect(
      decodeSpansFile(JSON.stringify({ version: 2, instances: { one: [[A, 1, 2]] } })).size,
    ).toBe(0);
  });

  it("skips entries that are not spans", () => {
    const state = decodeSpansFile(
      JSON.stringify({
        version: 1,
        instances: { one: [[A, 5, 9], ["", 1, 2], [B, 9, 3], "x", [B, 1, 2]], two: "x" },
      }),
    );
    expect(state.get("one")).toEqual([
      { accountKey: B, from: 1, to: 2 },
      { accountKey: A, from: 5, to: 9 },
    ]);
    expect(state.has("two")).toBe(false);
  });
});
