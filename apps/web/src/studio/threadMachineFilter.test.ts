import { describe, expect, it } from "vite-plus/test";

import {
  chatMachineNote,
  chatsShowMachineColumn,
  machineColumnCh,
  machineColumnLabel,
  machineFilterOptions,
  mergeMachineFilterOptions,
} from "./threadMachineFilter";

const thread = (machine: string, resolved = false) => ({
  machine,
  archivedAt: null,
  settledOverride: resolved ? "settled" : null,
});

describe("machine filter", () => {
  it("offers each machine with its open threads, busiest first", () => {
    const options = machineFilterOptions(
      [
        thread("m4"),
        thread("ministorm"),
        thread("m4"),
        thread("ministorm", true),
        thread("m1", true),
      ],
      (t) => ({ machineId: t.machine, label: t.machine }),
    );
    expect(options).toEqual([
      { machineId: "m4", label: "m4", count: 2 },
      { machineId: "ministorm", label: "ministorm", count: 1 },
      { machineId: "m1", label: "m1", count: 0 },
    ]);
  });

  it("sizes the column to the longest name within 4 to 10 characters", () => {
    expect(machineColumnCh(["m4"])).toBe(4);
    expect(machineColumnCh(["m4", "ministorm"])).toBe(9);
    expect(machineColumnCh(["a-very-long-machine-name"])).toBe(10);
  });

  it("names where a moved thread runs", () => {
    expect(machineColumnLabel({ label: "M4 → Minis", moved: true })).toBe("→ Minis");
    expect(machineColumnLabel({ label: "M4", moved: false })).toBe("M4");
  });

  it("merges remote worker machines into existing options, busiest first", () => {
    const base = machineFilterOptions([thread("m1"), thread("m1", true)], (t) => ({
      machineId: t.machine,
      label: t.machine,
    }));
    const merged = mergeMachineFilterOptions(base, [
      { machineId: "m4", label: "m4" },
      { machineId: "m4", label: "m4" },
      { machineId: "m1", label: "m1" },
    ]);
    expect(merged).toEqual([
      { machineId: "m1", label: "m1", count: 2 },
      { machineId: "m4", label: "m4", count: 2 },
    ]);
  });
});

describe("chatsShowMachineColumn", () => {
  const show = (machineIds: string[], anyMoved = false) =>
    chatsShowMachineColumn({ machineIds, primaryEnvironmentId: "m4", anyMoved });

  it("stays quiet while every chat runs on this machine", () => {
    expect(show(["m4"])).toBe(false);
    expect(show([])).toBe(false);
  });

  it("shows for several machines, another machine alone, or a moved chat", () => {
    expect(show(["m4", "m1"])).toBe(true);
    expect(show(["m1"])).toBe(true);
    expect(show(["m4"], true)).toBe(true);
  });
});

describe("chatMachineNote", () => {
  const running = { moved: false, state: "running", description: "Lives and runs on M4" };
  const note = (over: Partial<Parameters<typeof chatMachineNote>[0]>) =>
    chatMachineNote({
      location: running,
      offlineHost: null,
      runsElsewhere: false,
      executionName: "Minis",
      executionOffline: false,
      namedMachine: null,
      ...over,
    });
  const handedOff = {
    moved: true,
    state: "fenced",
    description: "Lives on M4 · handed off, Minis runs it now",
  };

  it("names the machine of a plain row, or stays quiet", () => {
    expect(note({ namedMachine: "M4" })).toBe("On M4");
    expect(note({})).toBeNull();
  });

  it("says when a handed-off chat's runner stops answering", () => {
    expect(note({ location: handedOff })).toBe(handedOff.description);
    expect(note({ location: handedOff, executionOffline: true })).toBe(
      `${handedOff.description} · Minis can't be reached`,
    );
  });

  it("does not repeat what an unknown runner's description already says", () => {
    const unknown = { moved: true, state: "unknown", description: "Lives on M4 · Minis is silent" };
    expect(note({ location: unknown, executionOffline: true })).toBe(unknown.description);
  });

  it("names one machine once when the host that serves the chat runs it", () => {
    expect(note({ location: handedOff, offlineHost: "Minis", executionOffline: true })).toBe(
      "Minis can't be reached",
    );
  });

  it("names both machines when the host and the runner differ", () => {
    expect(note({ offlineHost: "M3", runsElsewhere: true })).toBe(
      "M3 can't be reached · runs on Minis",
    );
    expect(note({ offlineHost: "M3", runsElsewhere: true, executionOffline: true })).toBe(
      "M3 can't be reached · Minis can't be reached",
    );
  });
});
