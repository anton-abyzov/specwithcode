import { describe, expect, it } from "vite-plus/test";

import { isReservedDeviceName } from "./reservedDeviceNames.ts";

describe("isReservedDeviceName", () => {
  it("catches the lists' words however a device spells them", () => {
    for (const name of [
      "this machine",
      "This  machine",
      " this-machine. ",
      "THIS_MACHINE",
      "thís machíne",
      "ｔｈｉｓ ｍａｃｈｉｎｅ",
      "thіs mасhine", // Cyrillic і, а, с
      "This machine (M4)",
      "the update",
      "The-Upd4te".replace("4", "a"),
      "another device",
      "an0ther dev1ce".replace("1", "i"),
    ])
      expect(isReservedDeviceName(name), name).toBe(true);
  });

  it("leaves ordinary device names alone", () => {
    for (const name of ["M5", "Anton's MacBook Pro", "linux-mini", "iPhone", "Machine room PC"])
      expect(isReservedDeviceName(name), name).toBe(false);
  });
});
