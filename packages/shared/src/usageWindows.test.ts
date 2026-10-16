import { describe, expect, it } from "vite-plus/test";

import {
  blockingWindow,
  effectiveLeftPercent,
  windowAppliesToModel,
  windowModelScope,
} from "./usageWindows.ts";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const ahead = "2026-10-17T03:00:00.000Z";
const passed = "2026-10-15T11:00:00.000Z";

const session = (used: number, resetsAt = ahead) => ({
  id: "five_hour",
  label: "Session",
  usedPercent: used,
  resetsAt,
});
const weekly = (used: number, resetsAt = ahead) => ({
  id: "seven_day",
  label: "Weekly",
  usedPercent: used,
  resetsAt,
});
const fable = (used: number) => ({
  id: "seven_day_fable",
  label: "Weekly · Fable",
  usedPercent: used,
  resetsAt: ahead,
});

describe("windowModelScope", () => {
  it("reads the scope a host sends, or infers it from an older Claude window", () => {
    expect(windowModelScope({ ...fable(0), modelScope: "Fable" })).toBe("Fable");
    expect(windowModelScope(fable(0))).toBe("Fable");
    expect(windowModelScope(weekly(0))).toBeNull();
    expect(
      windowModelScope({ id: "seven_day_overage_included", label: "Weekly", usedPercent: 0 }),
    ).toBeNull();
  });
});

describe("windowAppliesToModel", () => {
  it("caps every model with account-wide windows and only the named family with a scoped one", () => {
    expect(windowAppliesToModel(weekly(0), "claude-opus-5-5")).toBe(true);
    expect(windowAppliesToModel(weekly(0), undefined)).toBe(true);
    expect(windowAppliesToModel(fable(0), "claude-fable-5-1")).toBe(true);
    expect(windowAppliesToModel(fable(0), "claude-opus-5-5")).toBe(false);
    expect(windowAppliesToModel(fable(0), undefined)).toBe(false);
  });
});

describe("blockingWindow", () => {
  it("blocks the session while the weekly is spent", () => {
    const windows = [session(0), weekly(100), fable(7)];
    expect(blockingWindow(windows[0]!, windows, now)?.id).toBe("seven_day");
    expect(blockingWindow(windows[2]!, windows, now)?.id).toBe("seven_day");
    expect(blockingWindow(windows[1]!, windows, now)).toBeNull();
  });

  it("lets a spent model window block only its own family", () => {
    const windows = [session(10), weekly(40), fable(100)];
    expect(blockingWindow(windows[0]!, windows, now)).toBeNull();
    expect(blockingWindow(windows[1]!, windows, now)).toBeNull();
  });

  it("ignores a spent window whose reset has passed", () => {
    const windows = [session(0), weekly(100, passed)];
    expect(blockingWindow(windows[0]!, windows, now)).toBeNull();
  });
});

describe("effectiveLeftPercent", () => {
  it("is the least left across the windows that apply to the model", () => {
    const windows = [session(0), weekly(100), fable(7)];
    expect(effectiveLeftPercent(windows, now, "claude-opus-5-5")).toBe(0);
    expect(effectiveLeftPercent([session(10), weekly(30), fable(80)], now, "claude-opus-5-5")).toBe(
      70,
    );
    expect(
      effectiveLeftPercent([session(10), weekly(30), fable(80)], now, "claude-fable-5-1"),
    ).toBe(20);
    // No model: only the account-wide windows count.
    expect(effectiveLeftPercent([session(10), fable(100)], now)).toBe(90);
    expect(effectiveLeftPercent([weekly(100, passed)], now)).toBeNull();
  });
});
