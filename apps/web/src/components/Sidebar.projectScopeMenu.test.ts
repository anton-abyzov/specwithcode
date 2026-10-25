import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reduceSidebarProjectScopeMenuState, sidebarProjectScopeItems } from "./Sidebar.logic";

describe("reduceSidebarProjectScopeMenuState", () => {
  it("clears the query when opening a project window closes the combobox", () => {
    expect(
      reduceSidebarProjectScopeMenuState(
        { open: true, query: "alpha" },
        { type: "project-window-opened" },
      ),
    ).toEqual({ open: false, query: "" });
  });
});

describe("sidebarProjectScopeItems", () => {
  const group = (
    projectKey: string,
    workspaceRoot: string,
    settings?: { archived?: boolean; origin?: string },
  ) => ({
    projectKey,
    displayName: projectKey,
    memberProjects: [
      {
        environmentId: "host" as EnvironmentId,
        id: projectKey as ProjectId,
        workspaceRoot,
        ...(settings ? { workspaceSettings: settings } : {}),
      },
    ],
  });
  const groups = [
    group("atlas", "/work/atlas"),
    group("old", "/work/old", { archived: true }),
    group("check", "/work/check", { origin: "automated" }),
    group("scratch", "/home/.studio/scratch"),
  ];
  const scratchRootFor = () => "/home/.studio/scratch";

  it("offers only the person's own projects", () => {
    expect(sidebarProjectScopeItems(groups, scratchRootFor, null)).toEqual([
      { value: "all", label: "All projects" },
      { value: "atlas", label: "atlas" },
    ]);
  });

  it("shows an archived or automated current scope as a row that cannot be chosen", () => {
    expect(sidebarProjectScopeItems(groups, scratchRootFor, "old")).toEqual([
      { value: "all", label: "All projects" },
      { value: "old", label: "old", unavailable: "Archived project, not available here" },
      { value: "atlas", label: "atlas" },
    ]);
    expect(sidebarProjectScopeItems(groups, scratchRootFor, "check")[1]).toEqual({
      value: "check",
      label: "check",
      unavailable: "Automated project, not available here",
    });
    expect(sidebarProjectScopeItems(groups, scratchRootFor, "atlas")).toHaveLength(2);
  });
});
