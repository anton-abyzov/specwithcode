import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectsToAdd } from "./AddProjectToMachine.logic";

const here = EnvironmentId.make("env-here");
const there = EnvironmentId.make("env-there");
const project = (
  title: string,
  extra: {
    environmentId?: EnvironmentId;
    workspaceRoot?: string;
    workspaceSettings?: Record<string, unknown>;
  } = {},
) =>
  ({
    environmentId: extra.environmentId ?? here,
    id: `p-${title}`,
    title,
    workspaceRoot: extra.workspaceRoot ?? `/Users/a/${title}`,
    workspaceSettings: { kind: "code", ...extra.workspaceSettings },
  }) as unknown as EnvironmentProject;

describe("projectsToAdd", () => {
  it("lists this machine's own projects by name", () => {
    const listed = projectsToAdd(
      [project("zeta"), project("alpha"), project("elsewhere", { environmentId: there })],
      here,
    );
    expect(listed.map((item) => item.title)).toEqual(["alpha", "zeta"]);
  });

  it("leaves out archived and automated projects and the personal assistant", () => {
    const listed = projectsToAdd(
      [
        project("kept"),
        project("archived", { workspaceSettings: { archived: true } }),
        project("by-a-check", { workspaceSettings: { origin: "automated" } }),
        project("temp", { workspaceRoot: "/tmp/check-123" }),
        project("assistant", { workspaceSettings: { kind: "personal" } }),
      ],
      here,
    );
    expect(listed.map((item) => item.title)).toEqual(["kept"]);
  });

  it("lists nothing while this machine is unknown", () => {
    expect(projectsToAdd([project("kept")], null)).toEqual([]);
  });
});
