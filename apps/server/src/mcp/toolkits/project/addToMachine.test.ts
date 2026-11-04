import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type LogicalProjectMember,
  ProjectLinkError,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { unscopedGrant, type WorkOrigin } from "../../../fleet/workGrantPolicy.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectLink from "../../../project/ProjectLink.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  credentialHint,
  destinationFor,
  isCredentialFailure,
  repositoryNameOf,
} from "./addToMachine.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const projectId = ProjectId.make("project");
const callerId = ThreadId.make("coordinator");
const providerInstanceId = ProviderInstanceId.make("codex");
const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };

// A fork: the locator is the upstream, origin is the fork another machine clones.
const forkIdentity = {
  canonicalKey: "github.com/example-upstream/widgets",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "git@github.com:example-upstream/widgets.git",
  },
  origin: {
    canonicalKey: "github.com/example-fork/widgets",
    remoteUrl: "git@github.com:example-fork/widgets.git",
  },
} as unknown as RepositoryIdentity;

interface RemoteCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

const setup = (
  options: {
    readonly outsideClient?: boolean;
    readonly clientAccess?: "read-only" | "full-access";
    /** Another machine's work started the calling thread here. */
    readonly origin?: WorkOrigin;
    /** The other machine refuses the clone with this message. */
    readonly cloneFails?: {
      readonly code: OrchestratorMcpFailure["code"];
      readonly message: string;
    };
    /** The other machine runs a version without studio_project_link_accept. */
    readonly noLinkAccept?: boolean;
    /** This machine's project was made by a check. */
    readonly automated?: boolean;
    /** Projects M1 already lists; the project here then has a known place in its repository. */
    readonly m1Projects?: ReadonlyArray<Record<string, unknown>>;
    readonly m1CopyThreads?: ReadonlyArray<Record<string, unknown>>;
    readonly listFails?: boolean;
    readonly sharedHere?: boolean;
    /** M1 runs a build that ignores includeArchived and does not echo it. */
    readonly olderM1?: boolean;
    /** The shared project here already lists a member on M1. */
    readonly m1MemberHere?: boolean;
  } = {},
) => {
  const caller = {
    id: callerId,
    projectId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
  const calls: RemoteCall[] = [];
  const project = projectFixture(projectId, {
    title: "Widgets",
    workspaceRoot: "/Users/example/Projects/widgets",
    repositoryIdentity:
      options.m1Projects === undefined
        ? forkIdentity
        : ({ ...forkIdentity, rootPath: "/Users/example/Projects/widgets" } as RepositoryIdentity),
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      coordinatorThreadId: callerId,
      ...(options.automated ? { origin: "automated" } : {}),
      ...(options.sharedHere
        ? {
            logicalProject: {
              id: "logical:widgets",
              title: "Widgets",
              coordinatorId: "coordinator:logical:widgets",
              members: [
                {
                  environmentId: EnvironmentId.make("env-m4"),
                  projectId,
                  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
                },
                ...(options.m1MemberHere
                  ? [
                      {
                        environmentId: EnvironmentId.make("env-m1"),
                        projectId: ProjectId.make("m1-gone"),
                        coordinatorThreadId: ThreadId.make("project-coordinator:m1-gone"),
                      },
                    ]
                  : []),
              ],
            },
          }
        : {}),
    },
  });
  const kept: LogicalProjectMember = {
    environmentId: EnvironmentId.make("env-m4"),
    projectId,
    coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
  };
  const joined: LogicalProjectMember = {
    environmentId: M1.environmentId,
    projectId: ProjectId.make("remote-widgets"),
    coordinatorThreadId: ThreadId.make("project-coordinator:remote-widgets"),
  };
  const logicalProject = {
    id: "logical:widgets",
    title: "Widgets",
    coordinatorId: "coordinator:logical:widgets",
    members: [kept],
  };
  const linkCalls: Array<{ readonly step: string; readonly input: unknown }> = [];
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" })
        : target === "m1" || target === "M1"
          ? Effect.succeed({ kind: "remote", machine: M1 })
          : Effect.fail(
              new OrchestratorMcpFailure({ code: "unknown_machine", message: "No such machine." }),
            ),
    proxy: (input) =>
      Effect.suspend((): Effect.Effect<Record<string, unknown>, OrchestratorMcpFailure> => {
        calls.push({ tool: input.tool, arguments: input.arguments });
        if (input.tool === "studio_project_list")
          return options.listFails
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "M1 is offline.",
                }),
              )
            : Effect.succeed({ projects: options.m1Projects ?? [], nextCursor: null });
        if (input.tool === "studio_thread_list")
          return Effect.succeed({
            projectId: input.arguments.projectId,
            currentThreadId: null,
            threads: options.m1CopyThreads ?? [],
            nextCursor: null,
            total: (options.m1CopyThreads ?? []).length,
            ...(options.olderM1 ? {} : { includeArchived: true }),
          });
        if (input.tool === "studio_project_clone") {
          if (options.cloneFails !== undefined)
            return Effect.fail(
              new OrchestratorMcpFailure({
                code: options.cloneFails.code,
                message: `M1: ${options.cloneFails.message}`,
              }),
            );
          return Effect.succeed({
            cwd: "/home/example/Projects/widgets",
            remoteUrl: String(input.arguments.remoteUrl),
            repository: null,
            machine: M1,
          });
        }
        if (input.tool === "studio_project_create")
          return Effect.succeed({
            ...projectFixture(ProjectId.make("remote-widgets"), {
              title: String(input.arguments.title),
              workspaceRoot: String(input.arguments.workspaceRoot),
            }),
            machine: M1,
          });
        if (input.tool === "studio_project_link_accept") {
          if (options.noLinkAccept)
            return Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "M1: Tool studio_project_link_accept not found.",
              }),
            );
          return Effect.succeed({
            operationId: input.arguments.operationId,
            member: joined,
            logicalProject: { ...logicalProject, members: [kept, joined] },
            coordinatorBinding: {
              epoch: 0,
              state: "transferred",
              operationId: input.arguments.operationId,
              successor: kept,
            },
            replayed: false,
          });
        }
        return Effect.die(`unexpected tool ${input.tool}`);
      }),
  };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...WorkGrants.WorkGrants.defaultValue(),
      enabled: true,
      originOf: () => Effect.succeed(options.origin),
      forCoordinator: (id) => Effect.succeed(unscopedGrant(id)),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: options.outsideClient
        ? undefined
        : { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: options.outsideClient
        ? {
            sessionId: "client",
            label: "Outside agent",
            access: options.clientAccess ?? "full-access",
          }
        : undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Project.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(ProjectLink.ProjectLink)({
      prepare: (input) => {
        linkCalls.push({ step: "prepare", input });
        return Effect.succeed({
          operationId: input.operationId,
          kept,
          logicalProject,
          coordinatorBinding: { epoch: 0, state: "active" as const },
          fingerprint: {
            root: "repository" as const,
            repositories: [],
            skippedLinks: 0,
            truncated: false,
          },
          adopted: false,
        });
      },
      accept: () => Effect.fail(new ProjectLinkError({ code: "invalid" })),
      commit: (input) => {
        linkCalls.push({ step: "commit", input });
        return Effect.succeed({
          operationId: input.operationId,
          logicalProject: { ...logicalProject, members: [kept, input.joining] },
          notesWritten: 0,
          replayed: false,
        });
      },
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-add-to-machine-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const call = (tool: string, params: Record<string, unknown>) =>
    ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle(tool as "studio_project_add_to_machine", params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
    );
  const add = (params: Record<string, unknown>) => call("studio_project_add_to_machine", params);
  return { add, call, calls, linkCalls, joined };
};

describe("studio_project_add_to_machine", () => {
  it.effect("clones a project's fork there, registers it and says how to launch", () => {
    const { add, calls } = setup();
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId, branch: "feature/login" });
      expect(calls).toEqual([
        {
          tool: "studio_project_clone",
          arguments: {
            remoteUrl: "git@github.com:example-fork/widgets.git",
            destinationPath: "~/Projects/widgets",
          },
        },
        {
          tool: "studio_project_create",
          arguments: { title: "Widgets", workspaceRoot: "/home/example/Projects/widgets" },
        },
        {
          tool: "studio_project_link_accept",
          arguments: expect.objectContaining({
            projectId: "remote-widgets",
            logicalProject: expect.objectContaining({ id: "logical:widgets" }),
          }),
        },
      ]);
      expect(result).toMatchObject({
        machine: M1,
        projectId: "remote-widgets",
        title: "Widgets",
        workspaceRoot: "/home/example/Projects/widgets",
        remoteUrl: "git@github.com:example-fork/widgets.git",
        branch: "feature/login",
        linked: true,
      });
      expect(String(result.next)).toContain('machineProjectId:"remote-widgets"');
      expect(String(result.next)).toContain('baseRef:"feature/login"');
    });
  });

  it.effect("links the copy to the project here, so both machines list it once", () => {
    const { add, calls, linkCalls, joined } = setup();
    return Effect.gen(function* () {
      yield* add({ machine: "M1", projectId });
      const operationId = (calls[2]?.arguments as { operationId: string }).operationId;
      expect(linkCalls).toEqual([
        {
          step: "prepare",
          input: {
            operationId,
            projectId,
            joining: {
              environmentId: M1.environmentId,
              projectId: "remote-widgets",
              coordinatorThreadId: "project-coordinator:remote-widgets",
            },
          },
        },
        { step: "commit", input: { operationId, projectId, joining: joined, notes: [] } },
      ]);
    });
  });

  it.effect("keeps the copy and says how to link it when that machine cannot", () => {
    const { add, linkCalls } = setup({ noLinkAccept: true });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(result).toMatchObject({ projectId: "remote-widgets", linked: false });
      expect(String(result.linkProblem)).toContain("Tool studio_project_link_accept not found");
      expect(String(result.linkProblem)).toContain("Link…");
      expect(linkCalls.map((entry) => entry.step)).toEqual(["prepare"]);
    });
  });

  it.effect("registers a copy of a check's project as automated there", () => {
    const { add, calls } = setup({ automated: true });
    return Effect.gen(function* () {
      yield* add({ machine: "M1", projectId });
      expect(calls[1]).toEqual({
        tool: "studio_project_create",
        arguments: {
          title: "Widgets",
          workspaceRoot: "/home/example/Projects/widgets",
          origin: "automated",
        },
      });
    });
  });

  it.effect("links only for another machine's work, never for an agent here", () => {
    const { call } = setup();
    const relayed = setup({
      origin: {
        coordinatorEnvironmentId: EnvironmentId.make("env-m3"),
        path: [EnvironmentId.make("env-m3")],
        hops: 1,
      } as unknown as WorkOrigin,
    });
    return Effect.gen(function* () {
      const params = {
        operationId: "00000000-0000-4000-8000-000000000000",
        projectId: "remote-widgets",
        kept: {
          environmentId: "env-m4",
          projectId: "project",
          coordinatorThreadId: "project-coordinator:project",
        },
        logicalProject: {
          id: "logical:widgets",
          title: "Widgets",
          coordinatorId: "coordinator:logical:widgets",
          members: [],
        },
        coordinatorBinding: { epoch: 0, state: "active" },
        keptFingerprint: {
          root: "repository",
          repositories: [],
          skippedLinks: 0,
          truncated: false,
        },
      };
      expect(yield* call("studio_project_link_accept", params)).toMatchObject({
        code: "capability_denied",
      });
      // An agent that other machine's work started here is refused too.
      expect(yield* relayed.call("studio_project_link_accept", params)).toMatchObject({
        code: "capability_denied",
      });
    });
  });

  it.effect("clones a URL for an outside client, with its protocol and folder", () => {
    const { add, calls } = setup({ outsideClient: true });
    return Effect.gen(function* () {
      const result = yield* add({
        machine: "m1",
        cloneUrl: "https://github.com/example/gadgets.git",
        protocol: "https",
      });
      expect(calls[0]).toEqual({
        tool: "studio_project_clone",
        arguments: {
          remoteUrl: "https://github.com/example/gadgets.git",
          destinationPath: "~/gadgets",
          protocol: "https",
        },
      });
      expect(calls[1]?.arguments).toMatchObject({ title: "gadgets" });
      expect(result).toMatchObject({ projectId: "remote-widgets" });
    });
  });

  it.effect("adds git's credential hint when the machine cannot authenticate", () => {
    const { add, calls } = setup({
      cloneFails: {
        code: "orchestration_error",
        message:
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      },
    });
    return Effect.gen(function* () {
      const refused = yield* add({ machine: "M1", projectId });
      expect(refused).toMatchObject({ code: "orchestration_error" });
      expect(String(refused.message)).toContain("gh auth setup-git");
      expect(String(refused.message)).toContain(credentialHint("M1"));
      // Nothing is registered after a failed clone.
      expect(calls.map((call) => call.tool)).toEqual(["studio_project_clone"]);
    });
  });

  it.effect("passes the machine's grant refusal through unchanged", () => {
    const message =
      "M1: This machine lets M4's work use only some of its projects, so it cannot clone repositories here.";
    const { add } = setup({
      cloneFails: { code: "outside_grant_scope", message: message.slice(4) },
    });
    return Effect.gen(function* () {
      const refused = yield* add({ machine: "M1", projectId });
      expect(refused).toMatchObject({ code: "outside_grant_scope", message });
    });
  });

  it.effect("refuses this machine, both or neither source, and unknown projects", () => {
    const { add, calls } = setup();
    return Effect.gen(function* () {
      expect(yield* add({ machine: "local", projectId })).toMatchObject({
        code: "invalid_request",
      });
      expect(
        yield* add({ machine: "M1", projectId, cloneUrl: "https://github.com/example/x.git" }),
      ).toMatchObject({ code: "invalid_request" });
      expect(yield* add({ machine: "M1" })).toMatchObject({ code: "invalid_request" });
      expect(yield* add({ machine: "M1", projectId: ProjectId.make("missing") })).toMatchObject({
        code: "invalid_request",
        message: "The project was not found.",
      });
      expect(calls).toEqual([]);
    });
  });

  it.effect("refuses read-only clients and work another machine started here", () => {
    const readOnly = setup({ outsideClient: true, clientAccess: "read-only" });
    const relayed = setup({
      origin: {
        coordinatorEnvironmentId: EnvironmentId.make("env-m3"),
        path: [EnvironmentId.make("env-m3")],
        hops: 1,
      } as unknown as WorkOrigin,
    });
    return Effect.gen(function* () {
      expect(yield* readOnly.add({ machine: "M1", projectId })).toMatchObject({
        code: "capability_denied",
      });
      expect(yield* relayed.add({ machine: "M1", projectId })).toMatchObject({
        code: "capability_denied",
      });
      expect([...readOnly.calls, ...relayed.calls]).toEqual([]);
    });
  });
});

describe("add-to-machine helpers", () => {
  it("mirrors the folder relative to home, else uses its name under home", () => {
    expect(destinationFor("/Users/example/Projects/widgets/")).toBe("~/Projects/widgets");
    expect(destinationFor("/home/example/code/app")).toBe("~/code/app");
    expect(destinationFor("/srv/repos/app")).toBe("~/app");
    expect(destinationFor("~/work/app")).toBe("~/work/app");
  });

  it("names the repository from any clone URL form", () => {
    expect(repositoryNameOf("git@github.com:example/widgets.git")).toBe("widgets");
    expect(repositoryNameOf("https://github.com/example/widgets")).toBe("widgets");
    expect(repositoryNameOf("ssh://git@host:2222/example/widgets.git/")).toBe("widgets");
  });

  it("recognises git's credential failures and nothing else", () => {
    for (const message of [
      "remote: Repository not found.",
      "git@github.com: Permission denied (publickey).",
      "fatal: Authentication failed for 'https://github.com/example/x.git/'",
      "Host key verification failed.",
    ])
      expect(isCredentialFailure(message), message).toBe(true);
    expect(isCredentialFailure("fatal: destination path 'x' already exists")).toBe(false);
  });

  const m1Widgets = (id: string) =>
    projectFixture(ProjectId.make(id), {
      title: "widgets",
      workspaceRoot: "/home/example/Projects/widgets",
      repositoryIdentity: {
        ...forkIdentity,
        rootPath: "/home/example/Projects/widgets",
      } as RepositoryIdentity,
    });

  it.effect("links the repository M1 already has instead of cloning a second copy", () => {
    const { add, calls, linkCalls } = setup({ m1Projects: [m1Widgets("m1-widgets")] });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(calls.map((entry) => entry.tool)).toEqual([
        "studio_project_list",
        "studio_thread_list",
        "studio_project_link_accept",
      ]);
      expect(linkCalls.map((entry) => entry.step)).toEqual(["prepare", "commit"]);
      expect(result).toMatchObject({
        projectId: "m1-widgets",
        workspaceRoot: "/home/example/Projects/widgets",
        linked: true,
        existingCopy: true,
      });
      expect(String(result.next)).toContain('machineProjectId:"m1-widgets"');
    });
  });

  it.effect("leaves a copy with threads of its own for the person to link", () => {
    const { add, calls, linkCalls } = setup({
      m1Projects: [m1Widgets("m1-widgets")],
      m1CopyThreads: [{ threadId: "thread-on-m1" }],
    });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(calls.map((entry) => entry.tool)).toEqual([
        "studio_project_list",
        "studio_thread_list",
      ]);
      expect(calls[1]?.arguments).toMatchObject({
        projectId: "m1-widgets",
        includeArchived: true,
        includeSubagents: true,
      });
      expect(linkCalls).toEqual([]);
      expect(result).toMatchObject({ projectId: "m1-widgets", linked: false, existingCopy: true });
      expect(String(result.linkProblem)).toContain("Link…");
    });
  });

  it.effect("reports a failed search for a copy instead of cloning a second one", () => {
    const { add, calls } = setup({ m1Projects: [], listFails: true });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(result).toMatchObject({ code: "invalid_request" });
      expect(String(result.message)).toContain("M1 is offline.");
      expect(calls.map((entry) => entry.tool)).toEqual(["studio_project_list"]);
    });
  });

  it.effect("finishes a link whose last step here did not run", () => {
    const halfLinked = projectFixture(ProjectId.make("m1-widgets"), {
      title: "widgets",
      workspaceRoot: "/home/example/Projects/widgets",
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        logicalProject: {
          id: "logical:widgets",
          title: "Widgets",
          coordinatorId: "coordinator:logical:widgets",
          members: [
            {
              environmentId: EnvironmentId.make("env-m4"),
              projectId,
              coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
            },
            {
              environmentId: M1.environmentId,
              projectId: ProjectId.make("m1-widgets"),
              coordinatorThreadId: ThreadId.make("project-coordinator:m1-widgets"),
            },
          ],
        },
      },
    });
    const { add, calls, linkCalls } = setup({
      m1Projects: [halfLinked],
      m1CopyThreads: [{ threadId: "thread-on-m1" }],
      sharedHere: true,
    });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(calls.map((entry) => entry.tool)).toEqual([
        "studio_project_list",
        "studio_project_link_accept",
      ]);
      expect(linkCalls.map((entry) => entry.step)).toEqual(["prepare", "commit"]);
      expect(result).toMatchObject({ projectId: "m1-widgets", linked: true, existingCopy: true });
    });
  });

  it.effect("never links a copy someone unlinked, nor one an older M1 cannot vouch for", () => {
    const unlinked = setup({
      m1Projects: [
        {
          ...m1Widgets("m1-widgets"),
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            coordinatorBinding: { epoch: 0, state: "active", operationId: "unlink-1" },
          },
        },
      ],
    });
    const older = setup({ m1Projects: [m1Widgets("m1-widgets")], olderM1: true });
    return Effect.gen(function* () {
      yield* unlinked.add({ machine: "M1", projectId });
      // It clones a fresh copy and links that one; the unlinked copy stays as it is.
      expect(unlinked.calls.map((entry) => entry.tool)).toContain("studio_project_clone");
      expect(
        unlinked.calls.filter(
          (entry) =>
            entry.tool === "studio_project_link_accept" &&
            entry.arguments.projectId === "m1-widgets",
        ),
      ).toEqual([]);
      const result = yield* older.add({ machine: "M1", projectId });
      expect(older.linkCalls).toEqual([]);
      expect(result).toMatchObject({ projectId: "m1-widgets", linked: false, existingCopy: true });
    });
  });

  it.effect("refuses to add another copy where this project already names one", () => {
    const { add, calls } = setup({
      m1Projects: [m1Widgets("m1-widgets")],
      sharedHere: true,
      m1MemberHere: true,
    });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(result).toMatchObject({ code: "invalid_request" });
      expect(String(result.message)).toContain("m1-gone");
      expect(calls).toEqual([]);
    });
  });

  it.effect("asks which copy to link when M1 has several, and clones none", () => {
    const { add, calls } = setup({ m1Projects: [m1Widgets("m1-a"), m1Widgets("m1-b")] });
    return Effect.gen(function* () {
      const result = yield* add({ machine: "M1", projectId });
      expect(result).toMatchObject({ code: "invalid_request" });
      expect(String(result.message)).toContain("m1-a");
      expect(String(result.message)).toContain("destinationPath");
      expect(calls.map((entry) => entry.tool)).toEqual(["studio_project_list"]);
    });
  });

  it.effect("still clones when M1 has no copy of the repository", () => {
    const { add, calls } = setup({ m1Projects: [] });
    return Effect.gen(function* () {
      yield* add({ machine: "M1", projectId });
      expect(calls.map((entry) => entry.tool)).toEqual([
        "studio_project_list",
        "studio_project_clone",
        "studio_project_create",
        "studio_project_link_accept",
      ]);
    });
  });
});
