import { describe, expect, it } from "vite-plus/test";

import data from "./subscriptionWindowRules.json" with { type: "json" };
import { SUBSCRIPTION_WINDOW_RULES, subscriptionWindowNote } from "./subscriptionWindowRules.ts";

const WEEK = 7 * 24 * 60 * 60_000;
const weekly = { kind: "weekly", durationMs: WEEK } as const;
const session = { kind: "session", durationMs: 5 * 60 * 60_000 } as const;
const monthly = { kind: "monthly", durationMs: null } as const;
const note = (input: Partial<Parameters<typeof subscriptionWindowNote>[0]>) =>
  subscriptionWindowNote({ provider: null, plans: [], windows: [], hasReportedRenewal: false, ...input })
    ?.note ?? null;

describe("subscriptionWindowNote", () => {
  it("gives every rule a dated source", () => {
    for (const rule of SUBSCRIPTION_WINDOW_RULES) {
      expect(rule.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rule.source === null || rule.source.startsWith("https://")).toBe(true);
      expect(rule.quote.length).toBeGreaterThan(0);
    }
    expect(data.maxAgeDays).toBe(90);
  });

  it("notes Copilot's monthly allowance on any window, and nothing without one", () => {
    expect(note({ provider: "copilot", windows: [monthly] })).toBe(
      "Monthly allowance. Resets on the first of the month at 00:00 UTC, whatever your billing day.",
    );
    expect(note({ provider: "copilot" })).toBeNull();
  });

  it("notes Cursor's weekly pool, and its billing cycle only with a reported renewal", () => {
    expect(note({ provider: "cursor", windows: [weekly] })).toBe("One weekly pool. No hourly limit.");
    expect(note({ provider: "cursor", windows: [monthly] })).toBeNull();
    expect(note({ provider: "cursor", windows: [monthly], hasReportedRenewal: true })).toBe(
      "Usage resets monthly with your billing cycle.",
    );
  });

  it("notes Grok's shared weekly pool", () => {
    expect(note({ provider: "grok", windows: [weekly] })).toBe("One weekly pool across Grok products.");
  });

  it("notes a Codex Pro plan without a 5-hour window, and only that", () => {
    const pro = { provider: "codex" as const, plans: ["ChatGPT Pro 20x Subscription"] };
    expect(note({ ...pro, windows: [weekly] })).toBe("No 5-hour window reported for this plan.");
    expect(note({ ...pro, windows: [weekly, session] })).toBeNull();
    expect(note({ ...pro, windows: [weekly, { kind: "other", durationMs: 60 * 60_000 }] })).toBeNull();
    expect(note({ ...pro, windows: [monthly] })).toBeNull();
    expect(note({ provider: "codex", plans: ["ChatGPT Plus Subscription"], windows: [weekly] })).toBeNull();
  });

  it("says nothing for Claude, OpenCode Go or an unknown provider", () => {
    expect(note({ windows: [weekly] })).toBeNull();
  });
});
