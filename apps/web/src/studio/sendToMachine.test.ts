import { describe, expect, it } from "vite-plus/test";
import {
  existingCopyLine,
  holdingLabel,
  machineHoldings,
  sendChoiceLabel,
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
    const holdings = machineHoldings({
      source,
      machineIds: ["m4", "m1", "mini", "m3"],
      projects,
    });
    expect(holdings.get("m4")?.kind).toBe("main");
    expect(holdings.get("m1")?.kind).toBe("copy");
    expect(holdings.get("mini")?.kind).toBe("several");
    expect(holdings.get("m3")?.kind).toBe("none");
    expect(["m4", "m1", "mini", "m3"].map((id) => holdingLabel(holdings.get(id)))).toEqual([
      "Has Main",
      "Has a copy",
      "Has 2 copies",
      "No copy",
    ]);
  });

  it("calls a linked copy that is not Main a copy", () => {
    const source = project("m4", "p4", { logical: "L", state: "active", epoch: 2 });
    const holdings = machineHoldings({
      source,
      machineIds: ["m5"],
      projects: [source, project("m5", "p5", { logical: "L", state: "transferred", epoch: 1 })],
    });
    expect(holdings.get("m5")?.kind).toBe("copy");
  });
});

describe("the dialog's words", () => {
  it("offers Copy first, in the owner's words", () => {
    expect(sendChoiceLabel("copy", "m1")).toBe("Copy to m1. Keep working here.");
    expect(sendChoiceLabel("move", "m1")).toBe(
      "Move to m1. Work continues there, and this copy stops starting work.",
    );
  });

  it("says once what the machine already has", () => {
    const copy = { kind: "copy", copy: { workspaceRoot: "/Users/anton/specweave" } } as const;
    expect(existingCopyLine({ there: "m1", holding: copy, updatesCommits: true })).toBe(
      "m1 already has a copy. It will be updated to this machine's commits.",
    );
    expect(existingCopyLine({ there: "m1", holding: copy, updatesCommits: false })).toBe(
      "m1 already has a copy, at ~/specweave.",
    );
    expect(
      existingCopyLine({
        there: "m4",
        holding: { kind: "main", copy: copy.copy },
        updatesCommits: false,
      }),
    ).toBe("m4 already has Main, at ~/specweave, so there is nothing to move.");
    expect(
      existingCopyLine({ there: "m1", holding: { kind: "none" }, updatesCommits: false }),
    ).toBeNull();
  });

  it("says exactly what each choice does before the click", () => {
    const base = {
      there: "m1",
      main: "m4",
      way: "clone",
      localFiles: 3,
      updatesCommits: false,
    } as const;
    expect(
      sendPlan({ ...base, choice: "copy", holding: "copy", folder: "/Users/anton/specweave" }),
    ).toBe(
      "Copy 3 changed local files into m1's copy at ~/specweave. Its commits update from Git when work starts there. Main stays on m4.",
    );
    expect(
      sendPlan({
        ...base,
        choice: "copy",
        holding: "copy",
        folder: "/Users/anton/specweave",
        updatesCommits: true,
      }),
    ).toBe(
      "Update m1's copy at ~/specweave to this machine's commits, then copy 3 changed local files. Main stays on m4.",
    );
    expect(
      sendPlan({ ...base, choice: "move", holding: "copy", folder: "/Users/anton/specweave" }),
    ).toBe(
      "Push this machine's commits, then move Main to m1's copy at ~/specweave. Work continues on m1, and this copy stops starting work. 3 uncommitted files stay here.",
    );
    expect(
      sendPlan({ ...base, choice: "copy", holding: "none", folder: "/Users/anton/Projects/sw" }),
    ).toBe("Clone into ~/Projects/sw on m1. Main stays on m4.");
    expect(
      sendPlan({ ...base, choice: "move", holding: "none", folder: "/Users/anton/Projects/sw" }),
    ).toBe(
      "Clone into ~/Projects/sw on m1, then move Main there. Work continues on m1, and this copy stops starting work.",
    );
    expect(sendPlan({ ...base, choice: "copy", holding: "none", folder: null, way: "copy" })).toBe(
      "Copy the folder to m1. You review the files first. Main stays on m4.",
    );
    // A machine holding Main is never moved to; the plan is a copy, and Main stays there.
    expect(
      sendPlan({
        ...base,
        there: "m4",
        choice: "move",
        holding: "main",
        folder: "/Users/anton/specweave",
        localFiles: 0,
      }),
    ).toBe(
      "Compare with m4's copy at ~/specweave and copy what it is missing. Its commits update from Git when work starts there. Main stays on m4.",
    );
  });
});
