import { describe, expect, it } from "vite-plus/test";

import { isResettableBundleId, waitForPermission } from "./permissionWait.ts";

function clock() {
  let time = 1_000;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("waitForPermission", () => {
  it("resolves once, on the first check that reads granted", async () => {
    const c = clock();
    let checks = 0;
    const granted = await waitForPermission({
      granted: async () => ++checks === 3,
      waitMs: 120_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(granted).toBe(true);
    expect(checks).toBe(3);
  });

  it("gives up after the wait when nothing changes", async () => {
    const c = clock();
    let checks = 0;
    const granted = await waitForPermission({
      granted: async () => {
        checks += 1;
        return false;
      },
      waitMs: 10_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(granted).toBe(false);
    expect(checks).toBe(10);
  });

  it("never holds an action past its fixed deadline, whatever the user clicks", async () => {
    const c = clock();
    let checks = 0;
    const granted = await waitForPermission({
      granted: async () => ++checks === 11,
      waitMs: 10_000,
      now: c.now,
      sleep: c.sleep,
    });
    // The grant at 11 s comes after the server stopped waiting; the action must not run.
    expect(granted).toBe(false);
    expect(checks).toBe(10);
  });
});

describe("isResettableBundleId", () => {
  it("allows only SpecWithCode's own bundles", () => {
    expect(isResettableBundleId("com.specweave.studio")).toBe(true);
    expect(isResettableBundleId("com.specweave.studio.dev")).toBe(true);
    expect(isResettableBundleId("com.specweave.studio.dev.specweavestudio")).toBe(true);
    expect(isResettableBundleId("com.github.Electron")).toBe(false);
    expect(isResettableBundleId("com.specweave.studio.evil")).toBe(false);
    expect(isResettableBundleId("")).toBe(false);
  });
});
