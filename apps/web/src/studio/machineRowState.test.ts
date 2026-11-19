import { describe, expect, it } from "vite-plus/test";
import {
  machineReach,
  machineRowState,
  machineSyncFact,
  type MachineRowRole,
  type MachineSyncStatus,
} from "./machineRowState";

const row = (role: MachineRowRole, extra: Partial<Parameters<typeof machineRowState>[0]> = {}) =>
  machineRowState({ machine: "rackF", role, reach: "open", ...extra });

describe("machineRowState", () => {
  it("greys a machine this window never opened or that refuses it, with the one step on the row", () => {
    for (const reach of ["never-opened", "refused"] as const)
      expect(row("main", { reach, keptConversation: true })).toEqual({
        kind: "cannot-open",
        pressable: false,
        label: { text: "This window cannot open {machine}", values: { machine: "rackF" } },
        action: "connect",
        notes: [],
        sync: null,
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
        sync: null,
      });
  });

  it("keeps an offline machine pressable and keeps its state, with the note first", () => {
    expect(row("main", { reach: "offline", lastSeen: "2h ago" })).toEqual({
      kind: "coordinator",
      pressable: true,
      label: { text: "Coordinator" },
      action: null,
      notes: [{ text: "Offline · last seen {time}", values: { time: "2h ago" } }],
      sync: null,
    });
    expect(row("copy", { reach: "offline" }).notes).toEqual([{ text: "Offline" }]);
  });

  it("carries the sync fact it is given, and none on a machine it cannot open", () => {
    const sync = { tone: "same", text: "Same as {shown}", values: { shown: "Laptop E" } } as const;
    expect(row("copy", { sync }).sync).toEqual(sync);
    expect(row("main", { sync }).sync).toEqual(sync);
    expect(row("copy", { sync, reach: "never-opened" }).sync).toBeNull();
  });

  it("notes a machine whose app is from before Sync, with its version when known", () => {
    expect(row("copy", { needsUpdate: { version: "1.0.360" } }).notes).toEqual([
      { text: "Needs update · {version}", values: { version: "1.0.360" } },
    ]);
    expect(row("copy", { needsUpdate: { version: null } }).notes).toEqual([
      { text: "Needs update" },
    ]);
    expect(
      row("copy", {
        reach: "offline",
        needsUpdate: { version: "1.0.360" },
        keptConversation: true,
      }).notes.map((note) => note.text),
    ).toEqual(["Offline", "Needs update · {version}", "Old conversation kept"]);
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

describe("machineSyncFact", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const status = (
    repositories: Array<[path: string, head: string | null, clean?: boolean]>,
    scanLimited = false,
  ): MachineSyncStatus => ({
    repositories: repositories.map(([path, head, clean = true]) => ({ path, head, clean })),
    scanLimited,
  });
  const fact = (
    shown: MachineSyncStatus | null,
    other: MachineSyncStatus | null,
    asOf: string | null = null,
  ) => machineSyncFact({ shown, other, shownName: "Rack F", asOf });

  it("is Same only when every repository is at the same commit and both trees are clean", () => {
    const both = status([
      [".", A],
      ["apps/site", B],
    ]);
    expect(fact(both, both)).toEqual({
      tone: "same",
      text: "Same as {shown}",
      values: { shown: "Rack F" },
    });
  });

  it("counts a repository that differs: another commit, uncommitted work, or only on one machine", () => {
    const shown = status([
      [".", A],
      ["apps/site", A],
      ["apps/docs", A],
      ["apps/api", A],
    ]);
    const other = status([
      [".", B],
      ["apps/site", A, false],
      ["apps/docs", A],
      ["apps/status", A],
    ]);
    // ".", apps/site, apps/api (only shown) and apps/status (only there): 4 of 5.
    expect(fact(shown, other)).toEqual({
      tone: "differs",
      text: "{k} of {n} repositories differ",
      values: { k: "4", n: "5" },
    });
    // The machine shown having uncommitted work counts too.
    expect(fact(status([[".", A, false]]), status([[".", A]])).values).toEqual({ k: "1", n: "1" });
  });

  it("is Not checked yet without a status for both machines, never a guess", () => {
    const one = status([[".", A]]);
    expect(fact(null, one)).toEqual({ tone: "unknown", text: "Not checked yet" });
    expect(fact(one, null)).toEqual({ tone: "unknown", text: "Not checked yet" });
    expect(fact(null, null)).toEqual({ tone: "unknown", text: "Not checked yet" });
  });

  it("never says Same for a folder that could not be scanned in full, or for a commit it cannot read", () => {
    const one = status([[".", A]]);
    expect(fact(one, status([[".", A]], true)).tone).toBe("unknown");
    expect(fact(status([[".", A]], true), one).tone).toBe("unknown");
    expect(fact(status([[".", null]]), status([[".", null]])).tone).toBe("differs");
    expect(fact(status([]), status([])).tone).toBe("unknown");
    // What a limited scan does list still counts when it differs.
    expect(fact(one, status([[".", B]], true)).tone).toBe("differs");
  });

  it("adds the time of the last status for an offline machine", () => {
    const one = status([[".", A]]);
    expect(fact(one, one, "14:02")).toEqual({
      tone: "same",
      text: "Same as {shown} · as of {time}",
      values: { shown: "Rack F", time: "14:02" },
    });
    expect(fact(one, status([[".", B]]), "14:02")).toEqual({
      tone: "differs",
      text: "{k} of {n} repositories differ · as of {time}",
      values: { k: "1", n: "1", time: "14:02" },
    });
  });
});
