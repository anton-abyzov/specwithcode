import { describe, expect, it } from "vite-plus/test";

import {
  holdFailedStopTeardown,
  retryFailedStopTeardown,
  stopTeardownPending,
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
});
