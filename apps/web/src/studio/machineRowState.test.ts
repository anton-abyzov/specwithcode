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
  it("marks the window's own machine as this window, and no other (1427 AC-05)", () => {
    expect(row("linked", { window: true }).window).toBe(true);
    expect(row("independent", { window: true }).window).toBe(true);
    expect(row("linked").window).toBeUndefined();
    // A machine this window cannot open is never the window's own.
    expect(row("linked", { window: true, reach: "never-opened" }).window).toBeUndefined();
  });

  it("greys a machine this window never opened or that refuses it, with the one step on the row", () => {
    for (const reach of ["never-opened", "refused"] as const)
      expect(row("linked", { reach })).toEqual({
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
  });

  it("gives every linked machine the same plain row: equals, with no role and no step (AC-01)", () => {
    for (const role of ["linked", "single"] as const)
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
    expect(row("linked", { reach: "offline", lastSeen: "2h ago" })).toEqual({
      kind: "plain",
      pressable: true,
      label: null,
      action: null,
      notes: [{ text: "Offline · last seen {time}", values: { time: "2h ago" } }],
      sync: null,
    });
    expect(row("linked", { reach: "offline" }).notes).toEqual([{ text: "Offline" }]);
  });

  it("carries the sync fact it is given, and none on a machine it cannot open", () => {
    const sync = { tone: "same", text: "Same as {shown}", values: { shown: "Laptop E" } } as const;
    expect(row("linked", { sync }).sync).toEqual(sync);
    expect(row("linked", { sync }).sync).toEqual(sync);
    expect(row("linked", { sync, reach: "never-opened" }).sync).toBeNull();
  });

  it("notes a machine whose app is from before Sync, with its version when known", () => {
    expect(row("linked", { needsUpdate: { version: "1.0.360" } }).notes).toEqual([
      { text: "Needs update · {version}", values: { version: "1.0.360" } },
    ]);
    expect(row("linked", { needsUpdate: { version: null } }).notes).toEqual([
      { text: "Needs update" },
    ]);
    expect(
      row("linked", {
        reach: "offline",
        needsUpdate: { version: "1.0.360" },
      }).notes.map((note) => note.text),
    ).toEqual(["Offline", "Needs update · {version}"]);
  });

  it("never names a role on any row", () => {
    const roles: MachineRowRole[] = ["linked", "independent", "single"];
    const reaches = ["open", "offline", "never-opened", "refused"] as const;
    for (const role of roles)
      for (const reach of reaches) {
        const state = row(role, { reach });
        const words = [state.label, ...state.notes].map((part) => part?.text ?? "").join(" ");
        expect(words).not.toMatch(/\bMain\b|\bmain\b|\bCopy\b|\bcopy\b|[Cc]oordinator|Handing off/);
        expect(state.action === null || state.action === "connect").toBe(true);
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

  it("says the comparison could not be read when a machine could not read a repository", () => {
    const unread: MachineSyncStatus = {
      repositories: [{ path: ".", head: null, clean: false, unread: true }],
      scanLimited: false,
    };
    const readable = status([[".", A]]);
    for (const [shown, other] of [
      [readable, unread],
      [unread, readable],
    ] as const)
      expect(fact(shown, other)).toEqual({
        tone: "unknown",
        text: "Could not compare: a repository could not be read",
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
