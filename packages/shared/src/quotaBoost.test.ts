import type { QuotaBoost } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentQuotaBoost,
  liveQuotaBoosts,
  quotaBoostEnd,
  withQuotaBoost,
} from "./quotaBoost.ts";

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
    expect(currentQuotaBoost([boost()], "p1", NOW)).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
    });
  });

  it("covers only the picked projects", () => {
    const boosts = [boost({ projectIds: ["p1"] })];
    expect(currentQuotaBoost(boosts, "p1", NOW)?.model).toBe("gpt-5.5");
    expect(currentQuotaBoost(boosts, "p2", NOW)).toBeNull();
  });

  it("ends by itself at the reset, with no one to end it", () => {
    expect(currentQuotaBoost([boost()], "p1", NOW + 6 * HOUR)).toBeNull();
    expect(currentQuotaBoost(undefined, "p1", NOW)).toBeNull();
  });

  it("prefers the quota that is lost first", () => {
    const later = boost({ accountKey: "muse:b", instanceId: "muse", model: "muse-1" } as never);
    const sooner = boost({ until: NOW + HOUR });
    expect(currentQuotaBoost([later, sooner], "p1", NOW)?.instanceId).toBe("codex");
    expect(liveQuotaBoosts([later, sooner], NOW).map((entry) => entry.until)).toEqual([
      NOW + HOUR,
      NOW + 6 * HOUR,
    ]);
  });
});

describe("withQuotaBoost", () => {
  it("keeps one boost per account and drops the ended ones", () => {
    const ended = boost({ accountKey: "muse:b", until: NOW - 1 });
    const next = boost({ model: "gpt-5.5-mini" });
    expect(withQuotaBoost([ended, boost()], next, NOW)).toEqual([next]);
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

  it("does not end on an account it cannot read", () => {
    expect(quotaBoostEnd(boost(), undefined, NOW)).toBeNull();
    expect(quotaBoostEnd(boost(), [window({ id: "session", leftPercent: 0 })], NOW)).toBeNull();
  });
});
