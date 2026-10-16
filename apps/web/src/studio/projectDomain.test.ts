import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import {
  logicalCoordinator,
  logicalProjectThreads,
  projectExecutionScopes,
  requestExecutionLabel,
} from "./projectDomain";
import {
  projectPaneThread,
  parseProjectWorkspaceSearch,
  projectWorkspaceSearch,
} from "./projectPaneThreads";
const refs = ["m4", "m1", "m3"].map((host) => ({
  environmentId: EnvironmentId.make(host),
  projectId: ProjectId.make(host),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${host}`),
}));
const domain = { id: "one", title: "One project", coordinatorId: "one-coordinator", members: refs };
const projects = refs.map((ref, index) => ({
  environmentId: ref.environmentId,
  id: ref.projectId,
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    logicalProject: domain,
    coordinatorBinding: { epoch: index, state: index === 2 ? "active" : "transferred" },
  },
})) as unknown as EnvironmentProject[];
describe("logical project execution", () => {
  it("resolves only the admitted owner, refusing conflicts and a missing successor", () => {
    expect(logicalCoordinator(projects)?.member?.id).toBe("m3");
    expect(logicalCoordinator(projects.slice(0, 2))?.member).toBeUndefined();
    expect(
      logicalCoordinator([
        projects[2]!,
        {
          ...projects[0]!,
          workspaceSettings: {
            ...projects[0]!.workspaceSettings!,
            coordinatorBinding: { epoch: 0, state: "active" },
          },
        },
      ])?.problem,
    ).toContain("Conflicting");
  });
  it("keeps the transferring source mounted for retry but blocks sending", () => {
    const source = {
      ...projects[0]!,
      workspaceSettings: {
        ...projects[0]!.workspaceSettings!,
        coordinatorBinding: { epoch: 0, state: "transferring" as const },
      },
    };
    const result = logicalCoordinator([source]);
    expect(result?.member).toBe(source);
    expect(result?.problem).toContain("pending");
  });
  it("aggregates scoped duplicate IDs including archived workers and opens the exact remote thread", () => {
    const scopes = projectExecutionScopes(projects[2]!, projects);
    const threads = refs.map((ref, index) => ({
      id: ThreadId.make("same-thread"),
      environmentId: ref.environmentId,
      projectId: ref.projectId,
      deletedAt: null,
      archivedAt: index === 0 ? "2026-10-01" : null,
    })) as EnvironmentThreadShell[];
    expect(logicalProjectThreads(threads, scopes, true)).toHaveLength(3);
    const scope = {
      environmentId: "m3",
      projectId: "m3",
      coordinatorThreadId: "project-coordinator:m3",
      members: scopes,
    };
    expect(projectPaneThread(threads, scope, "same-thread", "m1")).toEqual({
      kind: "pane",
      thread: threads[1],
    });
    expect(projectPaneThread(threads, scope, "same-thread", "unrelated").kind).toBe("elsewhere");
    expect(
      parseProjectWorkspaceSearch({
        ...projectWorkspaceSearch(ThreadId.make("same-thread"), null, "m1"),
      }),
    ).toEqual({ thread: "same-thread", threadEnvironment: "m1" });
  });
  it("labels historical requests from the recorded run, preserving unknown provenance", () => {
    const runs = [
      { id: "old", modelSelection: { instanceId: "claude", model: "old-model" } },
      { id: "now", modelSelection: { instanceId: "codex", model: "new-model" } },
    ];
    expect(requestExecutionLabel({ runId: "old" }, runs, "M4")).toBe(
      "M4 · Claude Code · Old Model",
    );
    expect(requestExecutionLabel({}, runs, "M1")).toBe("M1 · Model not recorded");
    expect(
      requestExecutionLabel(
        { runId: "old" },
        [{ id: "old", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }],
        "Anton's MacBook M4MAX (149)",
      ),
    ).toBe("MacBook M4MAX (149) · Claude Code · Opus 5.5");
  });
});

it("uses the declared successor chain without waiting forever for a stale ancestor", () => {
  const a = {
    ...projects[0]!,
    workspaceSettings: {
      ...projects[0]!.workspaceSettings!,
      coordinatorBinding: { epoch: 0, state: "transferring" as const },
    },
  };
  const b = {
    ...projects[1]!,
    workspaceSettings: {
      ...projects[1]!.workspaceSettings!,
      coordinatorBinding: { epoch: 1, state: "transferred" as const, predecessor: refs[0]! },
    },
  };
  const c = {
    ...projects[2]!,
    workspaceSettings: {
      ...projects[2]!.workspaceSettings!,
      coordinatorBinding: { epoch: 2, state: "active" as const, predecessor: refs[1]! },
    },
  };
  expect(logicalCoordinator([a, b, c])?.member).toBe(c);
  expect(logicalCoordinator([a, c])?.problem).toContain("Conflicting");
});
it("retains the current host scope while a new project's member list is empty", () => {
  const project = {
    ...projects[0]!,
    workspaceSettings: {
      ...projects[0]!.workspaceSettings!,
      logicalProject: { ...domain, members: [] },
    },
  };
  expect(projectExecutionScopes(project, [project])).toEqual([
    { environmentId: "m4", projectId: "m4", coordinatorThreadId: null },
  ]);
});
