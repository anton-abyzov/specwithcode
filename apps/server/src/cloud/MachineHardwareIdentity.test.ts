import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  hashMachineHardwareIdentity,
  normalizeLinuxMachineId,
  parseIoregPlatformUuid,
  parseWindowsMachineGuid,
} from "./MachineHardwareIdentity.ts";

describe("MachineHardwareIdentity", () => {
  it("reads the platform UUID from ioreg", () => {
    const stdout = `+-o J616cAP  <class IOPlatformExpertDevice, id 0x100000213>
    {
      "IOPlatformSerialNumber" = "SERIAL"
      "IOPlatformUUID" = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809"
    }`;
    expect(parseIoregPlatformUuid(stdout)).toBe("1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809");
    expect(parseIoregPlatformUuid('"IOPlatformSerialNumber" = "SERIAL"')).toBeNull();
  });

  it("reads MachineGuid from reg query", () => {
    const stdout = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    3f2504e0-4f89-11d3-9a0c-0305e82c3301
`;
    expect(parseWindowsMachineGuid(stdout)).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(parseWindowsMachineGuid("ERROR: The system was unable to find")).toBeNull();
  });

  it("accepts only an initialized systemd machine id", () => {
    expect(normalizeLinuxMachineId("4C4C4544004D3910804AB2C04F4B3732\n")).toBe(
      "4c4c4544004d3910804ab2c04f4b3732",
    );
    expect(normalizeLinuxMachineId("uninitialized\n")).toBeNull();
    expect(normalizeLinuxMachineId("0".repeat(32))).toBeNull();
    expect(normalizeLinuxMachineId("")).toBeNull();
  });

  it.effect("hashes the id and home so the raw id never leaves the machine", () =>
    Effect.gen(function* () {
      const hardwareId = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";
      const home = "/Users/anton/.specwithcode";
      const hash = yield* hashMachineHardwareIdentity({ platform: "darwin", hardwareId, home });

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain(hardwareId.toLowerCase().replaceAll("-", ""));
      // Same machine, same home: the same identity after a reinstall.
      expect(
        yield* hashMachineHardwareIdentity({
          platform: "darwin",
          hardwareId: hardwareId.toLowerCase(),
          home,
        }),
      ).toBe(hash);
      // Another home on the same computer is another machine.
      expect(
        yield* hashMachineHardwareIdentity({
          platform: "darwin",
          hardwareId,
          home: "/Users/anton/.specwithcode/fleet-worker",
        }),
      ).not.toBe(hash);
      // Another computer is another machine, whatever it is called.
      expect(
        yield* hashMachineHardwareIdentity({
          platform: "darwin",
          hardwareId: "FFFFFFFF-5E6F-7081-92A3-B4C5D6E7F809",
          home,
        }),
      ).not.toBe(hash);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
