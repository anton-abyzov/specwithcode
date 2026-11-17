import { describe, expect, it } from "vite-plus/test";
import {
  existingCopyLine,
  machineHoldings,
  otherProjectNote,
  otherProjectOf,
  pickedHolding,
  sendHeader,
  sendPlan,
} from "./sendToMachine";

const identity = { canonicalKey: "github.com/anton/specweave", rootPath: "/Users/anton/specweave" };
const project = (
  environmentId: string,
  id: string,
  over: { root?: string; logical?: string; state?: string; epoch?: number } = {},
) => ({
  environmentId,
  id,
  workspaceRoot: over.root ?? "/Users/anton/specweave",
  repositoryIdentity: { ...identity, rootPath: over.root ?? identity.rootPath } as never,
  workspaceSettings: over.logical
    ? {
        logicalProject: { id: over.logical } as never,
        coordinatorBinding: { state: over.state ?? "active", epoch: over.epoch ?? 0 } as never,
      }
    : null,
});

describe("machineHoldings", () => {
  it("tells Main, a copy, several copies and no copy apart", () => {
    const source = project("m5", "p5", { logical: "L", state: "transferred", epoch: 1 });
    const projects = [
      source,
      project("m4", "p4", { logical: "L", state: "active", epoch: 2 }),
      project("m1", "p1", { root: "/Users/anton/Projects/specweave" }),
      project("mini", "a", { root: "/home/anton/a" }),
      project("mini", "b", { root: "/home/anton/b" }),
    ];
    const { byMachine: holdings, mainEnvironmentId } = machineHoldings({
      source,
      machineIds: ["m4", "m1", "mini", "m3"],
      projects,
    });
    expect(mainEnvironmentId).toBe("m4");
    expect(holdings.get("m4")?.kind).toBe("main");
    expect(holdings.get("m1")?.kind).toBe("copy");
    expect(holdings.get("mini")?.kind).toBe("several");
    expect(holdings.get("m3")?.kind).toBe("none");
  });

  it("calls a linked copy that is not Main a copy", () => {
    const source = project("m4", "p4", { logical: "L", state: "active", epoch: 2 });
    const { byMachine: holdings } = machineHoldings({
      source,
      machineIds: ["m5"],
      projects: [source, project("m5", "p5", { logical: "L", state: "transferred", epoch: 1 })],
    });
    expect(holdings.get("m5")?.kind).toBe("copy");
  });
});

describe("roles among several copies and retired records", () => {
  it("keeps which of several copies is Main, and names Main's machine regardless", () => {
    const source = project("m5", "p5", { logical: "L", state: "transferred", epoch: 1 });
    const main = project("m1", "a", { logical: "L", state: "active", epoch: 2 });
    const other = project("m1", "b", { logical: "L", state: "transferred", epoch: 0 });
    const { byMachine, mainEnvironmentId } = machineHoldings({
      source,
      machineIds: ["m1"],
      projects: [source, main, other],
    });
    const holding = byMachine.get("m1")!;
    expect(holding).toMatchObject({ kind: "several", mainId: "a" });
    expect(mainEnvironmentId).toBe("m1");
    expect(pickedHolding(holding, "a")).toEqual({ kind: "main", copy: main });
    expect(pickedHolding(holding, "b")).toEqual({ kind: "copy", copy: other });
    expect(pickedHolding(holding, null)).toBe(holding);
  });

  it("never lets a re-joined machine's old record be Main", () => {
    const source = project("m5", "p5", { logical: "L", state: "active", epoch: 3 });
    const old = project("old-m1", "x", { logical: "L", state: "active", epoch: 9 });
    const projects = [source, old];
    expect(machineHoldings({ source, machineIds: ["old-m1"], projects }).mainEnvironmentId).toBe(
      "old-m1",
    );
    const fixed = machineHoldings({
      source,
      machineIds: ["old-m1"],
      projects,
      retired: new Set(["old-m1"]),
    });
    expect(fixed.mainEnvironmentId).toBe("m5");
    expect(fixed.byMachine.get("old-m1")?.kind).toBe("copy");
  });
});

describe("a source that is not linked to the destination's project", () => {
  // Anton, November 16: specweave is m4 (Main), linux-mini and M5; m1 is a separate copy.
  const m4 = project("m4", "p4", { logical: "L", state: "active", epoch: 0 });
  const mini = project("mini", "pm", { logical: "L", state: "transferred", epoch: 0 });
  const m5 = project("m5", "p5", { logical: "L", state: "transferred", epoch: 0 });
  const m1 = project("m1", "p1");

  it("finds the destination project's own Main, never the source", () => {
    expect(otherProjectOf({ source: m1, copy: m5, projects: [m1, m4, mini, m5] })).toEqual({
      mainEnvironmentId: "m4",
    });
    // A source linked to another project is just as unlinked from this one.
    const elsewhere = project("m1", "p1", { logical: "K" });
    expect(otherProjectOf({ source: elsewhere, copy: m5, projects: [elsewhere, m4, m5] })).toEqual({
      mainEnvironmentId: "m4",
    });
  });

  it("names Main from the copy's own successor when Main is not loaded here", () => {
    const lone = {
      ...m5,
      workspaceSettings: {
        logicalProject: { id: "L" } as never,
        coordinatorBinding: {
          state: "transferred",
          epoch: 0,
          successor: { environmentId: "m4", projectId: "p4" },
        } as never,
      },
    };
    expect(otherProjectOf({ source: m1, copy: lone, projects: [m1, lone] })).toEqual({
      mainEnvironmentId: "m4",
    });
  });

  it("is nothing for a copy of the source's own project, an unlinked copy or no copy", () => {
    expect(otherProjectOf({ source: m4, copy: m5, projects: [m4, m5] })).toBeNull();
    expect(otherProjectOf({ source: m4, copy: m1, projects: [m4, m1] })).toBeNull();
    expect(otherProjectOf({ source: m4, copy: null, projects: [m4] })).toBeNull();
  });

  it("names the source's own Main: itself when registered on its own, else by role", () => {
    const own = machineHoldings({ source: m1, machineIds: ["m5"], projects: [m1, m5] });
    expect(own.mainEnvironmentId).toBe("m1");
    expect(own.byMachine.get("m5")?.kind).toBe("copy");
    const linked = machineHoldings({ source: mini, machineIds: ["m5"], projects: [mini, m5] });
    // Main (m4) is not in sight and no successor names it: unknown, not the source.
    expect(linked.mainEnvironmentId).toBeNull();
  });
});

describe("the dialog's words", () => {
  const copy = { kind: "copy", copy: { workspaceRoot: "/Users/anton/specweave" } } as const;
  const main = { kind: "main", copy: copy.copy } as const;

  const say = (words: { text: string; values?: Readonly<Record<string, string>> }) =>
    words.text.replace(/\{(\w+)\}/g, (slot, name: string) => words.values?.[name] ?? slot);

  it("names the real Main under the title, and where it goes on a move", () => {
    const base = { source: "linux-mini", there: "M5", main: "m4" };
    expect(say(sendHeader({ ...base, move: false }))).toBe("From linux-mini. Main stays on m4.");
    expect(say(sendHeader({ ...base, move: true }))).toBe("From linux-mini. Main moves to M5.");
    expect(say(sendHeader({ ...base, move: true, there: null }))).toBe(
      "From linux-mini. Main moves to the machine you choose.",
    );
    // Nothing in sight names Main: never guessed as the source.
    expect(say(sendHeader({ ...base, move: false, main: null }))).toBe(
      "From linux-mini. Main stays where it is.",
    );
  });

  it("says plainly when the source is not linked to the destination's project", () => {
    const base = { source: "m1", there: "M5", main: "m1", move: false };
    expect(say(sendHeader({ ...base, otherProject: { main: "m4" } }))).toBe(
      "From m1. m1's copy is not linked to the project M5 belongs to (Main: m4).",
    );
    expect(say(sendHeader({ ...base, otherProject: { main: null } }))).toBe(
      "From m1. m1's copy is not linked to the project M5 belongs to.",
    );
    expect(say(otherProjectNote({ source: "m1", there: "M5", main: "m4" }))).toBe(
      "Only files are copied into M5's copy. Main stays on m4, and m1 is not linked to that project. To make them one project, link m1 to it from the machine menu.",
    );
    expect(say(otherProjectNote({ source: "m1", there: "M5", main: null }))).toContain(
      "Its Main does not change",
    );
  });

  it("says once what the machine already has", () => {
    expect(existingCopyLine({ there: "m1", holding: copy })).toBe(
      "m1 already has a copy, at ~/specweave. Only what it is missing is copied.",
    );
    expect(existingCopyLine({ there: "m4", holding: main })).toBe(
      "m4 already has Main, at ~/specweave, so there is nothing to move.",
    );
    expect(
      existingCopyLine({
        there: "m1",
        holding: { kind: "several", copies: [copy.copy, copy.copy], mainId: null },
      }),
    ).toBe("m1 has 2 copies of this project. Pick the one to send to.");
    expect(existingCopyLine({ there: "m1", holding: { kind: "none" } })).toBeNull();
  });

  it("says exactly what each choice does before the click", () => {
    const base = { there: "m1", main: "m4", way: "copy", localFiles: 3 } as const;
    expect(sendPlan({ ...base, choice: "copy", holding: copy })).toBe(
      "Copy 3 changed local files into m1's copy at ~/specweave. Main stays on m4.",
    );
    expect(sendPlan({ ...base, choice: "move", holding: copy })).toBe(
      "Copy 3 changed local files into m1's copy at ~/specweave, then move Main there. Work continues on m1, and this copy stops starting work.",
    );
    expect(sendPlan({ ...base, choice: "copy", holding: copy, localFiles: 0 })).toBe(
      "Compare with m1's copy at ~/specweave and copy what it is missing. Main stays on m4.",
    );
    expect(sendPlan({ ...base, choice: "copy", holding: { kind: "none" } })).toBe(
      "Copy the folder to m1. Main stays on m4.",
    );
    expect(sendPlan({ ...base, choice: "move", holding: { kind: "none" } })).toBe(
      "Copy the folder to m1, then move Main there. Work continues on m1, and this copy stops starting work.",
    );
    // Git only always moves Main; uncommitted work stays.
    expect(sendPlan({ ...base, way: "git", choice: "move", holding: copy })).toBe(
      "Push this machine's commits, then move Main to m1's copy at ~/specweave. Work continues on m1, and this copy stops starting work. 3 uncommitted files stay here.",
    );
    // A machine holding Main is never moved to: the plan is a copy, and Main stays there.
    expect(sendPlan({ ...base, there: "m4", choice: "move", holding: main, localFiles: 0 })).toBe(
      "Compare with m4's copy at ~/specweave and copy what it is missing. Main stays on m4.",
    );
    // Main unknown here: the plan does not invent a machine.
    expect(sendPlan({ ...base, main: null, choice: "copy", holding: { kind: "none" } })).toBe(
      "Copy the folder to m1. Main stays where it is.",
    );
    // Several copies: no plan until one is picked.
    expect(
      sendPlan({
        ...base,
        choice: "copy",
        holding: { kind: "several", copies: [copy.copy], mainId: null },
      }),
    ).toBeNull();
  });
});
