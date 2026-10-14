import { describe, expect, it } from "vite-plus/test";
import {
  type ModelSelection,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ThreadId,
  type LogicalProject,
  type Project,
  type OrchestratorMcpMachineProvider,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
} from "@specweave-studio/contracts";

import {
  clampRuntimeMode,
  grantMachineStatus,
  type MatchableProject,
  matchRemoteProject,
  logicalProjectBindingMatch,
  matchLogicalRemoteProject,
  remoteWorkerLost,
  remoteWorkerWake,
  translateModel,
} from "./remoteWorkerMatching.ts";

const identity = (key: string, rootPath: string, origin?: string): RepositoryIdentity => ({
  canonicalKey: key,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${key}.git` },
  rootPath,
  ...(origin === undefined ? {} : { origin: { canonicalKey: origin } }),
});

const project = (
  id: string,
  workspaceRoot: string,
  repositoryIdentity: RepositoryIdentity | null = null,
): MatchableProject => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity,
});

const local = project(
  "local",
  "/Users/a/code/app",
  identity("github.com/acme/app", "/Users/a/code/app"),
);

describe("matchRemoteProject", () => {
  it("matches the same repository at the same place inside it", () => {
    expect(
      matchRemoteProject({
        local,
        remote: [
          project("other", "/home/b/other", identity("github.com/acme/other", "/home/b/other")),
          project("app", "/home/b/src/app", identity("github.com/acme/app", "/home/b/src/app")),
        ],
      }),
    ).toEqual({ match: "identity", projectId: "app", title: "app" });
  });

  it("keeps two packages of one monorepo apart", () => {
    const monoLocal = project(
      "web",
      "/Users/a/mono/apps/web",
      identity("github.com/acme/mono", "/Users/a/mono"),
    );
    const result = matchRemoteProject({
      local: monoLocal,
      remote: [
        project(
          "server",
          "/home/b/mono/apps/server",
          identity("github.com/acme/mono", "/home/b/mono"),
        ),
        project(
          "web-there",
          "/home/b/mono/apps/web/",
          identity("github.com/acme/mono", "/home/b/mono"),
        ),
      ],
    });
    expect(result).toEqual({ match: "identity", projectId: "web-there", title: "web-there" });
  });

  it("groups a fork by its own remote", () => {
    const fork = project(
      "fork",
      "/Users/a/fork",
      identity("github.com/up/app", "/Users/a/fork", "github.com/me/app"),
    );
    expect(
      matchRemoteProject({
        local: fork,
        remote: [project("upstream", "/b/app", identity("github.com/up/app", "/b/app"))],
      }).match,
    ).toBe("none");
  });

  it("reports several candidates as ambiguous", () => {
    const result = matchRemoteProject({
      local,
      remote: [
        project("one", "/b/one", identity("github.com/acme/app", "/b/one")),
        project("two", "/c/two", identity("github.com/acme/app", "/c/two")),
      ],
    });
    expect(result.match).toBe("ambiguous");
    expect(result.candidates?.map((candidate) => candidate.projectId)).toEqual(["one", "two"]);
  });

  it("uses a chosen id when it exists and is not another repository", () => {
    const remote = [
      project("chosen", "/b/chosen", null),
      project("wrong", "/b/wrong", identity("github.com/acme/other", "/b/wrong")),
    ];
    expect(matchRemoteProject({ local, remote, projectId: ProjectId.make("chosen") }).match).toBe(
      "configured",
    );
    expect(matchRemoteProject({ local, remote, projectId: ProjectId.make("wrong") }).match).toBe(
      "none",
    );
    expect(matchRemoteProject({ local, remote, projectId: ProjectId.make("gone") }).match).toBe(
      "none",
    );
  });

  it("cannot match a project without a repository identity", () => {
    expect(
      matchRemoteProject({ local: project("plain", "/x"), remote: [project("plain", "/x")] }).match,
    ).toBe("none");
  });
});

describe("logical project worker routing", () => {
  const environmentId = EnvironmentId.make("env-m1");
  const binding = {
    environmentId,
    projectId: ProjectId.make("admitted"),
    coordinatorThreadId: ThreadId.make("coordinator"),
  };
  const logical: LogicalProject = {
    id: "domain",
    title: "App",
    coordinatorId: "one-coordinator",
    members: [binding],
  };
  const boundProject = (overrides: Partial<Project> = {}): Project => ({
    ...project("admitted", "/work/app", identity("github.com/acme/app", "/work/app")),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-13T00:00:00Z",
    updatedAt: "2026-10-13T00:00:00Z",
    deletedAt: null,
    workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: logical },
    ...overrides,
  });

  it("rejects matching repositories and explicit IDs which were never admitted", () => {
    const unbound = { ...logical, members: [] };
    expect(
      matchLogicalRemoteProject({ logical: unbound, environmentId, remote: [boundProject()] })
        .match,
    ).toBe("none");
    expect(
      matchLogicalRemoteProject({
        logical,
        environmentId,
        projectId: ProjectId.make("other"),
        remote: [boundProject({ id: ProjectId.make("other") })],
      }).match,
    ).toBe("none");
  });

  it("accepts only a reciprocal logical binding and rejects deleted or foreign registrations", () => {
    expect(
      matchLogicalRemoteProject({ logical, environmentId, remote: [boundProject()] }),
    ).toMatchObject({ match: "configured", projectId: "admitted" });
    for (const remote of [
      boundProject({ deletedAt: "2026-10-13T00:01:00Z" }),
      boundProject({
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          logicalProject: { ...logical, id: "another-domain" },
        },
      }),
      boundProject({
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          logicalProject: { ...logical, members: [] },
        },
      }),
    ])
      expect(matchLogicalRemoteProject({ logical, environmentId, remote: [remote] }).match).toBe(
        "none",
      );
  });

  it("refuses to choose among repeat transfer bindings without an explicit target", () => {
    const another = {
      ...binding,
      projectId: ProjectId.make("second"),
      coordinatorThreadId: ThreadId.make("second-coordinator"),
    };
    const expanded = { ...logical, members: [binding, another] };
    expect(logicalProjectBindingMatch({ logical: expanded, environmentId }).match).toBe(
      "ambiguous",
    );
    expect(
      logicalProjectBindingMatch({
        logical: expanded,
        environmentId,
        projectId: binding.projectId,
      }),
    ).toMatchObject({ match: "configured", projectId: binding.projectId });
    expect(
      logicalProjectBindingMatch({
        logical: { ...logical, members: [binding, binding] },
        environmentId,
      }).match,
    ).toBe("configured");
    expect(
      logicalProjectBindingMatch({ logical, environmentId: EnvironmentId.make("another-machine") })
        .match,
    ).toBe("none");
  });
});

const provider = (
  id: string,
  driverKind: string,
  models: ReadonlyArray<string>,
): OrchestratorMcpMachineProvider => ({
  providerInstanceId: ProviderInstanceId.make(id),
  driverKind: ProviderDriverKind.make(driverKind),
  models,
  available: true,
});

describe("translateModel", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "medium" }],
  } as unknown as ModelSelection;

  it("keeps a selection whose instance offers the model there", () => {
    expect(
      translateModel({
        selection,
        driverKind: "codex",
        remote: [provider("codex", "codex", ["gpt-5.5"])],
      }),
    ).toEqual({ type: "same", modelSelection: selection });
  });

  it("moves to the one instance of the same kind that offers the model", () => {
    expect(
      translateModel({
        selection,
        driverKind: "codex",
        remote: [
          provider("codex-work", "codex", ["gpt-5.5"]),
          provider("claude", "claudeAgent", ["opus"]),
        ],
      }),
    ).toEqual({
      type: "translated",
      modelSelection: { ...selection, instanceId: "codex-work" },
    });
  });

  it("gives up when no single instance fits", () => {
    expect(
      translateModel({
        selection,
        driverKind: "codex",
        remote: [provider("a", "codex", ["gpt-5.5"]), provider("b", "codex", ["gpt-5.5"])],
      }).type,
    ).toBe("unavailable");
    expect(
      translateModel({
        selection,
        driverKind: "codex",
        remote: [provider("codex", "codex", ["other"])],
      }).type,
    ).toBe("unavailable");
  });
});

describe("clampRuntimeMode", () => {
  it("never starts above the machine's ceiling", () => {
    expect(
      clampRuntimeMode({ started: "full-access", requested: undefined, ceiling: "auto" }),
    ).toEqual({ ok: true, mode: "auto" });
    expect(
      clampRuntimeMode({ started: "approval-required", requested: undefined, ceiling: "auto" }),
    ).toEqual({ ok: true, mode: "approval-required" });
  });

  it("refuses an explicit request above the ceiling", () => {
    expect(
      clampRuntimeMode({ started: "full-access", requested: "full-access", ceiling: "auto" }),
    ).toEqual({ ok: false });
  });
});

describe("grantMachineStatus", () => {
  const workers = { access: null, expiresAt: null, renewable: false } as const;
  it("maps grant states and problems", () => {
    expect(grantMachineStatus({ ...workers, status: "allowed", problem: null })).toBe("ready");
    expect(grantMachineStatus({ ...workers, status: "not_allowed", problem: null })).toBe(
      "needs_grant",
    );
    expect(grantMachineStatus({ ...workers, status: "not_allowed", problem: "unsupported" })).toBe(
      "unsupported",
    );
    expect(grantMachineStatus({ ...workers, status: "revoked", problem: null })).toBe(
      "grant_revoked",
    );
  });
});

describe("remoteWorkerWake", () => {
  it("names the worker by its machine label and link, and keeps the title inside its link", () => {
    const wake = remoteWorkerWake({
      title: "Fix [flaky] test",
      threadRef: "studio://thread/env-m1/t1",
      machineLabel: "Studio B",
      status: "completed",
    });
    expect(wake.text).toBe(
      'Remote worker [Fix flaky test](studio://thread/env-m1/t1) on Studio B finished: completed. Read it with studio_thread_read {threadId:"studio://thread/env-m1/t1"}.',
    );
    // People see a notice, never the model-facing text with its ids.
    expect(wake.notification).toEqual({
      source: { kind: "background_task" },
      outcome: "completed",
      summary: "[Fix flaky test](studio://thread/env-m1/t1) on Studio B reported back.",
    });
    expect(wake.text).not.toContain('m1"');
  });

  it("reports a failed or stopped run as such", () => {
    const base = { title: "T", threadRef: "studio://thread/e/t", machineLabel: "B" };
    expect(remoteWorkerWake({ ...base, status: "failed" }).notification.outcome).toBe("failed");
    expect(remoteWorkerWake({ ...base, status: "interrupted" }).notification.outcome).toBe(
      "cancelled",
    );
    expect(remoteWorkerLost(base).notification.summary).toBe(
      "Lost contact with [T](studio://thread/e/t) on B.",
    );
  });
});
