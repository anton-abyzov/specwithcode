import { describe, expect, it } from "vite-plus/test";
import { machineReach, machineRowState, type MachineRowRole } from "./machineRowState";

const row = (role: MachineRowRole, extra: Partial<Parameters<typeof machineRowState>[0]> = {}) =>
  machineRowState({ machine: "m5", role, reach: "open", ...extra });

describe("machineRowState", () => {
  it("greys a machine this window never opened or that refuses it, with the one step on the row", () => {
    for (const reach of ["never-opened", "refused"] as const)
      expect(row("main", { reach, keptConversation: true })).toEqual({
        kind: "cannot-open",
        pressable: false,
        label: { text: "This window cannot open {machine}", values: { machine: "m5" } },
        action: "connect",
        notes: [],
      });
  });

  it("gives every other machine exactly one state, the first that matches", () => {
    expect(row("independent")).toMatchObject({
      kind: "separate",
      pressable: true,
      label: { text: "Separate project" },
      action: null,
    });
    expect(row("also-main")).toMatchObject({
      kind: "extra-coordinator",
      pressable: true,
      label: { text: "Extra coordinator" },
      action: "fix",
    });
    expect(row("moving")).toMatchObject({
      kind: "handing-off",
      label: { text: "Handing off the coordinator…" },
      action: null,
    });
    expect(row("main")).toMatchObject({
      kind: "coordinator",
      label: { text: "Coordinator" },
      action: null,
    });
  });

  it("shows no role word on a machine that only has the project", () => {
    for (const role of ["copy", "single"] as const)
      expect(row(role)).toEqual({
        kind: "plain",
        pressable: true,
        label: null,
        action: null,
        notes: [],
      });
  });

  it("keeps an offline machine pressable and keeps its state, with the note first", () => {
    expect(row("main", { reach: "offline", lastSeen: "2h ago" })).toEqual({
      kind: "coordinator",
      pressable: true,
      label: { text: "Coordinator" },
      action: null,
      notes: [{ text: "Offline · last seen {time}", values: { time: "2h ago" } }],
    });
    expect(row("copy", { reach: "offline" }).notes).toEqual([{ text: "Offline" }]);
  });

  it("orders the notes: offline, old conversation kept", () => {
    expect(
      row("copy", {
        reach: "offline",
        lastSeen: "5m ago",
        keptConversation: true,
      }).notes.map((note) => note.text),
    ).toEqual(["Offline · last seen {time}", "Old conversation kept"]);
  });

  it("never names a role on any row", () => {
    const roles: MachineRowRole[] = [
      "main",
      "also-main",
      "moving",
      "copy",
      "independent",
      "single",
    ];
    const reaches = ["open", "offline", "never-opened", "refused"] as const;
    for (const role of roles)
      for (const reach of reaches) {
        const state = row(role, { reach, keptConversation: true });
        const words = [state.label, ...state.notes].map((part) => part?.text ?? "").join(" ");
        expect(words).not.toMatch(/\bMain\b|\bmain\b|\bCopy\b|\bcopy\b/);
      }
  });
});

describe("machineReach", () => {
  it("reads the window's reach from the machine's connection", () => {
    expect(machineReach(null)).toBe("never-opened");
    expect(machineReach({ phase: "connected" })).toBe("open");
    expect(machineReach({ phase: "error" })).toBe("refused");
    expect(machineReach({ phase: "unsupported" })).toBe("refused");
    expect(machineReach({ phase: "connecting" })).toBe("offline");
    expect(machineReach({ phase: "disconnected" })).toBe("offline");
  });
});
