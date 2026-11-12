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
    id?: string;
    workspaceRoot?: string;
    workspaceSettings?: Record<string, unknown>;
  } = {},
) =>
  ({
    environmentId: extra.environmentId ?? here,
    id: extra.id ?? `p-${title}`,
    title,
    workspaceRoot: extra.workspaceRoot ?? `/Users/a/${title}`,
    workspaceSettings: { kind: "code", ...extra.workspaceSettings },
  }) as unknown as EnvironmentProject;
const titles = (projects: ReadonlyArray<EnvironmentProject>) => projects.map((item) => item.title);

describe("projectsToAdd", () => {
  it("lists this machine's own projects by name", () => {
    const listed = projectsToAdd(
      [project("zeta"), project("alpha"), project("elsewhere", { environmentId: there })],
      here,
    );
    expect(titles(listed)).toEqual(["alpha", "zeta"]);
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
    expect(titles(listed)).toEqual(["kept"]);
  });

  it("leaves out the scratch project, even one saved as the person's own", () => {
    const scratch = project("scratch", {
      workspaceRoot: "/Users/a/.specwithcode/scratch",
      workspaceSettings: { origin: "user" },
    });
    expect(titles(projectsToAdd([project("kept"), scratch], here))).toEqual(["kept", "scratch"]);
    expect(
      titles(projectsToAdd([project("kept"), scratch], here, "/Users/a/.specwithcode/scratch")),
    ).toEqual(["kept"]);
  });

  it("leaves out transfer storage, which is never a project to copy", () => {
    const listed = projectsToAdd(
      [
        project("kept"),
        project("handoff", { id: "machine-handoff:abc" }),
        project("stored", { workspaceRoot: "/Users/a/state/machine-handoffs/git/abc" }),
      ],
      here,
    );
    expect(titles(listed)).toEqual(["kept"]);
  });

  it("lists nothing while this machine is unknown", () => {
    expect(projectsToAdd([project("kept")], null)).toEqual([]);
  });
});
