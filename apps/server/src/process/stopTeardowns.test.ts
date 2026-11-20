import { describe, expect, it } from "vite-plus/test";

import {
  holdFailedStopTeardown,
  retryFailedStopTeardown,
  stopTeardownFailed,
  stopTeardownPending,
  stopTeardownsThrough,
} from "./stopTeardowns.ts";

describe("failed Stop teardowns", () => {
  it("keeps the thread blocked until every failed teardown of it is confirmed gone", async () => {
    let firstGone = false;
    const tried: string[] = [];
    holdFailedStopTeardown("thread-a", async () => {
      tried.push("first");
      return firstGone;
    });
    holdFailedStopTeardown("thread-a", async () => {
      tried.push("second");
      return true;
    });
    // The second one is gone; the first still runs, so the thread stays blocked.
    expect(await retryFailedStopTeardown("thread-a")).toBe(false);
    expect(tried).toEqual(["first", "second"]);
    expect(stopTeardownPending("thread-a")).toBe(true);
    firstGone = true;
    expect(await retryFailedStopTeardown("thread-a")).toBe(true);
    expect(tried).toEqual(["first", "second", "first"]);
    expect(stopTeardownPending("thread-a")).toBe(false);
  });

  it("treats a retry that throws as not confirmed", async () => {
    holdFailedStopTeardown("thread-b", () => Promise.reject(new Error("unreadable")));
    expect(await retryFailedStopTeardown("thread-b")).toBe(false);
    expect(stopTeardownPending("thread-b")).toBe(true);
  });

  it("gives up on a retry that never answers and keeps the thread blocked", async () => {
    holdFailedStopTeardown("thread-c", () => new Promise<boolean>(() => {}));
    holdFailedStopTeardown("thread-c", async () => true);
    expect(await retryFailedStopTeardown("thread-c", 20)).toBe(false);
    expect(stopTeardownPending("thread-c")).toBe(true);
  });

  it("retries only the teardowns a check showed, and reports what holds the thread now", async () => {
    const tried: string[] = [];
    holdFailedStopTeardown("thread-d", async () => (tried.push("seen"), true));
    const seen = stopTeardownsThrough("thread-d")!;
    // Left by work started after the check.
    holdFailedStopTeardown("thread-d", async () => (tried.push("newer"), true));
    expect(await retryFailedStopTeardown("thread-d", undefined, seen)).toBe(false);
    expect(tried).toEqual(["seen"]);
    expect(stopTeardownFailed("thread-d")).toBe(true);
    expect(await retryFailedStopTeardown("thread-d")).toBe(true);
    expect(tried).toEqual(["seen", "newer"]);
  });

  it("is not confirmed while a teardown registered during the retry holds the thread", async () => {
    let releaseFirst = () => {};
    releaseFirst = holdFailedStopTeardown("thread-e", async () => {
      // Confirmed by its owner meanwhile, and a new teardown holds the thread.
      releaseFirst();
      holdFailedStopTeardown("thread-e", async () => false);
      return true;
    });
    expect(
      await retryFailedStopTeardown("thread-e", undefined, stopTeardownsThrough("thread-e")),
    ).toBe(false);
    expect(stopTeardownPending("thread-e")).toBe(true);
  });
});
