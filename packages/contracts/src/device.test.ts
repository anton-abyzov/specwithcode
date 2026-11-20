import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEVICE_PLATFORM_SETUP_CODES,
  DeviceHostSummary,
  deviceToolInstallMessage,
  isDevicePlatformSetupCode,
} from "./device.ts";

describe("device tool install progress", () => {
  it("distinguishes a new install from an upgrade and chooses versions numerically", () => {
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing device hub 0.11.0…");
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: ["0.9.0", "0.10.0"],
        runningVersion: null,
      }),
    ).toBe("Updating device hub from 0.10.0 to 0.11.0…");
  });
});

describe("device platform setup codes", () => {
  const decode = Schema.decodeUnknownSync(DeviceHostSummary);
  const host = (platforms: ReadonlyArray<object>) => ({
    id: "local",
    kind: "local",
    label: "This machine",
    platforms,
    hubInstalled: false,
    agentDeviceInstalled: false,
  });

  it("decodes a snapshot from an older machine that sends text only", () => {
    const summary = decode(
      host([
        { platform: "ios", available: false, reason: "Xcode command line tools were not found." },
        { platform: "android", available: true },
      ]),
    );
    expect(summary.platforms[0]).toEqual({
      platform: "ios",
      available: false,
      reason: "Xcode command line tools were not found.",
    });
    expect(summary.platforms[0]?.code).toBeUndefined();
  });

  it("decodes codes, missing parts and Xcode facts, and a code this build does not know", () => {
    const summary = decode(
      host([
        {
          platform: "ios",
          available: false,
          reason: "Xcode was not found.",
          code: "xcode_missing",
          xcodeAppFound: false,
          simctlAnswered: false,
        },
        {
          platform: "android",
          available: false,
          code: "android_tools_missing",
          missing: ["emulator", "cmdline_tools"],
        },
      ]),
    );
    expect(summary.platforms[1]?.missing).toEqual(["emulator", "cmdline_tools"]);
    const newer = decode(host([{ platform: "ios", available: false, code: "visionos_missing" }]));
    expect(newer.platforms[0]?.code).toBe("visionos_missing");
    expect(isDevicePlatformSetupCode("visionos_missing")).toBe(false);
    expect(DEVICE_PLATFORM_SETUP_CODES.every(isDevicePlatformSetupCode)).toBe(true);
  });
});
