import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetRemoteWorkerLaunchersForTests,
  currentRemoteWorkerLaunchers,
  publishRemoteWorkerLaunchers,
  remoteWorkerLaunchersSettled,
  withdrawRemoteWorkerLaunchers,
} from "./remoteWorkerLaunchers";

const worker = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

afterEach(() => {
  __resetRemoteWorkerLaunchersForTests();
  vi.useRealTimers();
});

describe("remote worker launchers", () => {
  it("joins every published source", () => {
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c1"]]), true);
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t2"), "c2"]]), false);
    expect([...currentRemoteWorkerLaunchers()]).toEqual([
      [worker("w", "t1"), "c1"],
      [worker("w", "t2"), "c2"],
    ]);
  });

  it("keeps the first published source's coordinator when two disagree", () => {
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c1"]]), true);
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t1"), "c2"]]), true);
    expect(currentRemoteWorkerLaunchers().get(worker("w", "t1"))).toBe("c1");
    // Publishing again keeps a source's place.
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c3"]]), true);
    expect(currentRemoteWorkerLaunchers().get(worker("w", "t1"))).toBe("c3");
  });

  it("forgets a withdrawn source", () => {
    publishRemoteWorkerLaunchers("sidebar", new Map([[worker("w", "t1"), "c1"]]), true);
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t1"), "c2"]]), true);
    withdrawRemoteWorkerLaunchers("sidebar");
    expect(currentRemoteWorkerLaunchers().get(worker("w", "t1"))).toBe("c2");
    withdrawRemoteWorkerLaunchers("overview");
    expect(currentRemoteWorkerLaunchers().size).toBe(0);
  });

  it("is settled at once when a source is complete", async () => {
    vi.useFakeTimers();
    publishRemoteWorkerLaunchers("sidebar", new Map(), true);
    let settled = false;
    void remoteWorkerLaunchersSettled(3000).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles when a source becomes complete, and clears its timer", async () => {
    vi.useFakeTimers();
    publishRemoteWorkerLaunchers("sidebar", new Map(), false);
    let settled = false;
    void remoteWorkerLaunchersSettled(3000).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    publishRemoteWorkerLaunchers("overview", new Map([[worker("w", "t1"), "c1"]]), true);
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles at the timeout when nothing is ever published", async () => {
    vi.useFakeTimers();
    let settled = false;
    void remoteWorkerLaunchersSettled(3000).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
