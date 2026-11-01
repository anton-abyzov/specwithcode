import type { RelayPhoneRecord } from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import {
  lastSeenLabel,
  phoneDetail,
  removedPhoneToast,
  removePhoneDialogCopy,
  sortPhones,
  visiblePhones,
} from "./PhoneDevices.logic";

const now = Date.parse("2026-10-31T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const phone = (overrides: Partial<RelayPhoneRecord> = {}): RelayPhoneRecord => ({
  deviceId: "device-1",
  label: "Anton's iPhone",
  platform: "ios",
  model: "iPhone 16 Pro",
  appVersion: "0.1.1",
  lastSeenAt: minutesAgo(30),
  current: false,
  ...overrides,
});

describe("lastSeenLabel", () => {
  it("names recent activity in plain units", () => {
    expect(lastSeenLabel(minutesAgo(1), now)).toBe("Active now");
    expect(lastSeenLabel(minutesAgo(5), now)).toBe("Last seen 5 minutes ago");
    expect(lastSeenLabel(minutesAgo(60), now)).toBe("Last seen 1 hour ago");
    expect(lastSeenLabel(minutesAgo(60 * 5), now)).toBe("Last seen 5 hours ago");
    expect(lastSeenLabel(minutesAgo(60 * 24), now)).toBe("Last seen 1 day ago");
  });

  it("shows a date for older activity and survives bad input", () => {
    expect(lastSeenLabel(minutesAgo(60 * 24 * 30), now)).toMatch(/^Last seen \D+/);
    expect(lastSeenLabel("not a date", now)).toBe("Last seen unknown");
    // A phone clock ahead of this one is still "now".
    expect(lastSeenLabel(minutesAgo(-10), now)).toBe("Active now");
  });
});

describe("phoneDetail", () => {
  it("pairs the model with when it was last seen", () => {
    expect(phoneDetail(phone(), now)).toBe("iPhone 16 Pro · Last seen 30 minutes ago");
  });

  it("falls back to the platform when the app did not report a model", () => {
    expect(phoneDetail(phone({ model: null }), now)).toBe("iPhone · Last seen 30 minutes ago");
    expect(phoneDetail(phone({ model: null, platform: "android" }), now)).toBe(
      "Android phone · Last seen 30 minutes ago",
    );
  });
});

describe("sortPhones", () => {
  it("lists the current phone first, then the most recently seen", () => {
    const old = phone({ deviceId: "old", lastSeenAt: minutesAgo(600) });
    const recent = phone({ deviceId: "recent", lastSeenAt: minutesAgo(1) });
    const current = phone({ deviceId: "current", lastSeenAt: minutesAgo(900), current: true });
    expect(sortPhones([old, recent, current]).map((entry) => entry.deviceId)).toEqual([
      "current",
      "recent",
      "old",
    ]);
  });
});

describe("visiblePhones", () => {
  it("hides phones removed here before the relay listing catches up", () => {
    const kept = phone({ deviceId: "kept" });
    const removed = phone({ deviceId: "removed" });
    expect(visiblePhones([kept, removed], new Set(["removed"]))).toEqual([kept]);
  });
});

describe("copy", () => {
  it("says what removing does and how to undo it", () => {
    expect(removePhoneDialogCopy(phone())).toEqual({
      title: "Remove Anton's iPhone?",
      description:
        "It stops getting alerts and can no longer reach your computers. To use it again, sign in to SpecWithCode Connect on that phone.",
    });
  });

  it("confirms the removal, or that the phone was already gone", () => {
    expect(removedPhoneToast(phone(), { removed: true }).title).toBe("Phone removed");
    expect(removedPhoneToast(phone(), { removed: false }).title).toBe("Phone already removed");
  });
});
