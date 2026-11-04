import { describe, expect, it } from "vite-plus/test";

import type { ModelAvailability } from "./modelAvailability";
import {
  chipNeedsUsageRecheck,
  needsUsageRecheck,
  planUsageRecheck,
  USAGE_RECHECK_THROTTLE_MS,
} from "./usageRecheck";

const now = Date.parse("2026-11-04T16:00:00Z");
const binding = {
  label: "Weekly",
  name: "weekly",
  scope: "account",
  family: null,
  resetsAt: null,
} as const;
const room = (ageMs: number): ModelAvailability => ({
  kind: "room",
  leftPercent: 40,
  tone: "ok",
  binding,
  checkedAt: now - ageMs,
});
const staleLimit: ModelAvailability = {
  kind: "stale",
  leftPercent: null,
  wasExhausted: true,
  checkedAt: now - 37 * 60_000,
  resetSinceRead: false,
};

describe("usage re-check", () => {
  it("asks again for old or unsure readings only", () => {
    expect(needsUsageRecheck(room(60_000), now)).toBe(false);
    expect(needsUsageRecheck(room(6 * 60_000), now)).toBe(true);
    expect(needsUsageRecheck(staleLimit, now)).toBe(true);
    expect(needsUsageRecheck({ kind: "unknown", reason: "notRead" }, now)).toBe(true);
    expect(needsUsageRecheck({ kind: "unknown", reason: "notSignedIn" }, now)).toBe(false);
    expect(needsUsageRecheck({ kind: "unreported" }, now)).toBe(false);
    expect(needsUsageRecheck({ kind: "perToken" }, now)).toBe(false);
    expect(needsUsageRecheck({ kind: "offline", machineLabel: "M1" }, now)).toBe(false);
  });

  it("lets the closed chip ask only about an unsure limit", () => {
    expect(chipNeedsUsageRecheck(staleLimit)).toBe(true);
    expect(chipNeedsUsageRecheck(room(10 * 60_000))).toBe(false);
  });

  it("throttles each instance and skips one already being read", () => {
    const candidates = [
      { instanceId: "codex", state: staleLimit },
      { instanceId: "claudeAgent", state: staleLimit },
      { instanceId: "grok", state: staleLimit },
      { instanceId: "gemini", state: room(0) },
    ];
    const due = planUsageRecheck({
      candidates,
      nowMs: now,
      lastAskedAt: new Map([
        ["codex", now - 10_000],
        ["claudeAgent", now - USAGE_RECHECK_THROTTLE_MS - 1],
      ]),
      inFlight: new Set(["grok"]),
      throttleMs: USAGE_RECHECK_THROTTLE_MS,
    });
    expect(due).toEqual(["claudeAgent"]);
  });
});
