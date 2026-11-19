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

const identity = { canonicalKey: "example.com/acme/specweave", rootPath: "/Users/sam/specweave" };
const project = (
  environmentId: string,
  id: string,
  over: { root?: string; logical?: string; state?: string; epoch?: number } = {},
) => ({
  environmentId,
  id,
  workspaceRoot: over.root ?? "/Users/sam/specweave",
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
    const source = project("rackF", "p5", { logical: "L", state: "transferred", epoch: 1 });
    const projects = [
      source,
      project("laptopE", "p4", { logical: "L", state: "active", epoch: 2 }),
      project("deskB", "p1", { root: "/Users/sam/Projects/specweave" }),
      project("shelfG", "a", { root: "/home/sam/a" }),
      project("shelfG", "b", { root: "/home/sam/b" }),
    ];
    const { byMachine: holdings, mainEnvironmentId } = machineHoldings({
      source,
      machineIds: ["laptopE", "deskB", "shelfG", "kioskD"],
      projects,
    });
    expect(mainEnvironmentId).toBe("laptopE");
    expect(holdings.get("laptopE")?.kind).toBe("main");
    expect(holdings.get("deskB")?.kind).toBe("copy");
    expect(holdings.get("shelfG")?.kind).toBe("several");
    expect(holdings.get("kioskD")?.kind).toBe("none");
  });

  it("calls a linked copy that is not Main a copy", () => {
    const source = project("laptopE", "p4", { logical: "L", state: "active", epoch: 2 });
    const { byMachine: holdings } = machineHoldings({
      source,
      machineIds: ["rackF"],
      projects: [source, project("rackF", "p5", { logical: "L", state: "transferred", epoch: 1 })],
    });
    expect(holdings.get("rackF")?.kind).toBe("copy");
  });
});

describe("roles among several copies and retired records", () => {
  it("keeps which of several copies is Main, and names Main's machine regardless", () => {
    const source = project("rackF", "p5", { logical: "L", state: "transferred", epoch: 1 });
    const main = project("deskB", "a", { logical: "L", state: "active", epoch: 2 });
    const other = project("deskB", "b", { logical: "L", state: "transferred", epoch: 0 });
    const { byMachine, mainEnvironmentId } = machineHoldings({
      source,
      machineIds: ["deskB"],
      projects: [source, main, other],
    });
    const holding = byMachine.get("deskB")!;
    expect(holding).toMatchObject({ kind: "several", mainId: "a" });
    expect(mainEnvironmentId).toBe("deskB");
    expect(pickedHolding(holding, "a")).toEqual({ kind: "main", copy: main });
    expect(pickedHolding(holding, "b")).toEqual({ kind: "copy", copy: other });
    expect(pickedHolding(holding, null)).toBe(holding);
  });

  it("never lets a re-joined machine's old record be Main", () => {
    const source = project("rackF", "p5", { logical: "L", state: "active", epoch: 3 });
    const old = project("old-deskB", "x", { logical: "L", state: "active", epoch: 9 });
    const projects = [source, old];
    expect(machineHoldings({ source, machineIds: ["old-deskB"], projects }).mainEnvironmentId).toBe(
      "old-deskB",
    );
    const fixed = machineHoldings({
      source,
      machineIds: ["old-deskB"],
      projects,
      retired: new Set(["old-deskB"]),
    });
    expect(fixed.mainEnvironmentId).toBe("rackF");
    expect(fixed.byMachine.get("old-deskB")?.kind).toBe("copy");
  });
});

describe("a source that is not linked to the destination's project", () => {
  // The case from November 16: specweave is laptopE (Main), box-a and Rack F; deskB is a separate copy.
  const laptopE = project("laptopE", "p4", { logical: "L", state: "active", epoch: 0 });
  const shelfG = project("shelfG", "pm", { logical: "L", state: "transferred", epoch: 0 });
  const rackF = project("rackF", "p5", { logical: "L", state: "transferred", epoch: 0 });
  const deskB = project("deskB", "p1");

  it("finds the destination project's own Main, never the source", () => {
    expect(otherProjectOf({ source: deskB, copy: rackF, projects: [deskB, laptopE, shelfG, rackF] })).toEqual({
      mainEnvironmentId: "laptopE",
    });
    // A source linked to another project is just as unlinked from this one.
    const elsewhere = project("deskB", "p1", { logical: "K" });
    expect(otherProjectOf({ source: elsewhere, copy: rackF, projects: [elsewhere, laptopE, rackF] })).toEqual({
      mainEnvironmentId: "laptopE",
    });
  });

  it("names Main from the copy's own successor when Main is not loaded here", () => {
    const lone = {
      ...rackF,
      workspaceSettings: {
        logicalProject: { id: "L" } as never,
        coordinatorBinding: {
          state: "transferred",
          epoch: 0,
          successor: { environmentId: "laptopE", projectId: "p4" },
        } as never,
      },
    };
    expect(otherProjectOf({ source: deskB, copy: lone, projects: [deskB, lone] })).toEqual({
      mainEnvironmentId: "laptopE",
    });
  });

  it("is nothing for a copy of the source's own project, an unlinked copy or no copy", () => {
    expect(otherProjectOf({ source: laptopE, copy: rackF, projects: [laptopE, rackF] })).toBeNull();
    expect(otherProjectOf({ source: laptopE, copy: deskB, projects: [laptopE, deskB] })).toBeNull();
    expect(otherProjectOf({ source: laptopE, copy: null, projects: [laptopE] })).toBeNull();
  });

  it("names the source's own Main: itself when registered on its own, else by role", () => {
    const own = machineHoldings({ source: deskB, machineIds: ["rackF"], projects: [deskB, rackF] });
    expect(own.mainEnvironmentId).toBe("deskB");
    expect(own.byMachine.get("rackF")?.kind).toBe("copy");
    const linked = machineHoldings({ source: shelfG, machineIds: ["rackF"], projects: [shelfG, rackF] });
    // Main (laptopE) is not in sight and no successor names it: unknown, not the source.
    expect(linked.mainEnvironmentId).toBeNull();
  });
});

describe("the dialog's words", () => {
  const copy = { kind: "copy", copy: { workspaceRoot: "/Users/sam/specweave" } } as const;
  const main = { kind: "main", copy: copy.copy } as const;

  const say = (words: { text: string; values?: Readonly<Record<string, string>> }) =>
    words.text.replace(/\{(\w+)\}/g, (slot, name: string) => words.values?.[name] ?? slot);

  it("names the real Main under the title, and where it goes on a move", () => {
    const base = { source: "box-a", there: "Rack F", main: "laptopE" };
    expect(say(sendHeader({ ...base, move: false }))).toBe(
      "From box-a. The coordinator stays on laptopE.",
    );
    expect(say(sendHeader({ ...base, move: true }))).toBe(
      "From box-a. The coordinator continues on Rack F.",
    );
    expect(say(sendHeader({ ...base, move: true, there: null }))).toBe(
      "From box-a. The coordinator continues on the machine you choose.",
    );
    // Nothing in sight names Main: never guessed as the source.
    expect(say(sendHeader({ ...base, move: false, main: null }))).toBe("From box-a.");
  });

  it("says plainly when the source is not linked to the destination's project", () => {
    const base = { source: "deskB", there: "Rack F", main: "deskB", move: false };
    expect(say(sendHeader({ ...base, otherProject: { main: "laptopE" } }))).toBe(
      "From deskB. Rack F has this repository as a separate project (coordinator on laptopE).",
    );
    expect(say(sendHeader({ ...base, otherProject: { main: null } }))).toBe(
      "From deskB. Rack F has this repository as a separate project.",
    );
    expect(say(otherProjectNote({ source: "deskB", there: "Rack F", main: "laptopE" }))).toBe(
      "Only files go into Rack F's folder. Its coordinator stays on laptopE. To make them one project, link deskB to it from the machine menu.",
    );
    expect(say(otherProjectNote({ source: "deskB", there: "Rack F", main: null }))).toContain(
      "Its coordinator does not change",
    );
  });

  it("says once what the machine already has", () => {
    const line = (input: Parameters<typeof existingCopyLine>[0]) => {
      const text = existingCopyLine(input);
      return text === null ? null : say(text);
    };
    expect(line({ there: "deskB", holding: copy })).toBe(
      "deskB already has this project, at ~/specweave. Sync brings it up to date.",
    );
    expect(line({ there: "laptopE", holding: main })).toBe(
      "laptopE already has the coordinator, at ~/specweave.",
    );
    expect(
      line({
        there: "deskB",
        holding: { kind: "several", copies: [copy.copy, copy.copy], mainId: null },
      }),
    ).toBe("deskB has this project in 2 folders. Pick one.");
    expect(line({ there: "deskB", holding: { kind: "none" } })).toBeNull();
  });

  it("says exactly what each choice does before the click", () => {
    const base = { there: "deskB", main: "laptopE", way: "copy", localFiles: 3 } as const;
    expect(sendPlan({ ...base, choice: "copy", holding: copy })).toBe(
      "Copy 3 changed local files into ~/specweave on deskB. The coordinator stays on laptopE.",
    );
    expect(sendPlan({ ...base, choice: "move", holding: copy })).toBe(
      "Copy 3 changed local files into ~/specweave on deskB, then continue the coordinator there. The coordinator continues on deskB.",
    );
    expect(sendPlan({ ...base, choice: "copy", holding: copy, localFiles: 0 })).toBe(
      "Compare with ~/specweave on deskB and copy what it is missing. The coordinator stays on laptopE.",
    );
    expect(sendPlan({ ...base, choice: "copy", holding: { kind: "none" } })).toBe(
      "Copy the folder to deskB. The coordinator stays on laptopE.",
    );
    expect(sendPlan({ ...base, choice: "move", holding: { kind: "none" } })).toBe(
      "Copy the folder to deskB, then continue the coordinator there. The coordinator continues on deskB.",
    );
    // Git only always moves Main; uncommitted work stays.
    expect(sendPlan({ ...base, way: "git", choice: "move", holding: copy })).toBe(
      "Push this machine's commits, then continue the coordinator in ~/specweave on deskB. The coordinator continues on deskB. 3 uncommitted files stay here.",
    );
    // A machine holding Main is never moved to: the plan is a copy, and Main stays there.
    expect(sendPlan({ ...base, there: "laptopE", choice: "move", holding: main, localFiles: 0 })).toBe(
      "Compare with ~/specweave on laptopE and copy what it is missing. The coordinator stays on laptopE.",
    );
    // Main unknown here: the plan does not invent a machine.
    expect(sendPlan({ ...base, main: null, choice: "copy", holding: { kind: "none" } })).toBe(
      "Copy the folder to deskB. The coordinator stays where it is.",
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
