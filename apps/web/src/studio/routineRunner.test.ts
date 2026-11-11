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

  const withBinding = (member: EnvironmentProject, coordinatorBinding: unknown) =>
    ({
      ...member,
      workspaceSettings: { ...member.workspaceSettings!, coordinatorBinding },
    }) as unknown as EnvironmentProject;

  it("is none for a coordinating copy beside a newer one started on its own", () => {
    const own = withBinding(m4, { epoch: 0, state: "active" });
    const peer = withBinding(ministorm, { epoch: 1, state: "active" });
    expect(routineRunnerOf(own, [own, peer], () => true)).toBeNull();
    expect(routineRunnerOf(peer, [own, peer], () => true)).toBeNull();
  });

  it("is the successor a resting copy names, even beside a newer coordinator", () => {
    const [third] = [
      { ...ministorm, environmentId: EnvironmentId.make("third"), id: ProjectId.make("p-third") },
    ].map((member) => withBinding(member, { epoch: 5, state: "active" }));
    const resting = withBinding(m4, { epoch: 2, state: "transferred", successor: refs[1] });
    expect(routineRunnerOf(resting, [resting, ministorm, third!], () => true)?.member).toBe(
      ministorm,
    );
  });

  it("is the newest coordinating copy when a resting copy names no usable successor", () => {
    const older = withBinding(
      { ...ministorm, environmentId: EnvironmentId.make("third"), id: ProjectId.make("p-third") },
      { epoch: 1, state: "active" },
    );
    expect(routineRunnerOf(m4, [m4, older, ministorm], () => true)?.member).toBe(ministorm);
    const gone = withBinding(m4, {
      epoch: 2,
      state: "transferred",
      successor: { ...refs[1]!, projectId: ProjectId.make("gone") },
    });
    expect(routineRunnerOf(gone, [gone, older, ministorm], () => true)?.member).toBe(ministorm);
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
