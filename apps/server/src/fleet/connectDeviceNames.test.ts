import { describe, expect, it } from "@effect/vitest";

import { sessionClient } from "../auth/sessionClientMetadata.ts";
import { describeDeviceClient, isOwnDeviceName } from "./connectDeviceNames.ts";

describe("connect device names (1327)", () => {
  it("never takes a label every client of one kind shares as a device's name", () => {
    for (const label of [
      "SpecWithCode Connect connect",
      "SpecWithCode Desktop",
      "SpecWithCode Web",
      "SpecWithCode Mobile",
      "Phone",
      "  ",
      undefined,
    ])
      expect(isOwnDeviceName(label)).toBe(false);
    expect(isOwnDeviceName("M5")).toBe(true);
    // The list's words for the owner and the update are never a device's name.
    for (const label of ["this machine", "The Update", "another device"])
      expect(isOwnDeviceName(label)).toBe(false);
  });

  it("names a nameless desktop from its session: system, app and version", () => {
    expect(
      describeDeviceClient({
        label: "SpecWithCode Connect connect",
        deviceType: "desktop",
        os: "macOS",
        browser: "Electron",
        userAgent: "Mozilla/5.0 (Macintosh) SpecWeaveStudio(Alpha)/1.0.338 Electron/39.0.0",
      }),
    ).toEqual({ label: "A Mac", named: false, system: "macOS", app: "SpecWithCode 1.0.338" });
    expect(
      describeDeviceClient({ label: "SpecWithCode Web", deviceType: "desktop", browser: "Chrome" }),
    ).toEqual({ label: "A computer", named: false, app: "Chrome" });
    expect(describeDeviceClient({ deviceType: "mobile", os: "iOS" })).toMatchObject({
      label: "An iPhone",
      named: false,
    });
  });

  it("keeps the device's own name, trimmed and capped", () => {
    expect(
      describeDeviceClient({ label: ` ${"x".repeat(100)} `, deviceType: "desktop", os: "Linux" }),
    ).toMatchObject({ label: "x".repeat(80), named: true, system: "Linux" });
  });

  it("a Connect session keeps the name the device sent, not the pairing link's label", () => {
    const request = { label: "M5", deviceType: "desktop" as const, os: "macOS" };
    const link = { subject: "cloud-connect", label: "SpecWithCode Connect connect" };
    expect(sessionClient(request, link).label).toBe("M5");
    // A client that sent only its kind gets the link's label, which reads as a stand-in.
    expect(
      sessionClient({ label: "SpecWithCode Desktop", deviceType: "desktop" }, link).label,
    ).toBe("SpecWithCode Connect connect");
    // Phones keep a name the hub gave them over the app's generic label.
    expect(
      sessionClient(
        { label: "SpecWithCode Mobile", deviceType: "mobile" },
        { subject: "phone-link:hub:s", label: "Anton's iPhone" },
      ).label,
    ).toBe("Anton's iPhone");
    // Sessions the gate does not cover keep the grant's label as before.
    expect(sessionClient(request, { subject: "mcp-client", label: "Codex" }).label).toBe("Codex");
    expect(sessionClient(request, { subject: "cloud-connect" }).label).toBe("M5");
  });
});
