import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../lib/runtime", () => ({ runPrimaryHttp: vi.fn() }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/session", () => ({ readPreparedConnection: () => null }));

import {
  describeSignInDevice,
  describeWaitingDevice,
  formatDeviceSignInCode,
  isCompleteDeviceSignInCode,
  submitDeviceSignInCode,
} from "./deviceSignIn";

describe("device sign-in helpers", () => {
  it("splits the six-character code for reading aloud", () => {
    expect(formatDeviceSignInCode("K7F3QX")).toBe("K7F-3QX");
    expect(formatDeviceSignInCode("ODD")).toBe("ODD");
  });

  it("names the approved device from its browser and system, or its type", () => {
    expect(describeSignInDevice({ browser: "Safari", os: "iOS", deviceType: "mobile" })).toBe(
      "Safari on iOS",
    );
    expect(describeSignInDevice({ browser: null, os: "macOS", deviceType: "desktop" })).toBe(
      "macOS",
    );
    expect(describeSignInDevice({ browser: null, os: null, deviceType: "mobile" })).toBe("A phone");
    expect(describeSignInDevice({ browser: null, os: null, deviceType: "desktop" })).toBe(
      "A computer",
    );
  });

  it("says which device is waiting, from where and since when", () => {
    const now = Date.parse("2026-10-11T10:05:00.000Z");
    expect(
      describeWaitingDevice(
        {
          browser: "Safari",
          os: "iOS",
          deviceType: "mobile",
          address: "100.64.0.7",
          askedAt: "2026-10-11T10:03:00.000Z",
        },
        now,
      ),
    ).toBe("Safari on iOS (100.64.0.7, asked 2 minutes ago)");
    expect(describeWaitingDevice({ browser: null, os: null, deviceType: "mobile" }, now)).toBe(
      "A phone",
    );
  });

  it("accepts a typed code only once it has six code characters", () => {
    expect(isCompleteDeviceSignInCode("k7f-3qx")).toBe(true);
    expect(isCompleteDeviceSignInCode("K7F 3QX")).toBe(true);
    expect(isCompleteDeviceSignInCode("K7F3Q")).toBe(false);
    expect(isCompleteDeviceSignInCode("K7F3Q0")).toBe(false);
  });

  it("asks nothing of a machine that is not connected", async () => {
    await expect(submitDeviceSignInCode("env" as never, "K7F3QX", false)).rejects.toThrow(
      "This machine is not connected.",
    );
  });
});
