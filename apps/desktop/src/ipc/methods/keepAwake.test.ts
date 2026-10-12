import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { makeKeepAwakeController } from "./keepAwake.ts";

const fakeBlocker = () => {
  let next = 1;
  return { start: vi.fn(() => next++), stop: vi.fn() };
};

describe("makeKeepAwakeController", () => {
  it("holds one blocker while any window reports work", () => {
    const blocker = fakeBlocker();
    const controller = makeKeepAwakeController(blocker);
    controller.set(1, true);
    controller.set(2, true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    controller.set(1, false);
    expect(controller.isBlocking()).toBe(true);
    controller.set(2, false);
    expect(blocker.stop).toHaveBeenCalledWith(1);
    expect(controller.isBlocking()).toBe(false);
  });

  it("lets go when the reporting window closes", () => {
    const blocker = fakeBlocker();
    const controller = makeKeepAwakeController(blocker);
    controller.set(7, true);
    controller.release(7);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    controller.set(8, false);
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });
});
