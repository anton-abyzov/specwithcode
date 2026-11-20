import type { UsageDay, UsageLimitHistorySeries } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ShareCell, ShareMachineInput, ShareReport } from "./usageMachineShare.ts";
import {
  buildSubscriptionViews,
  dayBefore,
  niceCeiling,
  reportRange,
  zonedDay,
  zonedDayStart,
} from "./usageMachineShareView.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-20T18:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const A = "claudeAgent:alex.rivers@example.com";

describe("days in the viewer's zone", () => {
  it("names the local day and where it starts", () => {
    const late = Date.parse("2026-11-20T03:30:00.000Z");
    expect(zonedDay(late, "UTC")).toBe("2026-11-20");
    expect(zonedDay(late, "America/New_York")).toBe("2026-11-19");
    expect(zonedDay(late, "Asia/Tokyo")).toBe("2026-11-20");
    expect(zonedDayStart("2026-11-20", "UTC")).toBe(Date.parse("2026-11-20T00:00:00.000Z"));
    expect(zonedDayStart("2026-11-20", "America/New_York")).toBe(
      Date.parse("2026-11-20T05:00:00.000Z"),
    );
    // The day the clocks go back starts before the change.
    expect(zonedDayStart("2026-11-01", "America/New_York")).toBe(
      Date.parse("2026-11-01T04:00:00.000Z"),
    );
    expect(zonedDay(0, "Not/AZone")).toBe("1970-01-01");
  });

  it("steps back whole days across a month", () => {
    expect(dayBefore("2026-11-02", 3)).toBe("2026-10-30");
    expect(dayBefore("2026-11-20", 0)).toBe("2026-11-20");
  });

  it("asks machines for thirty days, or further back for a custom range", () => {
    expect(reportRange({ kind: "days", days: 7 }, now, "UTC")).toEqual({
      sinceDay: "2026-10-22",
      untilDay: "2026-11-20",
    });
    expect(
      reportRange({ kind: "custom", sinceDay: "2026-09-01", untilDay: "2026-09-30" }, now, "UTC")
        .sinceDay,
    ).toBe("2026-09-01");
    expect(
      reportRange({ kind: "custom", sinceDay: "2025-01-01", untilDay: "2026-09-30" }, now, "UTC")
        .sinceDay,
    ).toBe("2026-08-21");
  });
});

describe("niceCeiling", () => {
  it("rounds up to a round axis top", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(377)).toBe(500);
    expect(niceCeiling(12)).toBe(20);
    expect(niceCeiling(2.3)).toBe(2.5);
    expect(niceCeiling(100)).toBe(100);
  });
});

describe("buildSubscriptionViews", () => {
  const start = now - 14 * DAY;
  const cells: ShareCell[] = [];
  const hourly: Array<ShareReport["hourly"][number]> = [];
  for (let at = start; at < now; at += HOUR) {
    hourly.push({ hourStartMs: at, accountKey: A, tokens: 1000, costUsd: 5, requests: 1 } as never);
  }
  for (let day = 0; day < 14; day += 1) {
    cells.push({
      day: iso(start + day * DAY + 12 * HOUR).slice(0, 10) as UsageDay,
      accountKey: A,
      model: "model-one",
      origin: "app",
      tokens: 24_000,
      costUsd: 120,
      requests: 24,
      unpricedRequests: 0,
      sessions: 1,
    } as ShareCell);
  }
  const machine: ShareMachineInput = {
    machineId: "desk",
    name: "Desk",
    state: "live",
    heldAccountKeys: [A],
    report: {
      version: 1,
      readAt: iso(now),
      timeZone: "UTC",
      sinceDay: "2026-10-22",
      untilDay: "2026-11-20",
      accounts: [{ accountKey: A, driver: "claudeAgent", identity: "recorded", signedIn: true }],
      sources: [],
      projects: [],
      cells,
      hourly,
      hourlySinceMs: start,
    } as unknown as ShareReport,
  };
  // Half a point an hour, reset four days ago.
  const resetAt = now - 4 * DAY;
  const history = {
    accountKey: A,
    driver: "claudeAgent",
    windowId: "seven_day",
    windowKind: "weekly",
    windowDurationMins: 7 * 24 * 60,
    samples: Array.from({ length: 14 * 24 + 1 }, (_, hour) => {
      const at = start + hour * HOUR;
      return {
        at: iso(at),
        usedPercent: Math.min(
          100,
          ((at >= resetAt ? at - resetAt : at - start) / HOUR) * 0.5 * (at >= resetAt ? 1 : 0.4),
        ),
        resetsAt: iso(at >= resetAt ? resetAt + 7 * DAY : resetAt),
      };
    }),
  } as unknown as UsageLimitHistorySeries;
  const base = {
    inputs: [machine],
    histories: [[history]],
    scopedWindowIds: new Set<string>(),
    measure: "cost" as const,
    now,
    timeZone: "UTC",
  };

  it("draws the last seven days with the reset marked", () => {
    const [view] = buildSubscriptionViews({ ...base, period: { kind: "days", days: 7 } });
    expect(view).toMatchObject({
      provider: "Claude",
      account: "al••••rs@example.com",
      sinceReset: false,
      period: { sinceDay: "2026-11-14", untilDay: "2026-11-20" },
    });
    expect(view!.trend).toHaveLength(7);
    expect(view!.resets).toEqual([resetAt]);
    expect(view!.segments[0]).toMatchObject({ key: "desk:app", machineId: "desk" });
    expect(view!.reading?.usedPercent).toBeCloseTo(48, 0);
  });

  it("starts the reset window at the account's own reset", () => {
    const [view] = buildSubscriptionViews({ ...base, period: { kind: "reset" } });
    expect(view!.sinceReset).toBe(true);
    expect(view!.period.startMs).toBe(resetAt);
    expect(view!.period.sinceDay).toBe("2026-11-16");
    expect(view!.resets).toEqual([]);
  });

  it("clamps a custom range to today", () => {
    const [view] = buildSubscriptionViews({
      ...base,
      period: { kind: "custom", sinceDay: "2026-11-18", untilDay: "2027-01-01" },
    });
    expect(view!.period).toMatchObject({
      sinceDay: "2026-11-18",
      untilDay: "2026-11-20",
      endMs: now,
    });
    expect(view!.trend).toHaveLength(3);
  });

  it("names a hosted agent by its instance", () => {
    const copilot = "acpRegistry:login:alexrivers";
    const [view] = buildSubscriptionViews({
      ...base,
      inputs: [
        {
          ...machine,
          heldAccountKeys: [copilot],
          report: {
            ...machine.report!,
            accounts: [
              {
                accountKey: copilot,
                driver: "acpRegistry",
                identity: "recorded",
                signedIn: true,
                label: "GitHub Copilot",
              },
            ],
            cells: cells.map((cell) => ({ ...cell, accountKey: copilot })),
            hourly: [],
          } as unknown as ShareReport,
        },
      ],
      period: { kind: "days", days: 7 },
    });
    expect(view).toMatchObject({ provider: "GitHub Copilot", account: "alexrivers" });
    expect(view!.estimate).toMatchObject({ kind: "unavailable", reason: "noReading" });
  });
});
