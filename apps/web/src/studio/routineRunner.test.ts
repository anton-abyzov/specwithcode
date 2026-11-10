import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { routineRunnerOf } from "./routineRunner";

/** M4 rests (it gave way); Ministorm coordinates. */
const refs = ["m4", "ministorm"].map((host) => ({
  environmentId: EnvironmentId.make(host),
  projectId: ProjectId.make(`p-${host}`),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${host}`),
}));
const domain = { id: "ig", title: "IG", coordinatorId: "ig-coordinator", members: refs };
const [m4, ministorm] = refs.map((ref, index) => ({
  environmentId: ref.environmentId,
  id: ref.projectId,
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    logicalProject: domain,
    coordinatorBinding: { epoch: 2, state: index === 1 ? "active" : "transferred" },
  },
})) as unknown as [EnvironmentProject, EnvironmentProject];
const unlinked = {
  ...m4,
  id: ProjectId.make("solo"),
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
} as unknown as EnvironmentProject;

describe("where a project's routines run", () => {
  it("is the coordinating copy on another machine, online or not", () => {
    expect(routineRunnerOf(m4, [m4, ministorm], () => true)).toEqual({
      member: ministorm,
      online: true,
    });
    expect(routineRunnerOf(m4, [m4, ministorm], () => false)?.online).toBe(false);
  });

  it("is none on the runner itself, an unlinked project or an unknown copy", () => {
    expect(routineRunnerOf(ministorm, [m4, ministorm], () => true)).toBeNull();
    expect(routineRunnerOf(unlinked, [unlinked, ministorm], () => true)).toBeNull();
    expect(routineRunnerOf(undefined, [m4, ministorm], () => true)).toBeNull();
  });

  it("is none while no copy coordinates", () => {
    const resting = {
      ...ministorm,
      workspaceSettings: {
        ...ministorm.workspaceSettings!,
        coordinatorBinding: { epoch: 2, state: "transferred" },
      },
    } as unknown as EnvironmentProject;
    expect(routineRunnerOf(m4, [m4, resting], () => true)).toBeNull();
  });
});
