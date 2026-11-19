import { describe, expect, it } from "vite-plus/test";

import { addableMachineIds, projectFoldersElsewhere } from "./addableMachines";

const identity = { canonicalKey: "example.com/acme/atlas", rootPath: "/work/atlas" };
const project = (
  environmentId: string,
  id: string,
  over: { root?: string; logical?: string; members?: string[]; repository?: string } = {},
) =>
  ({
    environmentId,
    id,
    workspaceRoot: over.root ?? "/work/atlas",
    repositoryIdentity: {
      ...identity,
      canonicalKey: over.repository ?? identity.canonicalKey,
      rootPath: over.root ?? identity.rootPath,
    },
    workspaceSettings: over.logical
      ? {
          logicalProject: {
            id: over.logical,
            members: (over.members ?? []).map((member) => ({ environmentId: member })),
          },
          coordinatorBinding: { state: "active", epoch: 0 },
        }
      : null,
  }) as never;

describe("addableMachineIds", () => {
  const shown = project("laptopE", "p4", { logical: "L", members: ["laptopE", "rackF", "kioskD"] });
  const projects = [
    shown,
    project("rackF", "p5", { logical: "L" }),
    // The same repository, not linked: the machine has the project.
    project("shelfG", "pm", { root: "/srv/atlas" }),
    // Another repository on a machine without the project.
    project("deskB", "other", { root: "/work/notes", repository: "example.com/acme/notes" }),
  ];

  it("offers only a machine with no folder of the project and no membership", () => {
    expect(
      addableMachineIds({ project: shown, machineIds: ["laptopE", "rackF", "shelfG", "deskB", "kioskD"], projects }),
    ).toEqual(["deskB"]);
  });

  it("never offers a member this window has not loaded", () => {
    // kioskD is a member the project names: it has the project though no folder is loaded here.
    expect(addableMachineIds({ project: shown, machineIds: ["kioskD"], projects })).toEqual([]);
  });

  it("counts a linked folder whose repository reads differently, and no handoff scratch folder", () => {
    const linked = project("rackF", "p5", { logical: "L", repository: "example.com/fork/atlas" });
    const scratch = project("deskB", "machine-handoff:x", { logical: "L" });
    expect(projectFoldersElsewhere(shown, [shown, linked, scratch])).toEqual([linked]);
  });
});
