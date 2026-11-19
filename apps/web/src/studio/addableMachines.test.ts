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
  const shown = project("m4", "p4", { logical: "L", members: ["m4", "m5", "m3"] });
  const projects = [
    shown,
    project("m5", "p5", { logical: "L" }),
    // The same repository, not linked: the machine has the project.
    project("mini", "pm", { root: "/srv/atlas" }),
    // Another repository on a machine without the project.
    project("m1", "other", { root: "/work/notes", repository: "example.com/acme/notes" }),
  ];

  it("offers only a machine with no folder of the project and no membership", () => {
    expect(
      addableMachineIds({ project: shown, machineIds: ["m4", "m5", "mini", "m1", "m3"], projects }),
    ).toEqual(["m1"]);
  });

  it("never offers a member this window has not loaded", () => {
    // m3 is a member the project names: it has the project though no folder is loaded here.
    expect(addableMachineIds({ project: shown, machineIds: ["m3"], projects })).toEqual([]);
  });

  it("counts a linked folder whose repository reads differently, and no handoff scratch folder", () => {
    const linked = project("m5", "p5", { logical: "L", repository: "example.com/fork/atlas" });
    const scratch = project("m1", "machine-handoff:x", { logical: "L" });
    expect(projectFoldersElsewhere(shown, [shown, linked, scratch])).toEqual([linked]);
  });
});
