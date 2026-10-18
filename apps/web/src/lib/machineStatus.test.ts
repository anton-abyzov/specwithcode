import { describe, expect, it } from "vite-plus/test";

import { lastSeenLabel, machineDetail, machineStatus } from "./machineStatus";

describe("machineStatus", () => {
  it("calls a machine unreachable once an attempt has failed, with the reason", () => {
    expect(machineStatus({ phase: "connected", error: null }, true)).toEqual({
      text: "Connected",
      reason: null,
      retryable: false,
    });
    expect(machineStatus({ phase: "connecting", error: null }, true).text).toBe("Connecting…");
    expect(
      machineStatus(
        { phase: "reconnecting", error: "M1 could not establish a WebSocket connection." },
        true,
      ),
    ).toEqual({
      text: "Can't reach. Retrying automatically",
      reason: "M1 could not establish a WebSocket connection.",
      retryable: true,
    });
    expect(machineStatus({ phase: "error", error: "Sign in again." }, true)).toEqual({
      text: "Connection failed",
      reason: "Sign in again.",
      retryable: true,
    });
    expect(machineStatus({ phase: "available", error: null }, true).retryable).toBe(false);
    expect(machineStatus({ phase: "connected", error: null }, false).text).toMatch(/Permission/);
  });
});

describe("lastSeenLabel", () => {
  it("says how long ago a machine was last connected", () => {
    const now = Date.parse("2026-10-17T18:00:00Z");
    expect(lastSeenLabel(null, now)).toBeNull();
    expect(lastSeenLabel(now - 20_000, now)).toBe("last seen just now");
    expect(lastSeenLabel(now - 2 * 3_600_000, now)).toBe("last seen 2h ago");
  });
});

describe("machineDetail", () => {
  it("puts last seen before a long reason so truncation keeps it", () => {
    expect(machineDetail("last seen 1m ago", "Failed to fetch remote environment endpoint")).toBe(
      "last seen 1m ago · Failed to fetch remote environment endpoint",
    );
    expect(machineDetail(null, "Sign in again.")).toBe("Sign in again.");
    expect(machineDetail("last seen 2h ago", null)).toBe("last seen 2h ago");
    expect(machineDetail(null, null)).toBe("");
  });
});
