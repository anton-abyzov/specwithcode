import { describe, expect, it } from "@effect/vitest";

import { simulatorModels } from "./DeviceHubOperations.ts";

describe("simulatorModels", () => {
  it("names each simulator by its device type, not by its own name", () => {
    const json = JSON.stringify({
      devicetypes: [
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
          name: "iPhone 18 Pro",
        },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo", name: "iPhone Duo" },
      ],
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
          {
            udid: "A",
            name: "Agent test phone",
            deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
          },
          {
            udid: "B",
            name: "iPhone 18 Pro",
            deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
          },
          { udid: "C", name: "Unknown type", deviceTypeIdentifier: "com.example.Unknown" },
          { udid: "D", name: "No type" },
        ],
      },
    });
    expect([...simulatorModels(json)]).toEqual([
      ["A", "iPhone Duo"],
      ["B", "iPhone 18 Pro"],
    ]);
  });

  it("returns no models for output it cannot read", () => {
    expect(simulatorModels("not json").size).toBe(0);
    expect(simulatorModels(JSON.stringify({ devices: [] })).size).toBe(0);
  });
});
