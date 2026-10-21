import { describe, expect, it } from "vite-plus/test";

import {
  describeServerUpdate,
  serverUpdateRowText,
  type ServerUpdateWordingInput,
} from "./serverUpdateWording";

const ministorm: ServerUpdateWordingInput = {
  machine: "ministorm",
  serverVersion: "1.0.65",
  clientVersion: "1.0.66",
  selfUpdate: "boot-service",
  threadContinuation: false,
  continueThreadsAfterServerUpdate: false,
};

describe("serverUpdateRowText", () => {
  it("names the machine and both versions", () => {
    expect(serverUpdateRowText(ministorm)).toEqual({
      name: "ministorm",
      versions: "1.0.65 → 1.0.66",
    });
  });

  it("calls the only server Server", () => {
    expect(serverUpdateRowText({ ...ministorm, machine: null })).toEqual({
      name: "Server",
      versions: "1.0.65 → 1.0.66",
    });
  });
});

describe("describeServerUpdate", () => {
  it.each(["boot-service", "respawn"] as const)(
    "says a %s server installs this app's release and restarts",
    (selfUpdate) => {
      expect(describeServerUpdate({ ...ministorm, selfUpdate })).toBe(
        "SpecWithCode on ministorm runs 1.0.65; this app runs 1.0.66. " +
          "Update installs 1.0.66 on ministorm and restarts its server. " +
          "Threads running there stop for the restart. " +
          "Nothing else on ministorm changes: no settings, no other software.",
      );
    },
  );

  it("says a desktop-managed server relaunches the app on the newest release", () => {
    expect(describeServerUpdate({ ...ministorm, selfUpdate: "desktop-managed" })).toBe(
      "SpecWithCode on ministorm runs 1.0.65; this app runs 1.0.66. " +
        "Update installs the newest SpecWithCode release on ministorm and relaunches the app there. " +
        "Threads running there stop for the restart. " +
        "Nothing else on ministorm changes: no settings, no other software.",
    );
  });

  it("says the server instead of a machine name when there is one server", () => {
    expect(describeServerUpdate({ ...ministorm, machine: null })).toBe(
      "SpecWithCode on the server runs 1.0.65; this app runs 1.0.66. " +
        "Update installs 1.0.66 on the server and restarts its server. " +
        "Threads running there stop for the restart. " +
        "Nothing else on the server changes: no settings, no other software.",
    );
    expect(
      describeServerUpdate({ ...ministorm, machine: null, selfUpdate: "desktop-managed" }),
    ).toBe(
      "SpecWithCode on the server runs 1.0.65; this app runs 1.0.66. " +
        "Update installs the newest SpecWithCode release on the server and relaunches the app there. " +
        "Threads running there stop for the restart. " +
        "Nothing else on the server changes: no settings, no other software.",
    );
  });

  it.each(["boot-service", "respawn", "desktop-managed"] as const)(
    "says threads continue on a %s server that continues them and has the setting on",
    (selfUpdate) => {
      const description = describeServerUpdate({
        ...ministorm,
        selfUpdate,
        threadContinuation: true,
        continueThreadsAfterServerUpdate: true,
      });

      expect(description).toContain(" Threads running there continue after the restart. ");
      expect(description).not.toContain("stop for the restart");
    },
  );

  it.each([
    { threadContinuation: true, continueThreadsAfterServerUpdate: false },
    { threadContinuation: false, continueThreadsAfterServerUpdate: true },
  ])(
    "says threads stop when continuation is $threadContinuation and the setting is $continueThreadsAfterServerUpdate",
    (continuation) => {
      const description = describeServerUpdate({ ...ministorm, ...continuation });

      expect(description).toContain(" Threads running there stop for the restart. ");
      expect(description).not.toContain("continue after the restart");
    },
  );
});
