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
  copyRolesSummary,
  logicalCoordinator,
  logicalCoordinators,
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
  it("names the newest coordinator and reports none when every copy runs workers", () => {
    expect(logicalCoordinator(projects)?.member?.id).toBe("m3");
    expect(logicalCoordinator(projects.slice(0, 2))?.member).toBeUndefined();
    expect(logicalCoordinator(projects.slice(0, 2))?.problem).toContain("unavailable");
  });
  it("lets each machine run its own coordinator without a conflict", () => {
    const m4 = {
      ...projects[0]!,
      workspaceSettings: {
        ...projects[0]!.workspaceSettings!,
        coordinatorBinding: { epoch: 0, state: "active" as const },
      },
    };
    const both = [projects[2]!, m4];
    expect(logicalCoordinator(both)).toEqual({ member: projects[2], problem: null });
    expect(logicalCoordinators(both)?.coordinators).toEqual([projects[2], m4]);
    expect(copyRolesSummary(both)).toBe("Machine: coordinator · Machine: coordinator");
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
        "Anton's Mac",
      ),
    ).toBe("Anton's Mac · Claude Code · Opus 5.5");
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
  // Without the link in between, the transferring copy still waits on its own handoff.
  expect(logicalCoordinator([a, c])).toEqual({ member: c, problem: null });
  expect(logicalCoordinators([a, c])?.pending).toEqual([a]);
});
it("supersedes an active ancestor that a newer copy took over from", () => {
  const old = {
    ...projects[0]!,
    workspaceSettings: {
      ...projects[0]!.workspaceSettings!,
      coordinatorBinding: { epoch: 1, state: "active" as const },
    },
  };
  const successor = {
    ...projects[1]!,
    workspaceSettings: {
      ...projects[1]!.workspaceSettings!,
      coordinatorBinding: {
        epoch: 2,
        state: "active" as const,
        predecessor: refs[0]!,
        takenOverAt: "2026-10-20T18:00:00.000Z",
      },
    },
  };
  const found = logicalCoordinators([old, successor]);
  expect(found?.coordinators).toEqual([successor]);
  expect(found?.superseded).toEqual([old]);
});
it("flags an ancestor still active at the epoch its successor took over at", () => {
  const ancestor = {
    ...projects[0]!,
    workspaceSettings: {
      ...projects[0]!.workspaceSettings!,
      coordinatorBinding: { epoch: 1, state: "active" as const },
    },
  };
  const successor = {
    ...projects[1]!,
    workspaceSettings: {
      ...projects[1]!.workspaceSettings!,
      coordinatorBinding: { epoch: 1, state: "active" as const, predecessor: refs[0]! },
    },
  };
  const found = logicalCoordinators([ancestor, successor]);
  expect(found?.coordinators).toEqual([successor, ancestor]);
  expect(found?.contested).toEqual([successor, ancestor]);
  expect(logicalCoordinator([ancestor, successor])?.problem).toContain("same epoch");
  // A coordinator started after the takeover runs at a newer epoch and contests nothing.
  const restarted = {
    ...ancestor,
    workspaceSettings: {
      ...ancestor.workspaceSettings,
      coordinatorBinding: { epoch: 2, state: "active" as const },
    },
  };
  expect(logicalCoordinators([restarted, successor])?.contested).toEqual([]);
  expect(logicalCoordinator([restarted, successor])).toEqual({ member: restarted, problem: null });
});
it("does not loop or supersede both copies when predecessors point at each other", () => {
  const a = {
    ...projects[0]!,
    workspaceSettings: {
      ...projects[0]!.workspaceSettings!,
      coordinatorBinding: { epoch: 1, state: "active" as const, predecessor: refs[1]! },
    },
  };
  const b = {
    ...projects[1]!,
    workspaceSettings: {
      ...projects[1]!.workspaceSettings!,
      coordinatorBinding: { epoch: 2, state: "active" as const, predecessor: refs[0]! },
    },
  };
  expect(logicalCoordinators([a, b])?.coordinators).toEqual([b]);
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
