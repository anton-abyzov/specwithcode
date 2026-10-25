import type {
  DesignReuse,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SYSTEM_FOUND,
  SYSTEM_NONE,
  editorSystemChoices,
  editorSystemSource,
  importedReuseSystem,
  systemChangeOperations,
} from "./editorSystem";

const ec = { kind: "project", projectId: "p_ec" as ProjectId } as const;
const plain = { kind: "project", projectId: "p_plain" as ProjectId } as const;

const reuse: DesignReuse = {
  name: "ec-uikit",
  paths: ["src/styles/entry.css"],
  tokens: 283,
  components: 321,
  modes: ["light", "dark"],
  proposalId: "prop_1",
  foundAt: "2026-10-24T12:00:00.000Z",
};

function summary(
  systemId: string,
  name: string,
  owner: { kind: "project"; projectId: ProjectId },
): DesignSystemSummary {
  return {
    ref: { owner, systemId: systemId as DesignSystemId },
    name,
    ownerLabel: owner.projectId,
    tokenCount: 3,
    componentCount: 0,
    sources: [],
  } as unknown as DesignSystemSummary;
}

describe("editorSystemSource", () => {
  it("uses the design's own system first", () => {
    expect(editorSystemSource({ designSystem: "s_a" as DesignSystemId, reuse }, ec, [])).toEqual({
      kind: "design",
      systemId: "s_a",
    });
  });

  it("follows the found system's import proposal while nothing is imported", () => {
    expect(editorSystemSource({ designSystem: null, reuse }, ec, [])).toEqual({
      kind: "proposal",
      proposalId: "prop_1",
    });
  });

  it("follows the owner's imported copy of the found system once there is one", () => {
    const systems = [summary("s_other", "ec-uikit", plain), summary("s_ec", "EC-UIKIT", ec)];
    expect(editorSystemSource({ designSystem: null, reuse }, ec, systems)).toEqual({
      kind: "imported",
      systemId: "s_ec",
    });
    // Another owner's system of the same name is never followed.
    expect(importedReuseSystem(reuse, ec, [systems[0]!])).toBeNull();
  });

  it("says so when the proposal is gone and nothing was imported", () => {
    const { proposalId: _gone, ...noProposal } = reuse;
    expect(editorSystemSource({ designSystem: null, reuse: noProposal }, ec, [])).toEqual({
      kind: "found-unavailable",
    });
  });

  it("has no system for a design without one", () => {
    expect(editorSystemSource({ designSystem: null }, ec, [])).toEqual({ kind: "none" });
  });
});

describe("editorSystemChoices", () => {
  it("names the found system in the header instead of None", () => {
    const choices = editorSystemChoices({
      owner: ec,
      systems: [],
      value: null,
      reuse,
      canCopy: true,
    });
    expect(choices.label).toBe("ec-uikit");
    expect(choices.value).toBe(SYSTEM_FOUND);
    expect(choices.found).toEqual({ name: "ec-uikit", importedId: null });
    // Nothing imported yet: no system page to open.
    expect(choices.open).toBeNull();
  });

  it("opens the imported copy's page for a found-system design", () => {
    const choices = editorSystemChoices({
      owner: ec,
      systems: [summary("s_ec", "ec-uikit", ec)],
      value: null,
      reuse,
      canCopy: true,
    });
    expect(choices.found?.importedId).toBe("s_ec");
    expect(choices.open).toEqual({ owner: ec, systemId: "s_ec" });
  });

  it("opens the chosen system's page and offers other owners as copies", () => {
    const choices = editorSystemChoices({
      owner: ec,
      systems: [summary("s_ec", "ec-uikit", ec), summary("s_plain", "Plain brand", plain)],
      value: "s_ec" as DesignSystemId,
      reuse,
      canCopy: true,
    });
    expect(choices.label).toBe("ec-uikit");
    expect(choices.found).toBeNull();
    expect(choices.others.map((system) => system.name)).toEqual(["Plain brand"]);
    expect(choices.open).toEqual({ owner: ec, systemId: "s_ec" });
  });

  it("reads None with nothing to open for a design without a system", () => {
    const choices = editorSystemChoices({
      owner: ec,
      systems: [],
      value: null,
      reuse: null,
      canCopy: false,
    });
    expect(choices).toMatchObject({ label: "None", value: SYSTEM_NONE, open: null });
  });
});

describe("systemChangeOperations", () => {
  it("drops the reused found system when None is picked, so the header says None", () => {
    expect(systemChangeOperations(null, reuse)).toEqual([
      { op: "set_design_system", systemId: null },
      { op: "set_reuse", reuse: null },
    ]);
    expect(systemChangeOperations(null, null)).toEqual([
      { op: "set_design_system", systemId: null },
    ]);
    // Picking a system keeps the record of where the design came from.
    expect(systemChangeOperations("s_ec" as DesignSystemId, reuse)).toEqual([
      { op: "set_design_system", systemId: "s_ec" },
    ]);
  });

  it("then shows None", () => {
    const after = editorSystemChoices({
      owner: ec,
      systems: [],
      value: null,
      reuse: null,
      canCopy: false,
    });
    expect(after).toMatchObject({ value: SYSTEM_NONE, label: "None" });
  });
});
