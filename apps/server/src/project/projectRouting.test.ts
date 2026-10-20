import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PROJECT_WORKSPACE_SETTINGS, ProjectId } from "@specweave-studio/contracts";
import {
  assistantFolders,
  grantingFolder,
  isWithinFolder,
  routeRefusalMessage,
  routeStateRefusal,
} from "./projectRouting.ts";

const project = (id: string, workspaceRoot: string, settings: object = {}) => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  deletedAt: null as string | null,
  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, ...settings },
});

describe("project routing access", () => {
  it("treats a folder and its children as inside, siblings and look-alikes as outside", () => {
    expect(isWithinFolder("/u/Projects/umb", "/u/Projects/umb")).toBe(true);
    expect(isWithinFolder("/u/Projects/umb", "/u/Projects/umb/repositories/a/specweave")).toBe(
      true,
    );
    expect(isWithinFolder("/u/Projects/umb", "/u/Projects/umb-other")).toBe(false);
    expect(isWithinFolder("/u/Projects/umb", "/u/Projects")).toBe(false);
    expect(isWithinFolder("/u/Projects/umb", "/u/Projects/umb/..foo")).toBe(true);
  });

  it("uses the assistant's own folder and its approved folders, nothing else", () => {
    const aide = project("aide", "/h/aide", {
      kind: "personal",
      environment: { additionalFolders: ["/u/umb", "/u/easychamp"], repositories: [] },
    });
    expect(assistantFolders(aide)).toEqual(["/h/aide", "/u/umb", "/u/easychamp"]);
  });

  it("names the narrowest approved folder as the evidence", () => {
    const folders = [
      { folder: "~/umb", real: "/u/umb" },
      { folder: "~/umb/repositories", real: "/u/umb/repositories" },
    ];
    expect(grantingFolder(folders, "/u/umb/repositories/specweave")).toBe("~/umb/repositories");
    expect(grantingFolder(folders, "/u/elsewhere")).toBeNull();
  });

  it("refuses itself, missing, deleted, archived, paused and moved projects", () => {
    const aide = project("aide", "/h/aide", { kind: "personal" });
    expect(routeStateRefusal(aide, aide)).toBe("self");
    expect(routeStateRefusal(aide, undefined)).toBe("not_found");
    expect(routeStateRefusal(aide, { ...project("x", "/u/x"), deletedAt: "2026-10-19" })).toBe(
      "deleted",
    );
    expect(routeStateRefusal(aide, project("x", "/u/x", { archived: true }))).toBe("archived");
    expect(routeStateRefusal(aide, project("x", "/u/x", { paused: true }))).toBe("paused");
    expect(routeStateRefusal(aide, project("x", "/u/x"))).toBeNull();
  });

  it("tells the assistant the user adds folders, never itself", () => {
    const message = routeRefusalMessage("outside_folders", { assistant: "Aide", target: "Vskill" });
    expect(message).toContain("The user can add that folder");
    expect(message).toContain("do not ask for or add it yourself");
  });
});
