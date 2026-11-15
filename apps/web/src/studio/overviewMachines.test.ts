import { describe, expect, it } from "vite-plus/test";

import { machineActivity, machineReach } from "./overviewMachines";

describe("machineReach", () => {
  it("says a connected, current machine is online", () => {
    expect(machineReach({ phase: "connected", reported: true, stale: false })).toEqual({
      state: "Online",
      tone: "moss",
      word: "online",
      counted: true,
    });
  });

  it("says a connected machine still reading its chats is catching up", () => {
    expect(machineReach({ phase: "connected", reported: true, stale: true }).state).toBe(
      "Catching up",
    );
  });

  it("explains a machine that keeps retrying and never answered", () => {
    // Was "Reconnecting · 0 projects".
    expect(machineReach({ phase: "reconnecting", reported: false, stale: true })).toEqual({
      state: "Can’t reach it · retrying",
      tone: "amber",
      word: "not reachable",
      counted: false,
    });
  });

  it("keeps counting a machine that dropped after it reported", () => {
    expect(machineReach({ phase: "reconnecting", reported: true, stale: true }).counted).toBe(true);
  });

  it("names a stopped or refused connection", () => {
    expect(machineReach({ phase: "error", reported: false, stale: true })).toMatchObject({
      state: "Can’t connect",
      tone: "red",
    });
    expect(machineReach({ phase: "offline", reported: false, stale: true }).state).toBe("Offline");
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
