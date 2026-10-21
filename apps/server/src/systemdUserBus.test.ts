import { describe, expect, it } from "vite-plus/test";

import { isUserBusError, userBusCandidates, userBusEnv } from "./systemdUserBus.ts";

const present =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe("userBusEnv", () => {
  it("adds the runtime folder and bus an `env -i` launcher dropped", () => {
    expect(
      userBusEnv({ PATH: "/usr/bin" }, 1000, present("/run/user/1000", "/run/user/1000/bus")),
    ).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  it("adds only the runtime folder when there is no bus socket", () => {
    expect(userBusEnv({}, 1000, present("/run/user/1000"))).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  it("never overrides values that are already set", () => {
    const env = { XDG_RUNTIME_DIR: "/custom", DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" };
    expect(userBusEnv(env, 1000, () => true)).toEqual({});
    expect(userBusEnv({ XDG_RUNTIME_DIR: "/custom" }, 1000, present("/custom/bus"))).toEqual({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
    });
  });

  it("adds nothing without a runtime folder or a user id", () => {
    expect(userBusEnv({}, 1000, () => false)).toEqual({});
    expect(userBusEnv({}, undefined, () => true)).toEqual({});
    expect(userBusCandidates({}, undefined)).toEqual([]);
  });

  it("checks the runtime folder and the bus in the runtime folder in use", () => {
    expect(userBusCandidates({}, 1000)).toEqual(["/run/user/1000", "/run/user/1000/bus"]);
    expect(userBusCandidates({ XDG_RUNTIME_DIR: "/custom" }, 1000)).toEqual([
      "/run/user/1000",
      "/custom/bus",
    ]);
  });
});

describe("isUserBusError", () => {
  it("knows systemctl's unreachable-manager wording and nothing else", () => {
    expect(isUserBusError("Failed to connect to bus: No medium found")).toBe(true);
    expect(isUserBusError("Failed to connect to user scope bus via local transport")).toBe(true);
    expect(
      isUserBusError(
        "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
      ),
    ).toBe(true);
    expect(isUserBusError("inactive")).toBe(false);
    expect(isUserBusError("")).toBe(false);
  });
});
