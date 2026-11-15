import type { QuotaBoost } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { currentQuotaBoost, liveQuotaBoosts, quotaBoostEnd } from "./quotaBoost.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 14, 12);

const boost = (patch: Partial<QuotaBoost> = {}): QuotaBoost =>
  ({
    accountKey: "codex:a@example.com",
    instanceId: "codex",
    model: "gpt-5.5",
    projectIds: [],
    label: "Codex Pro",
    windowId: "weekly",
    until: NOW + 6 * HOUR,
    startedAt: NOW - HOUR,
    ...patch,
  }) as QuotaBoost;

describe("currentQuotaBoost", () => {
  it("names the boosted model for every project when none is picked", () => {
    expect(currentQuotaBoost({ a: boost() }, "p1", NOW)).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
    });
  });

  it("covers only the picked projects", () => {
    const boosts = { a: boost({ projectIds: ["p1"] }) };
    expect(currentQuotaBoost(boosts, "p1", NOW)?.model).toBe("gpt-5.5");
    expect(currentQuotaBoost(boosts, "p2", NOW)).toBeNull();
  });

  it("ends by itself at the reset, with no one to end it", () => {
    expect(currentQuotaBoost({ a: boost() }, "p1", NOW + 6 * HOUR)).toBeNull();
    expect(currentQuotaBoost(undefined, "p1", NOW)).toBeNull();
  });

  it("prefers the quota that is lost first", () => {
    const later = boost({ accountKey: "muse:b", instanceId: "muse", model: "muse-1" } as never);
    const sooner = boost({ until: NOW + HOUR });
    expect(currentQuotaBoost({ b: later, a: sooner }, "p1", NOW)?.instanceId).toBe("codex");
    expect(liveQuotaBoosts({ b: later, a: sooner }, NOW).map((entry) => entry.until)).toEqual([
      NOW + HOUR,
      NOW + 6 * HOUR,
    ]);
  });
});

describe("ended boosts", () => {
  it("reads an ended account as no boost", () => {
    expect(currentQuotaBoost({ a: null }, "p1", NOW)).toBeNull();
    expect(liveQuotaBoosts({ a: null, b: boost() }, NOW)).toHaveLength(1);
  });
});

describe("quotaBoostEnd", () => {
  const window = (patch: object = {}) => ({
    id: "weekly",
    leftPercent: 60,
    resetsAt: NOW + 6 * HOUR,
    ...patch,
  });

  it("runs while the window holds quota and resets when expected", () => {
    expect(quotaBoostEnd(boost(), [window()], NOW)).toBeNull();
    // A re-read that moves the reset a few minutes is the same period.
    expect(quotaBoostEnd(boost(), [window({ resetsAt: NOW + 6 * HOUR + 60_000 })], NOW)).toBeNull();
  });

  it("ends at the reset, at an early reset and when the quota is spent", () => {
    expect(quotaBoostEnd(boost(), [window()], NOW + 6 * HOUR)).toBe("reset");
    expect(quotaBoostEnd(boost(), [window({ resetsAt: NOW + 7 * 24 * HOUR })], NOW)).toBe(
      "earlyReset",
    );
    expect(quotaBoostEnd(boost(), [window({ leftPercent: 4 })], NOW)).toBe("spent");
  });

  it("runs a boost started from a renewal until its window resets", () => {
    // The renewal is at midnight; the weekly window it ends resets at 6:40 AM.
    const renewal = boost({ until: NOW + 6 * HOUR + 40 * 60_000 });
    const weekly = [window({ resetsAt: NOW + 6 * HOUR + 40 * 60_000 })];
    expect(quotaBoostEnd(renewal, weekly, NOW)).toBeNull();
    expect(quotaBoostEnd(renewal, weekly, NOW + 7 * HOUR)).toBe("reset");
  });

  it("runs a boost started from an expected reset until that reset arrives, or a day passes", () => {
    // Promised today; the weekly window was heading for a reset in four days.
    const promised = boost({ until: NOW + 20 * HOUR, resetsAtStart: NOW + 4 * 24 * HOUR });
    expect(quotaBoostEnd(promised, [window({ resetsAt: NOW + 4 * 24 * HOUR })], NOW)).toBeNull();
    // The reset arrives: a fresh week begins.
    expect(quotaBoostEnd(promised, [window({ resetsAt: NOW + 7 * 24 * HOUR + HOUR })], NOW + HOUR)).toBe(
      "earlyReset",
    );
    expect(quotaBoostEnd(promised, [window({ resetsAt: NOW + 4 * 24 * HOUR })], NOW + 21 * HOUR)).toBe(
      "reset",
    );
  });

  it("does not end on an account it cannot read", () => {
    expect(quotaBoostEnd(boost(), undefined, NOW)).toBeNull();
    expect(quotaBoostEnd(boost(), [window({ id: "session", leftPercent: 0 })], NOW)).toBeNull();
  });
});
