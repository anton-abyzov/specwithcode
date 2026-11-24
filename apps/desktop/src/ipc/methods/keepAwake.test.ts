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

describe("makeKeepAwakeController on battery (1457)", () => {
  const power = (onBattery: boolean) => {
    const state = { onBattery };
    return { state, read: () => state.onBattery };
  };

  it("releases on unplug by default and holds again on plug-in", () => {
    const blocker = fakeBlocker();
    const source = power(false);
    const controller = makeKeepAwakeController(blocker, source.read);
    expect(controller.set(1, { active: true })).toEqual({ holding: true, onBattery: false });
    source.state.onBattery = true;
    controller.resync();
    expect(controller.isBlocking()).toBe(false);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    source.state.onBattery = false;
    controller.resync();
    expect(controller.isBlocking()).toBe(true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("treats an old report without a choice as Only on power adapter", () => {
    const controller = makeKeepAwakeController(fakeBlocker(), power(true).read);
    expect(controller.set(1, true)).toEqual({ holding: false, onBattery: true });
  });

  it("holds above the floor and lets go at it", () => {
    const controller = makeKeepAwakeController(fakeBlocker(), power(true).read);
    const report = { active: true, onBattery: "until-low", batteryFloorPercent: 30 } as const;
    expect(controller.set(1, { ...report, batteryLevel: 0.6 }).holding).toBe(true);
    expect(controller.set(1, { ...report, batteryLevel: 0.3 }).holding).toBe(false);
    expect(controller.set(1, { ...report, batteryLevel: null }).holding).toBe(false);
  });

  it("keeps holding on battery with Always", () => {
    const controller = makeKeepAwakeController(fakeBlocker(), power(true).read);
    expect(controller.set(1, { active: true, onBattery: "always" }).holding).toBe(true);
  });

  it("holds when any window's choice allows it", () => {
    const controller = makeKeepAwakeController(fakeBlocker(), power(true).read);
    controller.set(1, { active: true });
    expect(controller.set(2, { active: true, onBattery: "always" }).holding).toBe(true);
    controller.release(2);
    expect(controller.isBlocking()).toBe(false);
  });
});
