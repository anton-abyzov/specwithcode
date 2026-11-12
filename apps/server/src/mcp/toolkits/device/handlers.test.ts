import { describe, expect, it } from "vite-plus/test";

import {
  agentDeviceQuickStart,
  agentDeviceTargetArgs,
  iosOnlyElsewhere,
  pngDimensions,
} from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

describe("device tool helpers", () => {
  it("pins agent-device commands to the device by platform-specific flag", () => {
    expect(agentDeviceTargetArgs(device)).toEqual(["--platform", "ios", "--udid", "ABCD-1234"]);
    expect(agentDeviceTargetArgs({ ...device, platform: "android", id: "emulator-5554" })).toEqual([
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
    ]);
  });

  it("writes the quick start around the pinned target", () => {
    const text = agentDeviceQuickStart(device);
    expect(text).toContain("agent-device snapshot -i --platform ios --udid ABCD-1234");
    expect(text).toContain("iPhone 17 Pro (iOS 27.0)");
    expect(text).toContain("XCTest runner");
  });

  it("uses the absolute launcher in every quick-start command", () => {
    const text = agentDeviceQuickStart(
      device,
      ["--session", "thread-1", "--config", "/tmp/host.json"],
      "/tmp/studio tools/agent-device",
    );
    expect(text).toContain(
      "'/tmp/studio tools/agent-device' snapshot -i --session thread-1 --config /tmp/host.json",
    );
    expect(text).not.toContain("  agent-device ");
    expect(text).not.toContain("is on PATH");
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});

describe("iosOnlyElsewhere", () => {
  const host = (kind: "local" | "ssh") => ({
    id: kind === "local" ? "local" : "lab",
    kind,
    label: kind,
    platforms: [
      { platform: "ios" as const, available: true },
      { platform: "android" as const, available: true },
    ],
    hubInstalled: true,
    agentDeviceInstalled: true,
  });
  const here = { hosts: [host("local")], devices: [] } as never;

  it("points to a Mac only when this machine cannot run iOS and no device host is set up", () => {
    expect(iosOnlyElsewhere(here, {}, "no")).toBe(true);
    expect(iosOnlyElsewhere(here, { platform: "ios" }, "no")).toBe(true);
    expect(iosOnlyElsewhere(here, { platform: "android" }, "no")).toBe(false);
    expect(
      iosOnlyElsewhere({ hosts: [host("local"), host("ssh")], devices: [] } as never, {}, "no"),
    ).toBe(false);
  });

  it("follows the simulator check, not the host's xcrun report", () => {
    expect(iosOnlyElsewhere(here, { platform: "ios" }, "yes")).toBe(false);
    expect(iosOnlyElsewhere(here, { platform: "ios" }, "unknown")).toBe(false);
  });

  it("leaves a device id lookup and listed iOS devices alone", () => {
    expect(iosOnlyElsewhere(here, { deviceId: "TYPO" as never }, "no")).toBe(false);
    expect(
      iosOnlyElsewhere(
        { hosts: [host("local")], devices: [{ ...device, hostId: "local" }] } as never,
        { platform: "ios" },
        "no",
      ),
    ).toBe(false);
  });
});
