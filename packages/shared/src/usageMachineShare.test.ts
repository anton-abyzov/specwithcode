import type { UsageDay, UsageSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ShareCell,
  type ShareMachineInput,
  type ShareReport,
  mergeMachineShare,
  recordedHours,
  reportFromSummary,
  shareBreakdown,
  shareMachineInput,
  shareSegments,
  shareTrend,
} from "./usageMachineShare.ts";
import type { OutsideEstimate } from "./usageOutsideEstimate.ts";

const A = "claudeAgent:a@example.com";
const B = "codex:b@example.com";
const HOUR = 60 * 60 * 1000;
const end = Date.parse("2026-11-19T23:00:00.000Z");
const options = { sinceDay: "2026-11-17", untilDay: "2026-11-19", periodEndMs: end };

function cell(overrides: Partial<ShareCell>): ShareCell {
  return {
    day: "2026-11-18" as UsageDay,
    accountKey: A,
    model: "model-one",
    origin: "app",
    tokens: 100,
    costUsd: 1,
    requests: 1,
    unpricedRequests: 0,
    sessions: 1,
    ...overrides,
  } as ShareCell;
}

function report(overrides: Partial<ShareReport>): ShareReport {
  return {
    version: 1,
    readAt: "2026-11-19T22:30:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-11-01" as UsageDay,
    untilDay: "2026-11-19" as UsageDay,
    accounts: [],
    sources: [],
    projects: [],
    cells: [],
    hourly: [],
    hourlySinceMs: end - 14 * 24 * HOUR,
    ...overrides,
  } as ShareReport;
}

function machine(machineId: string, overrides: Partial<ShareMachineInput>): ShareMachineInput {
  return {
    machineId,
    name: machineId,
    state: "live",
    report: null,
    heldAccountKeys: [],
    ...overrides,
  };
}

const account = (accountKey: string, signedIn = true) =>
  ({
    accountKey,
    driver: accountKey.split(":")[0],
    identity: "recorded",
    signedIn,
  }) as ShareReport["accounts"][number];

describe("mergeMachineShare", () => {
  it("groups by subscription, then machine, then origin", () => {
    const share = mergeMachineShare(
      [
        machine("desk", {
          heldAccountKeys: [A],
          report: report({
            accounts: [account(A), account(B)],
            projects: [{ projectId: "p1", title: "Site" }] as ShareReport["projects"],
            cells: [
              cell({ costUsd: 6, projectId: "p1" as ShareCell["projectId"] }),
              cell({ origin: "native", costUsd: 2 }),
              cell({ accountKey: B, costUsd: 1, model: "model-two" }),
              cell({ day: "2026-11-01" as UsageDay, costUsd: 99 }),
            ],
          }),
        }),
        machine("laptop", {
          report: report({
            accounts: [account(A)],
            cells: [cell({ costUsd: 12, day: "2026-11-19" as UsageDay })],
          }),
        }),
      ],
      options,
    );
    expect(share.days).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(share.subscriptions.map((entry) => entry.accountKey)).toEqual([A, B]);
    const first = share.subscriptions[0]!;
    expect(first).toMatchObject({ driver: "claudeAgent", name: "a@example.com", unknown: false });
    expect(first.total.costUsd).toBe(20);
    expect(first.machines.map((entry) => [entry.machineId, entry.total.costUsd])).toEqual([
      ["laptop", 12],
      ["desk", 8],
    ]);
    expect(first.machines[1]).toMatchObject({
      app: { costUsd: 6 },
      native: { costUsd: 2 },
      holds: true,
    });
    expect(first.silentHolders).toEqual([]);

    const segments = shareSegments(first, "cost", null);
    expect(segments.map((segment) => [segment.key, segment.share])).toEqual([
      ["laptop:app", 0.6],
      ["desk:app", 0.3],
      ["desk:native", 0.1],
    ]);

    const drill = shareBreakdown(share, A, "desk", "cost");
    expect(drill.total.costUsd).toBe(8);
    expect(drill.projects.map((entry) => entry.label)).toEqual([
      "Site",
      "Outside the app on this machine",
    ]);
    expect(shareBreakdown(share, A, null, "cost").days.map((entry) => entry.key)).toEqual([
      "2026-11-18",
      "2026-11-19",
    ]);
  });

  it("counts a folder two environments read once, for the live one", () => {
    const sources = [
      { key: "host claude /home 1:2", provider: "claude" },
    ] as ShareReport["sources"];
    const share = mergeMachineShare(
      [
        machine("stale", {
          state: "cached",
          report: report({ sources, cells: [cell({ source: 0, costUsd: 5 })] }),
        }),
        machine("fresh", {
          report: report({
            sources,
            cells: [cell({ source: 0, costUsd: 5 }), cell({ costUsd: 1, model: "turns" })],
            hourly: [
              {
                hourStartMs: end - HOUR,
                accountKey: A,
                source: 0,
                tokens: 10,
                costUsd: 5,
                requests: 1,
              },
            ],
          } as Partial<ShareReport>),
        }),
      ],
      options,
    );
    const first = share.subscriptions[0]!;
    expect(first.total.costUsd).toBe(6);
    expect(first.machines.map((entry) => entry.machineId)).toEqual(["fresh"]);
    expect(recordedHours(first)).toEqual([{ hourStartMs: end - HOUR, weight: 5 }]);
  });

  it("names machines that hold the account and did not report the whole period", () => {
    const share = mergeMachineShare(
      [
        machine("desk", { report: report({ accounts: [account(A)], cells: [cell({})] }) }),
        machine("away", { state: "missing", heldAccountKeys: [A], note: "Offline" }),
        machine("old", {
          state: "cached",
          heldAccountKeys: [A],
          report: report({ readAt: "2026-11-18T08:00:00.000Z", accounts: [account(A)] }),
        }),
        machine("recent", {
          state: "cached",
          heldAccountKeys: [A],
          report: report({ readAt: "2026-11-19T21:30:00.000Z", accounts: [account(A)] }),
        }),
      ],
      options,
    );
    expect(share.subscriptions[0]!.silentHolders).toEqual(["away", "old"]);
    expect(share.machines.find((entry) => entry.machineId === "away")).toMatchObject({
      state: "missing",
      readAt: null,
      note: "Offline",
    });
  });

  it("lists a signed-in account with no use, and hides one nobody holds or used", () => {
    const share = mergeMachineShare(
      [machine("desk", { report: report({ accounts: [account(A), account(B, false)] }) })],
      options,
    );
    expect(share.subscriptions.map((entry) => entry.accountKey)).toEqual([A]);
    expect(share.subscriptions[0]!.total.requests).toBe(0);
  });
});

describe("a period that starts inside its first day", () => {
  const dayStart = Date.parse("2026-11-17T00:00:00.000Z");
  const reset = dayStart + 18 * HOUR;
  const hour = (at: number, costUsd: number) =>
    ({ hourStartMs: at, accountKey: A, tokens: costUsd * 100, costUsd, requests: 1 }) as never;
  const desk = (overrides: Partial<ShareReport> = {}) =>
    machine("desk", {
      heldAccountKeys: [A],
      report: report({
        accounts: [account(A)],
        cells: [
          cell({ day: "2026-11-17" as UsageDay, costUsd: 110, tokens: 11_000, requests: 11 }),
          cell({ day: "2026-11-18" as UsageDay, costUsd: 7 }),
        ],
        // $100 before the reset at 6 PM, $10 after it.
        hourly: [hour(dayStart + 9 * HOUR, 100), hour(dayStart + 20 * HOUR, 10)],
        ...overrides,
      }),
    });
  const firstDay = { startMs: dayStart, endMs: dayStart + 24 * HOUR, fromMs: reset };

  it("counts that day from the instant the period starts", () => {
    const share = mergeMachineShare([desk()], { ...options, firstDay });
    const total = share.subscriptions[0]!.total;
    expect(total.costUsd).toBeCloseTo(17, 6);
    expect(total.tokens).toBeCloseTo(1100, 6);
    expect(share.rows.find((row) => row.day === "2026-11-17")!.costUsd).toBeCloseTo(10, 6);
    // Without the cut the whole day counts.
    expect(mergeMachineShare([desk()], options).subscriptions[0]!.total.costUsd).toBe(117);
  });

  it("counts the hour the period cuts in proportion", () => {
    const share = mergeMachineShare([desk({ hourly: [hour(dayStart + 18 * HOUR, 110)] })], {
      ...options,
      firstDay: { ...firstDay, fromMs: reset + HOUR / 2 },
    });
    expect(share.subscriptions[0]!.total.costUsd).toBeCloseTo(62, 6);
  });

  it("keeps the whole day when the hours do not reach back to it", () => {
    const share = mergeMachineShare([desk({ hourlySinceMs: reset })], { ...options, firstDay });
    expect(share.subscriptions[0]!.total.costUsd).toBe(117);
  });
});

describe("reportFromSummary", () => {
  const summary = {
    contractVersion: 3,
    readAt: "2026-11-19T22:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-11-17",
    untilDay: "2026-11-19",
    buckets: [
      {
        day: "2026-11-18",
        provider: "claude",
        model: "m",
        sourcePath: "/home/.claude",
        totals: {
          uncachedInputTokens: 1,
          cachedInputTokens: 2,
          cacheCreationTokens: 3,
          outputTokens: 4,
          reasoningTokens: 5,
        },
        costUsd: 3,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 2,
        unpricedRecords: 0,
        sessions: 1,
      },
      {
        day: "2026-11-18",
        provider: "codex",
        model: "g",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 1,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
      {
        day: "2026-11-18",
        provider: "cursor",
        model: "c",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 9,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "h",
          provider: "claude",
          resolvedHomePath: "/home/.claude",
          volumeId: "1:2",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "x", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  } as unknown as UsageSummary;

  it("charges a provider to its one signed-in account, without an origin", () => {
    const stand = reportFromSummary(summary, [A]);
    expect(stand.cells).toHaveLength(2);
    expect(stand.cells[0]).toMatchObject({
      accountKey: A,
      origin: "unsplit",
      tokens: 15,
      costUsd: 3,
      requests: 2,
      source: 0,
    });
    expect(stand.cells[1]).toMatchObject({ accountKey: "codex:unknown", origin: "unsplit" });
    expect(stand.sources).toEqual([{ key: "h claude /home/.claude 1:2", provider: "claude" }]);

    const share = mergeMachineShare(
      [machine("old", { state: "summary", heldAccountKeys: [A], report: stand })],
      options,
    );
    const first = share.subscriptions.find((entry) => entry.accountKey === A)!;
    expect(first.machines[0]!.unsplit.costUsd).toBe(3);
    expect(first.silentHolders).toEqual(["old"]);
    expect(share.subscriptions.find((entry) => entry.unknown)?.driver).toBe("codex");
  });

  it("does not guess between two accounts of one provider", () => {
    const stand = reportFromSummary(summary, [A, "claudeAgent:c@example.com"]);
    expect(stand.cells[0]!.accountKey).toBe("claudeAgent:unknown");
  });
});

describe("outside estimate in the bar and the trend", () => {
  const share = mergeMachineShare(
    [
      machine("desk", {
        report: report({
          accounts: [account(A)],
          cells: [
            cell({ costUsd: 30, tokens: 3000 }),
            cell({ costUsd: 30, tokens: 3000, day: "2026-11-19" as UsageDay }),
          ],
        }),
      }),
    ],
    options,
  );
  const subscription = share.subscriptions[0]!;
  const estimate = {
    kind: "estimate",
    detected: true,
    consumedPoints: 40,
    explainedPoints: 30,
    outsidePoints: 10,
    outsideWeight: 20,
    weightPerPoint: 2,
    days: [
      { day: "2026-11-18", points: 10, weight: 20 },
      { day: "2026-11-19", points: 0, weight: 0 },
    ],
  } as unknown as OutsideEstimate;

  it("adds the estimate as its own part, in the measure shown", () => {
    const cost = shareSegments(subscription, "cost", estimate);
    expect(cost.map((segment) => [segment.kind, segment.value, segment.share])).toEqual([
      ["app", 60, 0.75],
      ["outside", 20, 0.25],
    ]);
    const tokens = shareSegments(subscription, "tokens", estimate);
    expect(tokens[1]).toMatchObject({ kind: "outside", value: 2000, share: 0.25 });
    expect(shareSegments(subscription, "cost", { ...estimate, detected: false })).toHaveLength(1);
  });

  it("fills the bar with the estimate when nothing was recorded", () => {
    const empty = mergeMachineShare(
      [machine("desk", { report: report({ accounts: [account(A)] }) })],
      options,
    ).subscriptions[0]!;
    const all = { ...estimate, explainedPoints: 0, outsideWeight: null, weightPerPoint: null };
    expect(shareSegments(empty, "cost", all)).toEqual([
      { key: "outside", kind: "outside", machineId: null, value: null, share: 1 },
    ]);
  });

  it("stacks each day by machine with the estimate on top", () => {
    const trend = shareTrend(share, subscription, "cost", estimate);
    expect(trend.map((day) => [day.day, day.parts.length, day.outside, day.total])).toEqual([
      ["2026-11-17", 0, null, 0],
      ["2026-11-18", 1, 20, 50],
      ["2026-11-19", 1, null, 30],
    ]);
  });
});

describe("shareMachineInput", () => {
  const source = {
    machineId: "desk",
    name: "Desk",
    connected: true,
    canReport: true,
    permitted: true,
    heldAccountKeys: [A],
    answer: null,
    kept: null,
    summary: null,
  };
  const live = report({});
  const kept = report({ readAt: "2026-11-18T08:00:00.000Z" });

  it("shows the machine's answer when it has one", () => {
    expect(shareMachineInput({ ...source, answer: live })).toMatchObject({
      state: "live",
      report: live,
    });
  });

  it("keeps the last report for a machine out of reach or failing", () => {
    expect(shareMachineInput({ ...source, connected: false, kept })).toMatchObject({
      state: "cached",
      report: kept,
    });
    expect(shareMachineInput({ ...source, answer: "failed", kept })).toMatchObject({
      state: "cached",
    });
    expect(shareMachineInput({ ...source, connected: false })).toMatchObject({
      state: "missing",
      note: "out of reach",
    });
  });

  it("says why a reachable machine has no report", () => {
    expect(shareMachineInput(source).note).toBe("reading");
    expect(shareMachineInput({ ...source, answer: "failed" }).note).toBe("could not report");
    expect(shareMachineInput({ ...source, permitted: false }).note).toBe(
      "this device may not read its usage",
    );
    expect(shareMachineInput({ ...source, canReport: false }).note).toBe(
      "needs an update to report",
    );
  });

  it("lets an older machine's summary stand in", () => {
    const summary = {
      readAt: "2026-11-19T22:00:00.000Z",
      timeZone: "UTC",
      sinceDay: "2026-11-17",
      untilDay: "2026-11-19",
      buckets: [],
      sources: [],
    } as never;
    expect(shareMachineInput({ ...source, canReport: false, summary, kept })).toMatchObject({
      state: "summary",
    });
  });
});
