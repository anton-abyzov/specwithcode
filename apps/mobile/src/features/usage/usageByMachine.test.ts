import { describe, expect, it } from "vite-plus/test";

import {
  type ByMachinePresentation,
  MACHINE_COLOR_HEX,
  askableMachines,
  byMachineInputs,
  machineIdentities,
} from "./usageByMachine";

function presentation(overrides: {
  label: string;
  phase?: string;
  canReport?: boolean;
  nicknames?: Record<string, { name: string; updatedAt: string; color?: string }>;
  providers?: unknown[];
}): ByMachinePresentation {
  return {
    entry: { target: { label: overrides.label } },
    connection: { phase: overrides.phase ?? "connected" },
    serverConfig: {
      providers: (overrides.providers ?? []) as never,
      environment: { capabilities: { usageMachineReport: overrides.canReport ?? true } },
      settings: { machineNicknames: (overrides.nicknames ?? {}) as never },
    },
  };
}

const claude = {
  driver: "claudeAgent",
  instanceId: "claude-main",
  auth: { status: "authenticated", email: "Alex.Rivers@example.com" },
};

describe("By machine on the phone", () => {
  const presentations = new Map<string, ByMachinePresentation>([
    [
      "desk",
      presentation({
        label: "desk.local",
        providers: [claude],
        nicknames: { desk: { name: "Desk", updatedAt: "2026-11-01", color: "rose" } },
      }),
    ],
    ["old", presentation({ label: "Old mini", canReport: false })],
    ["away", presentation({ label: "Away", phase: "offline" })],
  ]);
  const permitted = new Set(["desk", "old", "away"]);

  it("names machines by nickname and gives each the fleet's colour", () => {
    const identityOf = machineIdentities(presentations);
    expect(identityOf("desk")).toEqual({ name: "Desk", color: MACHINE_COLOR_HEX.rose });
    expect(identityOf("old").name).toBe("Old mini");
    expect(identityOf("old").color).not.toBe(identityOf("away").color);
    expect(Object.values(MACHINE_COLOR_HEX)).toContain(identityOf("away").color);
  });

  it("asks only machines that are reachable, allowed and new enough", () => {
    expect(askableMachines(presentations, null, permitted)).toEqual(["desk"]);
    expect(askableMachines(presentations, new Set(["old"]), permitted)).toEqual([]);
    expect(askableMachines(presentations, null, new Set())).toEqual([]);
  });

  it("says what each machine sent", () => {
    const report = {
      readAt: "2026-11-20T10:00:00.000Z",
      accounts: [],
      sources: [],
      projects: [],
      cells: [],
      hourly: [],
    } as never;
    const inputs = byMachineInputs({
      presentations,
      selected: null,
      permitted,
      answers: new Map([["desk", report]]),
      summaries: new Map(),
    });
    expect(inputs.map((input) => [input.machineId, input.state, input.note])).toEqual([
      ["away", "missing", "out of reach"],
      ["desk", "live", undefined],
      ["old", "missing", "needs an update to report"],
    ]);
    expect(inputs[1]!.heldAccountKeys).toEqual(["claudeAgent:alex.rivers@example.com"]);
    expect(inputs[1]!.name).toBe("Desk");
  });
});
