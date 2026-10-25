import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  newTaskDestinationProjects,
  newTaskProjectUnavailableReason,
  resolveNewTaskEnvironment,
  retainNewTaskProjectContext,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/studiotools/studio",
    title: "SpecWeave Studio",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("getProjectScopeSelectionTarget", () => {
  it("keeps the current environment when it hosts the selected logical project", () => {
    const projects = [makeProject("studio-mac", "mac"), makeProject("studio-server", "server")];
    expect(getProjectScopeSelectionTarget(makeScope(projects), EnvironmentId.make("server"))).toBe(
      projects[1],
    );
  });

  it("falls back to the representative when the current environment does not host the project", () => {
    const projects = [makeProject("studio-mac", "mac"), makeProject("studio-server", "server")];
    expect(getProjectScopeSelectionTarget(makeScope(projects), EnvironmentId.make("other"))).toBe(
      projects[0],
    );
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("studio", "mac", {
      repositoryKey: "github.com/studiotools/studio",
    });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/studiotools/other" }),
      makeProject("studio-clone", "server", { repositoryKey: "github.com/studiotools/studio" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("studio", "mac", { workspaceRoot: "/Users/me/studio" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/studio" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "studio" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("studio", "mac", {
      repositoryKey: "github.com/studiotools/studio",
      workspaceRoot: "/Users/me/studio",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/studio",
      title: "studio",
      workspaceRoot: "/home/me/studio",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/studio" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    // Without any weaker match the fork is still the first-project fallback.
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBeNull();
  });

  it("refuses unrelated targets while a project is selected", () => {
    const selected = makeProject("studio", "mac", {
      repositoryKey: "github.com/studiotools/studio",
    });
    const target = [makeProject("unrelated", "server"), makeProject("also-unrelated", "server")];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBeNull();
    expect(resolveEnvironmentProjectMatch(target, null)).toBe(target[0]);
    expect(resolveEnvironmentProjectMatch([], selected)).toBeNull();
  });
});

describe("resolveDraftProjectSelection", () => {
  it("preserves an explicit project selection", () => {
    const project = makeProject("studio");
    expect(
      resolveDraftProjectSelection("environment:studio", [project], [makeScope([project])]),
    ).toEqual({ kind: "preserve" });
  });

  it("selects the only physical project when no project was explicitly selected", () => {
    const project = makeProject("studio");
    expect(resolveDraftProjectSelection(null, [project], [makeScope([project])])).toEqual({
      kind: "select",
      project,
    });
  });

  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("studio"), makeProject("studio-2"), makeProject("studio-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("keeps a missing explicit project unavailable instead of adopting the sole active scope", () => {
    const billing = makeProject("billing");
    expect(
      resolveDraftProjectSelection("environment:removed", [billing], [makeScope([billing])]),
    ).toEqual({ kind: "unavailable" });
    expect(resolveDraftProjectSelection(null, [billing], [makeScope([billing])])).toEqual({
      kind: "select",
      project: billing,
    });
  });
});

describe("filterProjectScopes", () => {
  const mac = makeProject("code", "mac", { title: "Desktop checkout" });
  const server = makeProject("remote-code", "server", { workspaceRoot: "/srv/remote-workspace" });
  const code = makeScope([mac, server]);
  const docs = { ...makeScope([makeProject("docs")]), key: "docs", title: "Documentation" };
  const scopes = [code, docs];

  it("keeps all projects for an empty or whitespace-only query", () => {
    expect(filterProjectScopes(scopes, "")).toBe(scopes);
    expect(filterProjectScopes(scopes, "  ")).toBe(scopes);
  });

  it("matches logical names and workspace names or paths without case sensitivity", () => {
    expect(filterProjectScopes(scopes, "  SpecWeave STUDIO ")).toEqual([code]);
    expect(filterProjectScopes(scopes, "DESKTOP")).toEqual([code]);
    expect(filterProjectScopes(scopes, "REMOTE-WORKSPACE")).toEqual([code]);
    expect(filterProjectScopes(scopes, "documentation")).toEqual([docs]);
    expect(filterProjectScopes(scopes, "missing-project")).toEqual([]);
  });

  it("preserves the whole logical project and preferred environment when a workspace matches", () => {
    const matches = filterProjectScopes(scopes, "REMOTE-WORKSPACE");
    expect(matches[0]).toBe(code);
    expect(getProjectScopeSelectionTarget(matches[0]!, EnvironmentId.make("mac"))).toBe(mac);
    expect(code.projects).toEqual([mac, server]);
  });
});

describe("new task destination eligibility", () => {
  it.each([{ archived: true }, { origin: "automated" as const }, { temporarySessionId: "check" }])(
    "does not retarget a draft to Billing when its matching App is excluded: %o",
    (settings) => {
      const current = makeProject("app-a", "a", { repositoryKey: "github.com/example/app" });
      const archivedApp = {
        ...makeProject("app-b", "b", { repositoryKey: "github.com/example/app" }),
        workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, ...settings },
      };
      const billing = makeProject("billing-b", "b", {
        repositoryKey: "github.com/example/billing",
      });
      const choices = newTaskDestinationProjects(
        [current, archivedApp, billing],
        current,
        () => null,
      );
      expect(choices).toEqual([current]);
      expect(
        resolveEnvironmentProjectMatch(
          choices.filter((p) => p.environmentId === billing.environmentId),
          current,
        ),
      ).toBeNull();
      expect(newTaskProjectUnavailableReason(archivedApp, () => null)).toMatch(
        /Choose an active project/,
      );
      expect(archivedApp.title).toBe("app-b");
    },
  );
  it("ranks a known repository above an earlier eligible weak basename match", () => {
    const selected = makeProject("app-a", "a", {
      workspaceRoot: "/work/app",
      repositoryKey: "github.com/example/app",
    });
    const unindexed = makeProject("unindexed-b", "b", { workspaceRoot: "/other/app" });
    const exact = makeProject("app-b", "b", {
      workspaceRoot: "/srv/app",
      repositoryKey: "github.com/example/app",
    });
    const eligible = newTaskDestinationProjects([unindexed, exact], selected, () => null);
    expect(eligible).toEqual([unindexed, exact]);
    expect(resolveEnvironmentProjectMatch(eligible, selected)).toBe(exact);
  });
  it("keeps the draft on its selected project after classification changes and exposes why Start is disabled", () => {
    const selected = makeProject("app", "a");
    expect(newTaskProjectUnavailableReason(selected, () => null)).toBeNull();
    const excluded = {
      ...selected,
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, archived: true },
    };
    expect(newTaskProjectUnavailableReason(excluded, () => null)).toBe(
      "This project is archived. Choose an active project to start this task.",
    );
    expect(newTaskProjectUnavailableReason(null, () => null)).toMatch(/Choose an active project/);
    expect(
      newTaskProjectUnavailableReason({ ...selected, workspaceRoot: "/scratch" }, () => "/scratch"),
    ).toBeNull();
  });
});

describe("missing native draft project recovery", () => {
  it("retains a resumed draft's last live context while blocking a new task there", () => {
    const app = makeProject("app", "a");
    const key = "a:app";
    expect(retainNewTaskProjectContext(key, app, null)).toBe(app);
    const retained = retainNewTaskProjectContext(key, undefined, app);
    expect(retained).toBe(app);
    expect(newTaskProjectUnavailableReason(retained, () => null, true)).toBe(
      "This project is no longer available. Choose an active project to start this task.",
    );
    const billing = makeProject("billing", "a");
    expect(resolveDraftProjectSelection(key, [billing], [makeScope([billing])])).toEqual({
      kind: "unavailable",
    });
    expect(retainNewTaskProjectContext("a:billing", billing, app)).toBe(billing);
    expect(retainNewTaskProjectContext("a:billing", undefined, app)).toBeNull();
    expect(retainNewTaskProjectContext(null, undefined, app)).toBeNull();
  });
});

describe("missing draft machine context", () => {
  it("keeps A/App on Desktop A when A loses its final project, with B an explicit replacement", () => {
    const appA = makeProject("app-a", "a", { repositoryKey: "github.com/example/app" });
    const appB = makeProject("app-b", "b", { repositoryKey: "github.com/example/app" });
    const labels: Record<string, string> = { a: "Desktop A", b: "Desktop B" };
    const before = resolveNewTaskEnvironment([appA, appB], appA.environmentId, (id) => labels[id]);
    const after = resolveNewTaskEnvironment([appB], appA.environmentId, (id) => labels[id]);
    expect(after).toEqual(before);
    expect(after).toEqual({ environmentId: appA.environmentId, environmentLabel: "Desktop A" });
    const retained = retainNewTaskProjectContext("a:app-a", undefined, appA);
    expect(retained?.environmentId).toBe(after.environmentId);
    expect(newTaskProjectUnavailableReason(retained, () => null, true)).toMatch(
      /no longer available/,
    );
    const destinations = newTaskDestinationProjects([appB], retained, () => null);
    // The sole replacement differs from current context, so opening the machine
    // picker and switching to B must reach the ranked retarget path.
    expect(destinations.some((p) => p.environmentId !== after.environmentId)).toBe(true);
    const replacement = resolveEnvironmentProjectMatch(destinations, retained);
    expect(replacement).toBe(appB);
    expect(
      resolveNewTaskEnvironment([appB], replacement!.environmentId, (id) => labels[id]),
    ).toEqual({
      environmentId: appB.environmentId,
      environmentLabel: "Desktop B",
    });
  });

  it("uses machine identity when its connection label is absent and defaults only blank context", () => {
    const appB = makeProject("app-b", "b");
    expect(resolveNewTaskEnvironment([appB], EnvironmentId.make("a"), () => undefined)).toEqual({
      environmentId: "a",
      environmentLabel: "a",
    });
    expect(resolveNewTaskEnvironment([appB], null, () => "Desktop B")).toEqual({
      environmentId: "b",
      environmentLabel: "Desktop B",
    });
    expect(resolveNewTaskEnvironment([], null, () => undefined)).toEqual({
      environmentId: null,
      environmentLabel: "Environment",
    });
  });
});
