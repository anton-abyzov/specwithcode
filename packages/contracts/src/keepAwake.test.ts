import { describe, expect, it } from "vite-plus/test";

import { keepAwakeAllowedOnPower } from "./keepAwake.ts";

describe("keepAwakeAllowedOnPower", () => {
  it("always allows the hold on a power adapter or an unknown source", () => {
    for (const policy of ["adapter-only", "until-low", "always"] as const) {
      expect(keepAwakeAllowedOnPower(policy, 30, { onBattery: false, level: 0.05 })).toBe(true);
      expect(keepAwakeAllowedOnPower(policy, 30, { onBattery: null, level: null })).toBe(true);
    }
  });

  it("lets the machine sleep on battery by default", () => {
    expect(keepAwakeAllowedOnPower("adapter-only", 30, { onBattery: true, level: 0.99 })).toBe(
      false,
    );
  });

  it("holds above the floor and releases at or below it", () => {
    expect(keepAwakeAllowedOnPower("until-low", 30, { onBattery: true, level: 0.31 })).toBe(true);
    expect(keepAwakeAllowedOnPower("until-low", 30, { onBattery: true, level: 0.3 })).toBe(false);
    expect(keepAwakeAllowedOnPower("until-low", 50, { onBattery: true, level: 0.4 })).toBe(false);
  });

  it("releases on battery when the level is unknown", () => {
    expect(keepAwakeAllowedOnPower("until-low", 20, { onBattery: true, level: null })).toBe(false);
  });

  it("keeps today's behaviour with Always", () => {
    expect(keepAwakeAllowedOnPower("always", 30, { onBattery: true, level: 0.01 })).toBe(true);
  });
});
