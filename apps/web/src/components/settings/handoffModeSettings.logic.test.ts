import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionHandoffModeProjects, sameTitleFolderHints } from "./handoffModeSettings.logic";

const host = EnvironmentId.make("host");
const project = (
  id: string,
  workspaceRoot: string,
  settings: object = {},
  environmentId = host,
) => ({
  environmentId,
  id: ProjectId.make(id),
  workspaceRoot,
  workspaceSettings: settings,
});

describe("handoff mode project list", () => {
  it("lists only active projects, with automated and archived ones apart", () => {
    const { active, automated, archived } = partitionHandoffModeProjects(
      [
        project("app", "/work/app"),
        project("old", "/work/old", { archived: true }),
        project("check", "/work/check", { origin: "automated" }),
        project("proof", "/home/.local/share/specweave/fleet/proof/app"),
        project("old-check", "/work/old-check", { origin: "automated", archived: true }),
        project("aide", "/home/.studio/projects/aide", { kind: "personal" }),
        project("scratch", "/home/.studio/scratch"),
        project("elsewhere", "/work/elsewhere", {}, EnvironmentId.make("other")),
      ],
      host,
      () => "/home/.studio/scratch",
    );
    expect(active.map((entry) => entry.id)).toEqual(["app"]);
    // Saved or guessed from the folder, as in the sidebar's Automated list.
    expect(automated.map((entry) => entry.id)).toEqual(["check", "proof"]);
    expect(archived.map((entry) => entry.id)).toEqual(["old", "old-check"]);
  });

  it("tells same-named projects apart by the shortest distinct end of their folder", () => {
    const hints = sameTitleFolderHints([
      { id: "a", title: "EasyChamp", workspaceRoot: "/Users/me/Projects/sw-easychamp" },
      { id: "b", title: "easychamp", workspaceRoot: "/Users/me/Projects/sw-easychamp/easychamp" },
      { id: "c", title: "EasyChamp", workspaceRoot: "/Volumes/ext/sw-easychamp" },
      { id: "d", title: "Solo", workspaceRoot: "/work/solo" },
    ]);
    expect(Object.fromEntries(hints)).toEqual({
      a: "Projects/sw-easychamp",
      b: "easychamp",
      c: "ext/sw-easychamp",
    });
  });
});
