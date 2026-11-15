import { describe, expect, it } from "vite-plus/test";

import { machineActivity, overviewMachineState } from "./overviewMachines";

describe("overviewMachineState", () => {
  it("says a connected, current machine is online", () => {
    expect(overviewMachineState({ reach: "connected", reported: true, stale: false })).toEqual({
      state: "Online",
      tone: "moss",
      word: "online",
      counted: true,
    });
  });

  it("says a connected machine still reading its chats is catching up", () => {
    for (const reach of ["connected", "catching-up"] as const)
      expect(overviewMachineState({ reach, reported: true, stale: true }).state).toBe(
        "Catching up",
      );
  });

  it("reads a machine that just dropped as reconnecting, not offline", () => {
    expect(overviewMachineState({ reach: "reconnecting", reported: true, stale: true })).toEqual({
      state: "Reconnecting",
      tone: "amber",
      word: "reconnecting",
      counted: true,
    });
  });

  it("says why a machine is down in the words every other surface uses", () => {
    const state = (reach: "not-answering" | "offline" | "cant-reach" | "no-network") =>
      overviewMachineState({ reach, reported: false, stale: true });
    // Was "Reconnecting · 0 projects", then "Can’t reach it · retrying".
    expect(state("not-answering")).toEqual({
      state: "Not answering",
      tone: "amber",
      word: "not answering",
      counted: false,
    });
    expect(state("offline").state).toBe("Offline");
    expect(state("cant-reach").state).toBe("Can't reach");
    expect(state("no-network").state).toBe("No network");
  });

  it("keeps counting a machine that dropped after it reported", () => {
    expect(
      overviewMachineState({ reach: "not-answering", reported: true, stale: true }).counted,
    ).toBe(true);
  });

  it("names a stopped or refused connection", () => {
    expect(overviewMachineState({ reach: "stopped", reported: false, stale: true })).toMatchObject({
      state: "Connection failed",
      tone: "red",
      word: "unable to connect",
    });
    expect(
      overviewMachineState({ reach: "not-connected", reported: false, stale: true }).state,
    ).toBe("Not connected");
  });
});

describe("machineActivity", () => {
  it("never reports zero projects for a machine that did not answer", () => {
    expect(machineActivity({ counted: false, working: 0, projects: 0 })).toEqual([
      { text: "Chats and projects not counted" },
    ]);
  });

  it("says what runs and how many projects", () => {
    expect(machineActivity({ counted: true, working: 12, projects: 8 })).toEqual([
      { text: "{count} working", values: { count: 12 } },
      { text: "{count} projects", values: { count: 8 } },
    ]);
    expect(machineActivity({ counted: true, working: 0, projects: 1 })).toEqual([
      { text: "Nothing running" },
      { text: "{count} project", values: { count: 1 } },
    ]);
  });
});
