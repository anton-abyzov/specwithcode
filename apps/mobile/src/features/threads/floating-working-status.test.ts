import { describe, expect, it, vi } from "vite-plus/test";

import type { BackgroundFloatingStatus } from "./background-work-status";
import {
  connectionFloatingStatus,
  floatingStatusInteractive,
  floatingStatusLabelKey,
} from "./floating-working-status";

const background = (label: string): BackgroundFloatingStatus => ({
  kind: "background",
  workKind: "workflow",
  label,
  code: false,
  accessibilityLabel: label,
  details: label,
  detailsTitle: "Waiting on background work",
  stop: { stopping: false, onStop: () => {} },
});

describe("floatingStatusLabelKey", () => {
  it("keeps the background row mounted while a workflow reports progress", () => {
    expect(floatingStatusLabelKey(background("Ship · Phase 1"))).toBe(
      floatingStatusLabelKey(background("Ship · Phase 2")),
    );
  });

  it("swaps rows for a new label elsewhere, but not for the running timer", () => {
    expect(floatingStatusLabelKey({ kind: "syncing", label: "Syncing" })).toBe("syncing:Syncing");
    expect(floatingStatusLabelKey({ kind: "working", startedAt: "2026-10-11T00:00:00Z" })).toBe(
      "working",
    );
    expect(floatingStatusLabelKey({ kind: "compacting" })).toBe("compacting");
  });
});

describe("floatingStatusInteractive", () => {
  it("passes touches to background work's stop button and long press", () => {
    expect(floatingStatusInteractive(background("Ship"))).toBe(true);
    expect(floatingStatusInteractive({ kind: "working", startedAt: "2026-10-11T00:00:00Z" })).toBe(
      false,
    );
    expect(floatingStatusInteractive(null)).toBe(false);
  });
});

const status = (
  connectionState: Parameters<typeof connectionFloatingStatus>[0]["connectionState"],
  overrides: { connectionError?: string | null; environmentLabel?: string | null } = {},
) =>
  connectionFloatingStatus({
    connectionError: overrides.connectionError ?? null,
    connectionState,
    environmentLabel:
      overrides.environmentLabel === undefined ? "Mac mini" : overrides.environmentLabel,
    onReconnect: () => {},
  });

describe("connectionFloatingStatus", () => {
  it("yields the pill to sync and working state once connected", () => {
    expect(status("connected")).toBeNull();
  });

  it("names the environment it is retrying, and says so only after a failure", () => {
    expect(status("connecting")).toMatchObject({
      tone: "reconnecting",
      label: "Reconnecting to Mac mini...",
    });
    expect(status("reconnecting", { connectionError: "ECONNREFUSED" })).toMatchObject({
      tone: "reconnecting",
      label: "Failed to connect. Retrying Mac mini...",
    });
  });

  it("reports why the environment is unreachable", () => {
    expect(status("offline")).toMatchObject({
      tone: "unavailable",
      label: "You are offline",
    });
    expect(status("available")).toMatchObject({
      tone: "unavailable",
      label: "Mac mini is not connected",
    });
    expect(status("error", { connectionError: "handshake timed out" })).toMatchObject({
      label: "Failed to connect to Mac mini: handshake timed out",
    });
    expect(status("error")).toMatchObject({ label: "Failed to connect to Mac mini" });
  });

  it("falls back to a generic name when the environment has no label", () => {
    expect(status("error", { environmentLabel: null })).toMatchObject({
      label: "Failed to connect to Environment",
    });
  });

  it("carries the reconnect handler so the pill can trigger it", () => {
    const onReconnect = vi.fn();
    const pill = connectionFloatingStatus({
      connectionError: null,
      connectionState: "offline",
      environmentLabel: "Mac mini",
      onReconnect,
    });
    if (pill?.kind !== "connection") throw new Error("expected a connection pill");
    pill.onPress();
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
