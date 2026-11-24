import { describe, expect, it } from "vite-plus/test";
import { englishPhrase } from "../i18n";

/** A phrase with its values filled in, as the sidebar shows it in English. */
const said = (words: { text: string; values: Readonly<Record<string, string>> } | null) =>
  words ? englishPhrase(words.text, words.values) : null;
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
  departedLinkSeats,
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
    // Each runs its own coordinator; the newest epoch, then the machine, names the one that
    // holds the coordinator conversation. No machine is called Main or Copy.
    expect(said(copyRolesSummary(both))).toBe("On Machine (coordinator) and Machine");
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
  // A coordinator started after the takeover runs at a newer epoch and contests nothing,
  // and it runs beside the copy that took over by name, which still leads.
  const restarted = {
    ...ancestor,
    workspaceSettings: {
      ...ancestor.workspaceSettings,
      coordinatorBinding: { epoch: 2, state: "active" as const },
    },
  };
  expect(logicalCoordinators([restarted, successor])?.contested).toEqual([]);
  expect(logicalCoordinator([restarted, successor])).toEqual({ member: successor, problem: null });
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

describe("copyRolesSummary with retired records", () => {
  it("names the live machine the coordinator, never a re-joined machine's old record", () => {
    const member = (environmentId: string, id: string, epoch: number) =>
      ({
        environmentId,
        id,
        environmentLabel: environmentId,
        workspaceSettings: {
          logicalProject: { id: "L", title: "L", coordinatorId: "c", members: [] },
          coordinatorBinding: { epoch, state: "active" },
        },
      }) as never;
    const members = [member("old", "a", 9), member("m4", "b", 3)];
    expect(said(copyRolesSummary(members, (m: { environmentId: string }) => m.environmentId))).toBe(
      "On old (coordinator) and m4",
    );
    // The coordinator's machine leads, so one phrase per shape translates.
    expect(
      said(
        copyRolesSummary(
          members,
          (m: { environmentId: string }) => m.environmentId,
          new Map([["old", "m1"]]),
        ),
      ),
    ).toBe("On m4 (coordinator) and old");
    const three = [...members, member("m5", "c", 1)];
    expect(copyRolesSummary(three, (m: { environmentId: string }) => m.environmentId)).toEqual({
      text: "On {coordinator} (coordinator), {machines} and {last}",
      values: { coordinator: "old", machines: "m4", last: "m5" },
    });
  });
});

describe("logicalCoordinator with a coordinator started beside main", () => {
  const ref = (environmentId: string) => ({
    environmentId,
    projectId: "p",
    coordinatorThreadId: "project-coordinator:p",
  });
  const member = (environmentId: string, coordinatorBinding: object) =>
    ({
      environmentId,
      id: "p",
      title: "Atlas",
      workspaceRoot: `/${environmentId}`,
      workspaceSettings: {
        kind: "code",
        logicalProject: {
          id: "atlas",
          title: "Atlas",
          coordinatorId: "coordinator:atlas",
          members: ["m4", "m5", "m1", "m3"].map(ref),
        },
        coordinatorBinding,
      },
    }) as unknown as EnvironmentProject;
  const main = member("m4", { epoch: 0, state: "active" });
  const follower = member("m5", { epoch: 0, state: "transferred", successor: ref("m4") });
  const beside = member("m1", { epoch: 2, state: "active" });
  const old = member("m3", { epoch: 0, state: "transferred", successor: ref("m1") });

  it("replicates from the main the copies follow, not the higher epoch", () => {
    expect(logicalCoordinator([beside, follower, main])?.member).toBe(main);
  });

  it("lets no retired record name the coordinator", () => {
    const retired = { has: (id: string) => id === "m3" };
    expect(logicalCoordinator([beside, follower, main, old], retired)?.member).toBe(main);
    // Counted, m3's vote ties m1 with m4 at epoch 0, and m1's newer epoch would win.
    expect(logicalCoordinator([beside, follower, main, old])?.member).toBe(beside);
  });
});

describe("a linked Percy's seats (1448 D-20)", () => {
  const ref = (environmentId: string) => ({
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(`percy-${environmentId}`),
    coordinatorThreadId: null,
  });
  const link = (id: string, members: ReturnType<typeof ref>[]) => ({
    id,
    title: "Percy",
    coordinatorId: "percy",
    members,
  });
  const seat = (environmentId: string, logicalProject?: ReturnType<typeof link>) =>
    ({
      environmentId,
      id: `percy-${environmentId}`,
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        kind: "personal",
        ...(logicalProject ? { logicalProject } : {}),
      },
    }) as unknown as EnvironmentProject;
  const shared = link("logical:percy:fixture", [ref("m5"), ref("m4"), ref("m1")]);
  const viewed = seat("m5", shared);

  it("leaves out a seat that left the link by its own view, though the others still list it", () => {
    // m1 ran undo: its own identity is fresh, while m5 and m4 have not heard yet.
    const m4 = seat("m4", shared);
    const m1 = seat("m1", link("logical:fresh", [ref("m1")]));
    expect(departedLinkSeats(viewed, [viewed, m4], [viewed, m4, m1])).toEqual(["m1:percy-m1"]);
    const scopes = projectExecutionScopes(viewed, [viewed, m4]).filter(
      (scope) =>
        !departedLinkSeats(viewed, [viewed, m4], [viewed, m4, m1]).includes(
          `${scope.environmentId}:${scope.projectId}`,
        ),
    );
    expect(scopes.map((scope) => scope.environmentId)).toEqual(["m5", "m4"]);
  });

  it("leaves out a seat with the link's id but only itself as a member", () => {
    const m4 = seat("m4", shared);
    const m1 = seat("m1", link("logical:percy:fixture", [ref("m1")]));
    expect(departedLinkSeats(viewed, [viewed, m4, m1], [])).toEqual(["m1:percy-m1"]);
  });

  it("keeps a seat the window has not loaded, so its machine is named as offline", () => {
    expect(departedLinkSeats(viewed, [viewed], [viewed])).toEqual([]);
  });

  it("changes nothing for a project that is not a personal assistant", () => {
    const code = {
      ...viewed,
      workspaceSettings: { ...viewed.workspaceSettings, kind: "code" },
    } as unknown as EnvironmentProject;
    expect(departedLinkSeats(code, [code], [seat("m1")])).toEqual([]);
  });
});
