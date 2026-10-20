import { describe, expect, it } from "vite-plus/test";
import { queuedAgeLabel } from "../components/chat/queuedRunSummary";
import { nowMinuteMs } from "./useNowMinute";

describe("nowMinuteMs", () => {
  it("reads the zone-less minute as UTC, whatever the local zone", () => {
    expect(nowMinuteMs("2026-10-19T20:25")).toBe(Date.parse("2026-10-19T20:25:00Z"));
  });

  it("keeps a just-queued message from reading hours old", () => {
    // A steer queued at 20:24:26 UTC, seen at 20:25 UTC: the queue showed "queued 3 h 59 min" in EDT.
    const queuedAtMs = Date.parse("2026-10-19T20:24:26Z");
    expect(queuedAgeLabel(queuedAtMs, nowMinuteMs("2026-10-19T20:25"))).toBe("queued just now");
  });
});
