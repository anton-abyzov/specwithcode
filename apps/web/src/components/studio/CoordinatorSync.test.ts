import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useLinkMachines", () => ({ useLinkMachines: () => ({}) }));
vi.mock("../../studio/projectLink", () => ({ projectLink: {} }));

const { sharedGroups } = await import("./CoordinatorSync");

const project = (environmentId: string, id: string, logicalProjectId?: string) =>
  ({
    environmentId,
    id,
    workspaceSettings: logicalProjectId ? { logicalProject: { id: logicalProjectId } } : {},
  }) as unknown as EnvironmentProject;

describe("coordinator sync", () => {
  it("groups copies of one shared project that sit on two or more machines", () => {
    const m3 = project("m3", "kept", "logical:1");
    const m4 = project("m4", "joined", "logical:1");
    expect(
      sharedGroups([
        m3,
        m4,
        project("m4", "solo", "logical:2"),
        project("m4", "other", "logical:3"),
        project("m4", "again", "logical:3"),
        project("m1", "plain"),
      ]),
    ).toEqual([[m3, m4]]);
  });
});
