import { describe, expect, it } from "vite-plus/test";

import {
  UPDATE_PAUSE_SETTING_NAME,
  updatePauseOffReason,
  updatesMayPauseWork,
} from "./updatePause.ts";

describe("updatesMayPauseWork", () => {
  it("is off by default and for a missing settings object", () => {
    expect(updatesMayPauseWork(undefined)).toBe(false);
    expect(updatesMayPauseWork(null)).toBe(false);
    expect(updatesMayPauseWork({})).toBe(false);
    expect(updatesMayPauseWork({ pauseWorkForUpdates: false })).toBe(false);
  });

  it("is on only when the owner turned it on", () => {
    expect(
      updatesMayPauseWork({ pauseWorkForUpdates: true, continueThreadsAfterServerUpdate: true }),
    ).toBe(true);
    expect(updatesMayPauseWork({ pauseWorkForUpdates: true })).toBe(true);
  });

  it("never pauses when threads would not continue after the restart", () => {
    expect(
      updatesMayPauseWork({ pauseWorkForUpdates: true, continueThreadsAfterServerUpdate: false }),
    ).toBe(false);
  });
});

describe("updatePauseOffReason", () => {
  it("names the machine and the setting, and says it is not a blocker", () => {
    const reason = updatePauseOffReason("ministorm");
    expect(reason).toContain("ministorm");
    expect(reason).toContain(UPDATE_PAUSE_SETTING_NAME);
    expect(reason).toContain("not a blocker");
  });
});
