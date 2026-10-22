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
  it("names the machine and both versions, with 'to' for screen readers", () => {
    expect(serverUpdateRowText(ministorm)).toEqual({
      name: "ministorm",
      serverVersion: "1.0.65",
      clientVersion: "1.0.66",
      label: "ministorm 1.0.65 to 1.0.66",
    });
  });

  it("calls the only server Server", () => {
    expect(serverUpdateRowText({ ...ministorm, machine: null })).toEqual({
      name: "Server",
      serverVersion: "1.0.65",
      clientVersion: "1.0.66",
      label: "Server 1.0.65 to 1.0.66",
    });
  });

  it("keeps prerelease versions whole in the label", () => {
    expect(
      serverUpdateRowText({ ...ministorm, clientVersion: "1.0.67-nightly.20261021.882" }).label,
    ).toBe("ministorm 1.0.65 to 1.0.67-nightly.20261021.882");
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
        "Threads running there stop for the relaunch. " +
        "Nothing else on ministorm changes: no settings, no other software.",
    );
  });

  it("says the server instead of a machine name when there is one server", () => {
    expect(describeServerUpdate({ ...ministorm, machine: null })).toBe(
      "SpecWithCode on the server runs 1.0.65; this app runs 1.0.66. " +
        "Update installs 1.0.66 on the server and restarts it. " +
        "Threads running there stop for the restart. " +
        "Nothing else on the server changes: no settings, no other software.",
    );
    expect(
      describeServerUpdate({ ...ministorm, machine: null, selfUpdate: "desktop-managed" }),
    ).toBe(
      "SpecWithCode on the server runs 1.0.65; this app runs 1.0.66. " +
        "Update installs the newest SpecWithCode release on the server and relaunches the app there. " +
        "Threads running there stop for the relaunch. " +
        "Nothing else on the server changes: no settings, no other software.",
    );
  });

  it.each([
    { selfUpdate: "boot-service", pause: "restart" },
    { selfUpdate: "respawn", pause: "restart" },
    { selfUpdate: "desktop-managed", pause: "relaunch" },
  ] as const)(
    "says threads continue after the $pause on a $selfUpdate server that continues them and has the setting on",
    ({ selfUpdate, pause }) => {
      const description = describeServerUpdate({
        ...ministorm,
        selfUpdate,
        threadContinuation: true,
        continueThreadsAfterServerUpdate: true,
      });

      expect(description).toContain(` Threads running there continue after the ${pause}. `);
      expect(description).not.toContain("stop for the");
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
      expect(description).not.toContain("continue after the");
    },
  );

  it.each([
    { threadContinuation: false, continueThreadsAfterServerUpdate: false },
    { threadContinuation: true, continueThreadsAfterServerUpdate: false },
    { threadContinuation: false, continueThreadsAfterServerUpdate: true },
    { threadContinuation: true, continueThreadsAfterServerUpdate: true },
  ])(
    "talks about the relaunch, never a restart, for a desktop-managed server (continuation $threadContinuation, setting $continueThreadsAfterServerUpdate)",
    (continuation) => {
      for (const machine of ["ministorm", null]) {
        const description = describeServerUpdate({
          ...ministorm,
          ...continuation,
          machine,
          selfUpdate: "desktop-managed",
        });

        expect(description).toMatch(
          / Threads running there (stop for|continue after) the relaunch\. /,
        );
        expect(description).not.toContain("restart");
      }
    },
  );
});
