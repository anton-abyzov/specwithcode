import { describe, expect, it } from "vite-plus/test";

import {
  chooseForNeeds,
  iosSimulatorElsewhereHint,
  localMachinePlatform,
  needsFit,
  readMachinePlatform,
} from "./launchNeeds.ts";

const mac = { os: "darwin", arch: "arm64", iosSimulators: true } as const;
const macWithoutXcode = { os: "darwin", arch: "arm64", iosSimulators: false } as const;
const macNotYetChecked = { os: "darwin", arch: "arm64" } as const;
const linux = { os: "linux", arch: "x64" } as const;
const windows = { os: "windows", arch: "x64" } as const;

const machine = (key: string, platform?: Parameters<typeof needsFit>[1]) => ({
  key,
  label: key,
  platform,
  value: key,
});

describe("needsFit", () => {
  it("reads a machine that has not said as unknown, never as cannot", () => {
    expect(needsFit(["ios_simulator"], undefined)).toBe("unknown");
    expect(needsFit(["ios_simulator"], { os: "unknown", arch: "other" })).toBe("unknown");
    expect(needsFit(["ios_simulator"], macNotYetChecked)).toBe("unknown");
  });

  it("asks for simulators on iOS work and for any Mac on Xcode work", () => {
    expect(needsFit(["ios_simulator"], mac)).toBe("yes");
    expect(needsFit(["ios_simulator"], macWithoutXcode)).toBe("no");
    expect(needsFit(["ios_simulator"], linux)).toBe("no");
    expect(needsFit(["macos"], macWithoutXcode)).toBe("yes");
    expect(needsFit(["macos"], windows)).toBe("no");
    expect(needsFit(["macos", "ios_simulator"], macNotYetChecked)).toBe("unknown");
  });
});

describe("chooseForNeeds", () => {
  it("keeps the usual order among machines that qualify, then tries ones that have not said", () => {
    const placed = chooseForNeeds({
      needs: ["ios_simulator"],
      preferred: [
        machine("here", linux),
        machine("old"),
        machine("m1", mac),
        machine("m2", windows),
        machine("m3", mac),
        machine("here", linux),
      ],
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.chosen.map((choice) => [choice.candidate.key, choice.fit])).toEqual([
      ["m1", "yes"],
      ["m3", "yes"],
      ["old", "unknown"],
    ]);
    expect(placed.chosen[0]!.note).toContain("m1 has it");
    expect(placed.skipped).toEqual([
      { machine: "here", reason: expect.stringContaining("Linux") },
      { machine: "m2", reason: expect.stringContaining("Windows") },
    ]);
  });

  it("refuses when no connected machine can, naming what each one is", () => {
    const placed = chooseForNeeds({
      needs: ["ios_simulator"],
      preferred: [machine("this machine", linux), machine("m1", macWithoutXcode)],
    });
    expect(placed).toEqual({ ok: false, message: expect.any(String) });
    if (placed.ok) return;
    expect(placed.message).toContain("needs an iOS Simulator");
    expect(placed.message).toContain("this machine is Linux");
    expect(placed.message).toContain("m1 is macOS without a working Xcode simctl");
    expect(placed.message).toContain("Settings > Machines");
  });

  it("refuses a named machine known not to qualify and allows one that has not said", () => {
    const pool = [machine("this machine", linux), machine("m3", mac)];
    const refused = chooseForNeeds({
      needs: ["ios_simulator"],
      explicit: machine("this machine", linux),
      preferred: pool,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toMatch(/^This machine cannot run this work/);
      expect(refused.message).toContain("Machines that can: m3.");
    }
    const unknown = chooseForNeeds({
      needs: ["ios_simulator"],
      explicit: machine("old"),
      preferred: pool,
    });
    expect(unknown.ok && unknown.chosen.map((choice) => choice.fit)).toEqual(["unknown"]);
  });
});

describe("machine platform reports", () => {
  it("reads another machine's report leniently", () => {
    expect(readMachinePlatform({})).toBeUndefined();
    expect(readMachinePlatform({ platform: "darwin" })).toBeUndefined();
    expect(
      readMachinePlatform({ platform: { os: "darwin", arch: "arm64", iosSimulators: true } }),
    ).toEqual(mac);
    // A system this build does not know is unknown, not a "no".
    expect(readMachinePlatform({ platform: { os: "plan9", arch: "riscv" } })).toEqual({
      os: "unknown",
      arch: "other",
    });
  });

  it("reports this machine without guessing before the simulator check answers", () => {
    expect(localMachinePlatform(linux, false)).toEqual({ ...linux, iosSimulators: false });
    expect(localMachinePlatform({ os: "darwin", arch: "arm64" }, undefined)).toEqual(
      macNotYetChecked,
    );
  });
});

describe("iosSimulatorElsewhereHint", () => {
  it("names the Macs that can and how to move the work there", () => {
    const hint = iosSimulatorElsewhereHint(["Studio Mac", "Laptop"]);
    expect(hint).toContain("Connected Macs that can: Studio Mac and Laptop.");
    expect(hint).toContain('needs:["ios_simulator"]');
    expect(hint).toContain('machine:"Studio Mac"');
    expect(hint).toContain("studio_thread_migrate");
    expect(iosSimulatorElsewhereHint([])).toContain("add a Mac in Settings > Machines");
  });
});
