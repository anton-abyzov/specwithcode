import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, threadSyncLabel } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        error: null,
        syncGraceElapsed: false,
        staleHeld: false,
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible and the grace has passed", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        error: null,
        syncGraceElapsed: true,
        staleHeld: false,
      }),
    ).toBe("syncing");
  });

  it("does not show a short catch-up over visible messages", () => {
    for (const status of ["empty", "cached", "synchronizing"] as const) {
      expect(
        resolveThreadSyncPhase({
          detailExists: true,
          shellExists: true,
          status,
          error: null,
          syncGraceElapsed: false,
          staleHeld: false,
        }),
      ).toBeNull();
    }
  });

  it("marks visible messages stale instead of syncing forever after a failed catch-up", () => {
    for (const syncGraceElapsed of [false, true]) {
      expect(
        resolveThreadSyncPhase({
          detailExists: true,
          shellExists: true,
          status: "cached",
          error: "Could not synchronize the thread.",
          syncGraceElapsed,
          staleHeld: false,
        }),
      ).toBe("stale");
    }
  });

  it("stays stale through an automatic retry until the thread goes live", () => {
    for (const status of ["empty", "cached", "synchronizing"] as const) {
      for (const syncGraceElapsed of [false, true]) {
        expect(
          resolveThreadSyncPhase({
            detailExists: true,
            shellExists: true,
            status,
            error: null,
            syncGraceElapsed,
            staleHeld: true,
          }),
        ).toBe("stale");
      }
    }
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
        error: null,
        syncGraceElapsed: true,
        staleHeld: true,
      }),
    ).toBeNull();
  });

  it("keeps loading when a failed catch-up has no messages to show yet", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "empty",
        error: "thread not found yet",
        syncGraceElapsed: true,
        staleHeld: false,
      }),
    ).toBe("loading");
  });

  it("does not report a sync phase without a shell, after going live or once deleted", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
        error: null,
        syncGraceElapsed: true,
        staleHeld: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
        error: null,
        syncGraceElapsed: true,
        staleHeld: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "deleted",
        error: "Could not synchronize the thread.",
        syncGraceElapsed: true,
        staleHeld: false,
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
  });

  it("says when visible messages may be out of date", () => {
    expect(threadSyncLabel("stale")).toBe("Messages may be out of date");
  });
});
