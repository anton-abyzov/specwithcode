import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionHandoffModeProjects } from "./handoffModeSettings.logic";

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
  it("drops No project and personal assistants, and puts archived projects apart", () => {
    const { active, archived } = partitionHandoffModeProjects(
      [
        project("app", "/work/app"),
        project("old", "/work/old", { archived: true }),
        project("check", "/work/check", { origin: "automated" }),
        project("aide", "/home/.studio/projects/aide", { kind: "personal" }),
        project("scratch", "/home/.studio/scratch"),
        project("elsewhere", "/work/elsewhere", {}, EnvironmentId.make("other")),
      ],
      host,
      () => "/home/.studio/scratch",
    );
    // A management list: an automated project keeps its row, as in the sidebar's Automated list.
    expect(active.map((entry) => entry.id)).toEqual(["app", "check"]);
    expect(archived.map((entry) => entry.id)).toEqual(["old"]);
  });
});
