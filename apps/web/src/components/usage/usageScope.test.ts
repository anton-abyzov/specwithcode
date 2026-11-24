import { describe, expect, it } from "vite-plus/test";

import {
  driverLabel,
  driversWithoutCost,
  keepsDriver,
  keepsProject,
  notAppliedNotes,
  sortDrivers,
  usageKindOfDriver,
  usageKindsOfDrivers,
} from "./usageScope";

const none = {
  drivers: new Set<string>(),
  modelQuery: "",
  projects: new Set<string>(),
  machinesNarrowed: false,
};

describe("drivers", () => {
  it("maps Cost's transcript kinds to drivers and back", () => {
    expect(usageKindOfDriver("claudeAgent")).toBe("claude");
    expect(usageKindOfDriver("copilot")).toBeNull();
    expect(
      [...usageKindsOfDrivers(new Set(["claudeAgent", "copilot", "codex"]))].toSorted(),
    ).toEqual(["claude", "codex"]);
  });
  it("labels drivers Cost knows with Cost's names", () => {
    expect(driverLabel("claudeAgent")).toBe("Claude Code");
    expect(driverLabel("someAcpAgent")).toBe("someAcpAgent");
  });
  it("sorts Cost's providers first", () => {
    expect(sortDrivers(["zed", "claudeAgent", "codex", "claudeAgent"])).toEqual([
      "codex",
      "claudeAgent",
      "zed",
    ]);
  });
  it("keeps everything with an empty selection", () => {
    expect(keepsDriver(new Set(), "x")).toBe(true);
    expect(keepsDriver(new Set(["codex"]), "x")).toBe(false);
    expect(keepsProject(new Set(), null)).toBe(true);
    expect(keepsProject(new Set(["specweave"]), null)).toBe(false);
  });
  it("names selected providers with no measured cost", () => {
    expect(driversWithoutCost(new Set(["copilot", "claudeAgent"]), ["claude"])).toEqual([
      "copilot",
    ]);
  });
});

describe("notAppliedNotes", () => {
  it("says nothing when no filter is active", () => {
    expect(notAppliedNotes("cost", none)).toEqual([]);
  });
  it("names a project filter Cost cannot apply, with the reason", () => {
    expect(notAppliedNotes("cost", { ...none, projects: new Set(["specweave"]) })).toEqual([
      "Project is not applied on Cost: its records carry no project.",
    ]);
  });
  it("applies every filter on Delivered", () => {
    expect(
      notAppliedNotes("delivered", {
        drivers: new Set(["codex"]),
        modelQuery: "opus",
        projects: new Set(["specweave"]),
        machinesNarrowed: true,
      }),
    ).toEqual([]);
  });
  it("names model search on Limits and Machines", () => {
    expect(notAppliedNotes("limits", { ...none, modelQuery: "opus" })).toEqual([
      "Model search is not applied on Limits: limits are per account, not per model.",
    ]);
    expect(notAppliedNotes("machines", { ...none, modelQuery: "opus" })[0]).toMatch(
      /^Model search is not applied on Machines/u,
    );
  });
});
