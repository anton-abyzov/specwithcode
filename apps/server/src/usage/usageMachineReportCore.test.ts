import type { UsageTokenTotals } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ResolvedAccount } from "./usageAccountSpans.ts";
import { MachineReportBuilder, weakerRule } from "./usageMachineReportCore.ts";

const HOUR = 60 * 60_000;
const noon = Date.parse("2026-11-18T12:00:00.000Z");
const A: ResolvedAccount = { accountKey: "claudeAgent:a@example.com", rule: "recorded" };
const B: ResolvedAccount = { accountKey: "claudeAgent:b@example.com", rule: "history" };

function totals(input: number, output: number): UsageTokenTotals {
  return {
    uncachedInputTokens: input,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: output,
    reasoningTokens: 0,
  };
}

function builder(owned: ReadonlyArray<readonly [string, string | null]> = []) {
  return new MachineReportBuilder({
    timeZone: "UTC",
    sinceDay: "2026-11-17",
    untilDay: "2026-11-19",
    hourlySinceMs: noon - 24 * HOUR,
    ownedSessions: new Map(owned),
  });
}

describe("weakerRule", () => {
  it("keeps the weaker of two rules", () => {
    expect(weakerRule("recorded", "history")).toBe("history");
    expect(weakerRule("current", "history")).toBe("current");
    expect(weakerRule("unknown", "recorded")).toBe("unknown");
  });
});

describe("MachineReportBuilder", () => {
  it("splits a folder's records by owning thread and by account", () => {
    const report = builder([
      ["owned", "project-1"],
      ["chat", null],
    ]);
    report.setSource(3, {
      key: "host claude /home 1:2",
      provider: "claude",
      resolve: (at) => (at < noon ? B : A),
    });
    report.addRecord(
      { timestampMs: noon + 1, sessionId: "owned", totals: totals(100, 20) },
      3,
      "m1",
      0.5,
      false,
    );
    report.addRecord(
      { timestampMs: noon + 2, sessionId: "owned", totals: totals(10, 0) },
      3,
      "m1",
      0.25,
      false,
    );
    report.addRecord(
      { timestampMs: noon + 3, sessionId: "chat", totals: totals(1, 1) },
      3,
      "m1",
      0,
      true,
    );
    report.addRecord(
      { timestampMs: noon + 4, sessionId: "terminal", totals: totals(5, 5) },
      3,
      "m1",
      0.1,
      false,
    );
    report.addRecord(
      { timestampMs: noon - 1, sessionId: "terminal", totals: totals(7, 0) },
      3,
      "m1",
      0.2,
      false,
    );

    const built = report.finish();
    expect(built.sources).toEqual([{ key: "host claude /home 1:2", provider: "claude" }]);
    const cell = (accountKey: string, origin: string, projectId?: string) =>
      built.cells.find(
        (entry) =>
          entry.accountKey === accountKey &&
          entry.origin === origin &&
          entry.projectId === projectId,
      );
    expect(cell(A.accountKey, "app", "project-1")).toMatchObject({
      day: "2026-11-18",
      model: "m1",
      source: 0,
      tokens: 130,
      costUsd: 0.75,
      requests: 2,
      unpricedRequests: 0,
      sessions: 1,
    });
    expect(cell(A.accountKey, "app")).toMatchObject({
      tokens: 2,
      requests: 1,
      unpricedRequests: 1,
    });
    expect(cell(A.accountKey, "native")).toMatchObject({ tokens: 10, costUsd: 0.1, sessions: 1 });
    expect(cell(B.accountKey, "native")).toMatchObject({ tokens: 7, costUsd: 0.2 });
    expect(built.identities.get(A.accountKey)).toBe("recorded");
    expect(built.identities.get(B.accountKey)).toBe("history");
  });

  it("skips records of a folder nobody described", () => {
    const report = builder();
    report.addRecord({ timestampMs: noon, sessionId: "s", totals: totals(1, 1) }, 0, "m", 1, false);
    expect(report.finish().cells).toEqual([]);
  });

  it("keeps hours outside the day range and days outside the hourly range apart", () => {
    const report = new MachineReportBuilder({
      timeZone: "UTC",
      sinceDay: "2026-11-01",
      untilDay: "2026-11-02",
      hourlySinceMs: noon - 24 * HOUR,
      ownedSessions: new Map(),
    });
    report.setSource(0, { key: "k", provider: "codex", resolve: () => A });
    const early = Date.parse("2026-11-01T08:10:00.000Z");
    report.addRecord(
      { timestampMs: early, sessionId: "s", totals: totals(4, 0) },
      0,
      "m",
      1,
      false,
    );
    report.addRecord(
      { timestampMs: noon + 10 * 60_000, sessionId: "s", totals: totals(6, 0) },
      0,
      "m",
      2,
      false,
    );
    report.addRecord(
      { timestampMs: noon + 20 * 60_000, sessionId: "s", totals: totals(1, 0) },
      0,
      "m",
      3,
      false,
    );
    report.addRecord(
      { timestampMs: Date.parse("2026-10-01T00:00:00.000Z"), sessionId: "s", totals: totals(9, 0) },
      0,
      "m",
      9,
      false,
    );

    const built = report.finish();
    expect(built.cells).toHaveLength(1);
    expect(built.cells[0]).toMatchObject({ day: "2026-11-01", tokens: 4 });
    expect(built.hourly).toEqual([
      {
        hourStartMs: noon,
        accountKey: A.accountKey,
        origin: "native",
        source: 0,
        tokens: 7,
        costUsd: 5,
        requests: 2,
      },
    ]);
  });

  it("counts recorded turns as in the app, without a folder", () => {
    const report = builder();
    report.addTurn({
      atMs: noon,
      account: A,
      model: "gpt",
      tokens: 50.4,
      costUsd: null,
      projectId: "p",
      sessionKey: "t1",
    });
    report.addTurn({
      atMs: noon + 1,
      account: A,
      model: "gpt",
      tokens: 10,
      costUsd: 0.4,
      projectId: "p",
      sessionKey: "t2",
    });
    const built = report.finish();
    expect(built.sources).toEqual([]);
    expect(built.cells).toHaveLength(1);
    expect(built.cells[0]).toMatchObject({
      origin: "app",
      projectId: "p",
      tokens: 60,
      costUsd: 0.4,
      requests: 2,
      unpricedRequests: 1,
      sessions: 2,
    });
    expect(built.cells[0]).not.toHaveProperty("source");
  });

  it("sends only folders that contributed, re-indexed", () => {
    const report = builder();
    report.setSource(0, { key: "empty", provider: "claude", resolve: () => A });
    report.setSource(4, { key: "used", provider: "codex", resolve: () => A });
    report.addRecord({ timestampMs: noon, sessionId: "s", totals: totals(1, 0) }, 4, "m", 0, false);
    const built = report.finish();
    expect(built.sources).toEqual([{ key: "used", provider: "codex" }]);
    expect(built.cells[0]!.source).toBe(0);
    expect(built.hourly[0]!.source).toBe(0);
  });
});
