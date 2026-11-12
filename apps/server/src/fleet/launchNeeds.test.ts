import { OrchestratorMcpMachinePlatform } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
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

describe("chooseForNeeds with the usual machines first", () => {
  it("uses other connected machines only when no usual one reports the need", () => {
    const kept = chooseForNeeds({
      needs: ["ios_simulator"],
      preferred: [machine("listed", mac)],
      fallback: [machine("other", mac)],
    });
    expect(kept.ok && kept.chosen.map((choice) => choice.candidate.key)).toEqual(["listed"]);

    const outside = chooseForNeeds({
      needs: ["ios_simulator"],
      preferred: [machine("listed", linux), machine("old")],
      fallback: [machine("other", mac), machine("listed", linux)],
    });
    expect(outside.ok).toBe(true);
    if (!outside.ok) return;
    expect(outside.chosen.map((choice) => [choice.candidate.key, choice.fit])).toEqual([
      ["other", "yes"],
      ["old", "unknown"],
    ]);
    expect(outside.chosen[0]!.note).toContain("Chosen outside the usual machines (listed and old)");
    expect(outside.skipped).toEqual([
      { machine: "listed", reason: expect.stringContaining("Linux") },
    ]);
  });
});

describe("chooseForNeeds for Mac work and full Xcode", () => {
  const withXcode = { os: "darwin", arch: "arm64", xcodeBuild: true } as const;
  const toolsOnly = { os: "darwin", arch: "arm64", xcodeBuild: false } as const;
  const olderMac = { os: "darwin", arch: "x64" } as const;

  it("puts a Mac with full Xcode first, then one that has not said, then one without", () => {
    const placed = chooseForNeeds({
      needs: ["macos"],
      preferred: [
        machine("here", linux),
        machine("tools only", toolsOnly),
        machine("older", olderMac),
        machine("studio mac", withXcode),
        machine("unknown"),
      ],
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.chosen.map((choice) => [choice.candidate.key, choice.fit])).toEqual([
      ["studio mac", "yes"],
      ["older", "yes"],
      ["tools only", "yes"],
      ["unknown", "unknown"],
    ]);
    expect(placed.chosen[0]!.note).not.toContain("no full Xcode");
    expect(placed.chosen[2]!.note).toContain(
      "This Mac has no full Xcode; an Xcode build will fail there.",
    );
    expect(placed.skipped).toEqual([{ machine: "here", reason: expect.stringContaining("Linux") }]);
  });

  it("still uses a Mac without full Xcode when it is the only Mac, and never a non-Mac", () => {
    const placed = chooseForNeeds({
      needs: ["macos"],
      preferred: [machine("here", linux), machine("pc", windows), machine("laptop", toolsOnly)],
    });
    expect(placed.ok && placed.chosen.map((choice) => choice.candidate.key)).toEqual(["laptop"]);
    const named = chooseForNeeds({
      needs: ["macos"],
      explicit: machine("laptop", toolsOnly),
      preferred: [],
    });
    expect(named.ok && named.chosen[0]!.note).toContain("no full Xcode");
    const none = chooseForNeeds({
      needs: ["macos"],
      preferred: [machine("here", linux), machine("pc", windows)],
    });
    expect(none.ok).toBe(false);
  });

  it("looks past usual Macs without full Xcode for a connected one that has it", () => {
    const placed = chooseForNeeds({
      needs: ["macos"],
      preferred: [machine("laptop", toolsOnly)],
      fallback: [machine("studio mac", withXcode), machine("pc", windows)],
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.chosen.map((choice) => choice.candidate.key)).toEqual(["studio mac", "laptop"]);
    expect(placed.chosen[0]!.note).toContain("none of them reports full Xcode");
  });

  it("leaves iOS Simulator placement as it was, whatever a Mac says about Xcode builds", () => {
    const placed = chooseForNeeds({
      needs: ["ios_simulator"],
      preferred: [
        machine("first", { ...mac, xcodeBuild: false }),
        machine("second", { ...mac, xcodeBuild: true }),
      ],
    });
    expect(placed.ok && placed.chosen.map((choice) => choice.candidate.key)).toEqual([
      "first",
      "second",
    ]);
    expect(placed.ok && placed.chosen[0]!.note).not.toContain("Xcode build will fail");
  });
});

describe("machine platform reports", () => {
  it("reads another machine's report leniently", () => {
    expect(readMachinePlatform({})).toBeUndefined();
    expect(readMachinePlatform({ platform: "darwin" })).toBeUndefined();
    expect(
      readMachinePlatform({ platform: { os: "darwin", arch: "arm64", iosSimulators: true } }),
    ).toEqual(mac);
    expect(
      readMachinePlatform({ platform: { os: "darwin", arch: "arm64", xcodeBuild: false } }),
    ).toEqual({ os: "darwin", arch: "arm64", xcodeBuild: false });
    // An older machine that does not send xcodeBuild still reads, as not said.
    expect(readMachinePlatform({ platform: { os: "darwin", arch: "arm64" } })).toEqual(
      macNotYetChecked,
    );
    // A system this build does not know is unknown, not a "no".
    expect(readMachinePlatform({ platform: { os: "plan9", arch: "riscv" } })).toEqual({
      os: "unknown",
      arch: "other",
    });
  });

  it("decodes a report from an older machine that does not send xcodeBuild", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpMachinePlatform);
    expect(decode({ os: "darwin", arch: "arm64", iosSimulators: true })).toEqual(mac);
    expect(decode({ os: "darwin", arch: "arm64", xcodeBuild: false })).toEqual({
      os: "darwin",
      arch: "arm64",
      xcodeBuild: false,
    });
  });

  it("reports this machine without guessing before the simulator check answers", () => {
    expect(localMachinePlatform(linux, false)).toEqual({ ...linux, iosSimulators: false });
    expect(localMachinePlatform({ os: "darwin", arch: "arm64" }, undefined)).toEqual(
      macNotYetChecked,
    );
    expect(localMachinePlatform(linux, false, false)).toEqual({
      ...linux,
      iosSimulators: false,
      xcodeBuild: false,
    });
    expect(localMachinePlatform({ os: "darwin", arch: "arm64" }, true, true)).toEqual({
      ...mac,
      xcodeBuild: true,
    });
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
