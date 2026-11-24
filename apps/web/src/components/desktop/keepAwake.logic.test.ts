import { describe, expect, it } from "vite-plus/test";

import {
  countLocalWorking,
  keepAwakeBatteryNotice,
  keepAwakeBatteryOption,
  makeBatteryNoticeMemory,
} from "./keepAwake.logic";

const thread = (environmentId: string, working = true) => ({
  environmentId,
  deletedAt: null,
  archivedAt: null,
  working,
});

describe("countLocalWorking", () => {
  it("counts only working threads on this machine's environment", () => {
    const threads = [
      thread("m5"),
      thread("m5"),
      thread("m4"),
      thread("m5", false),
      { ...thread("m5"), archivedAt: "2026-11-24T00:00:00Z" },
      { ...thread("m5"), deletedAt: "2026-11-24T00:00:00Z" },
    ];
    expect(countLocalWorking(threads, "m5")).toBe(2);
  });

  it("counts nothing for remote work alone or before the own machine is known", () => {
    expect(countLocalWorking([thread("m4"), thread("linux")], "m5")).toBe(0);
    expect(countLocalWorking([thread("m5")], null)).toBe(0);
  });
});

describe("keepAwakeBatteryNotice", () => {
  it("says nothing on a power adapter or with no local work", () => {
    expect(
      keepAwakeBatteryNotice({ onBattery: false, holding: true, working: 3, machine: "M5" }),
    ).toBeNull();
    expect(
      keepAwakeBatteryNotice({ onBattery: true, holding: false, working: 0, machine: "M5" }),
    ).toBeNull();
  });

  it("names the machine and the count when the hold lets go on battery", () => {
    const notice = keepAwakeBatteryNotice({
      onBattery: true,
      holding: false,
      working: 3,
      machine: "M5",
    });
    expect(notice?.kind).toBe("released");
    expect(notice?.title).toBe("M5 is on battery and can sleep while 3 threads work");
    expect(notice?.description).toContain("Nothing moves until you choose");
  });

  it("says when it keeps the machine awake on battery", () => {
    const notice = keepAwakeBatteryNotice({
      onBattery: true,
      holding: true,
      working: 1,
      machine: "M5",
    });
    expect(notice?.kind).toBe("held");
    expect(notice?.title).toBe("Keeping M5 awake on battery while 1 thread works");
  });
});

describe("makeBatteryNoticeMemory", () => {
  it("shows each kind once per battery session and again after plugging in", () => {
    const memory = makeBatteryNoticeMemory();
    const released = keepAwakeBatteryNotice({
      onBattery: true,
      holding: false,
      working: 2,
      machine: "M5",
    })!;
    const held = keepAwakeBatteryNotice({
      onBattery: true,
      holding: true,
      working: 2,
      machine: "M5",
    })!;
    expect(memory.take(released)).toBe(true);
    expect(memory.take({ ...released, title: "different count" })).toBe(false);
    expect(memory.take(held)).toBe(true);
    memory.pluggedIn();
    expect(memory.take(released)).toBe(true);
  });
});

describe("keepAwakeBatteryOption", () => {
  it("maps stored settings to a menu entry", () => {
    expect(keepAwakeBatteryOption("adapter-only", 30).value).toBe("adapter-only");
    expect(keepAwakeBatteryOption("always", 30).value).toBe("always");
    expect(keepAwakeBatteryOption("until-low", 30).value).toBe("until-low-30");
    expect(keepAwakeBatteryOption("until-low", 45).value).toBe("until-low-50");
    expect(keepAwakeBatteryOption("until-low", 10).value).toBe("until-low-20");
  });
});
