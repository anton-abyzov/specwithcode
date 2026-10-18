import { describe, expect, it } from "vite-plus/test";

import { checkProjectName, renameTargets, type NamedProject } from "./projectRename";

const current: NamedProject = { projectKey: "scripts", name: "Scripts", archived: false };
const others: NamedProject[] = [
  current,
  { projectKey: "specweave", name: "SpecWeave", archived: false },
  { projectKey: "old", name: "Old Site", archived: true },
];
const check = (draft: string) => checkProjectName({ draft, current, others });

describe("checkProjectName", () => {
  it("accepts a free name, trimmed", () => {
    expect(check("  Olysense  ")).toEqual({ kind: "valid", name: "Olysense" });
  });

  it("refuses an empty or blank name", () => {
    expect(check("")).toEqual({ kind: "invalid", error: "Enter a name." });
    expect(check("   ")).toEqual({ kind: "invalid", error: "Enter a name." });
  });

  it("refuses a name over 120 characters", () => {
    expect(check("a".repeat(120))).toEqual({ kind: "valid", name: "a".repeat(120) });
    expect(check("a".repeat(121))).toEqual({
      kind: "invalid",
      error: "Use at most 120 characters.",
    });
  });

  it("refuses another project's name whatever its case", () => {
    expect(check("specweave")).toEqual({
      kind: "invalid",
      error: "Another project is already named “SpecWeave”.",
    });
    expect(check(" SPECWEAVE ")).toMatchObject({ kind: "invalid" });
  });

  it("refuses an archived project's name and says it is archived", () => {
    expect(check("old site")).toEqual({
      kind: "invalid",
      error: "An archived project is already named “Old Site”.",
    });
  });

  it("treats the current name as unchanged and lets its case change", () => {
    expect(check("Scripts")).toEqual({ kind: "unchanged" });
    expect(check(" Scripts ")).toEqual({ kind: "unchanged" });
    expect(check("SCRIPTS")).toEqual({ kind: "valid", name: "SCRIPTS" });
  });
});

describe("renameTargets", () => {
  const checkout = (title: string, environmentId: string) => ({ title, environmentId });

  it("renames every checkout of a repository that does not have the name yet", () => {
    const members = [checkout("Scripts", "m4"), checkout("Tools", "m1"), checkout("Scripts", "m3")];
    expect(renameTargets(members, "Tools")).toEqual({
      targets: [members[0], members[2]],
    });
  });

  it("renames a moving project only on the machine running its coordinator", () => {
    const logical = (state: string, title = "Scripts") => ({
      title: "folder",
      workspaceSettings: { logicalProject: { title }, coordinatorBinding: { state } },
    });
    const owner = logical("active");
    expect(renameTargets([logical("transferred"), owner], "Tools")).toEqual({ targets: [owner] });
    expect(renameTargets([logical("active", "Tools")], "Tools")).toEqual({ targets: [] });
  });

  it("says why when the coordinator's machine is not connected", () => {
    const away = {
      title: "folder",
      workspaceSettings: {
        logicalProject: { title: "Scripts" },
        coordinatorBinding: { state: "transferred" },
      },
    };
    expect(renameTargets([away], "Tools")).toEqual({
      error: "The machine running this project's coordinator is not connected. Try again later.",
    });
  });
});
