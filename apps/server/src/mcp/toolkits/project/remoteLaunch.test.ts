import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { unscopedGrant, type WorkOrigin } from "../../../fleet/workGrantPolicy.ts";
import * as ServerConfig from "../../../config.ts";
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
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";
import { PERSONAL_ASSISTANT_PRIVATE_MESSAGE } from "@specweave-studio/shared/personalAssistant";

const projectId = ProjectId.make("project");
const callerId = ThreadId.make("coordinator");
const providerInstanceId = ProviderInstanceId.make("codex");
const workerModel = { instanceId: providerInstanceId, model: "gpt-5.5" } as ModelSelection;
const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };
const M3 = { id: "m3", label: "M3", environmentId: EnvironmentId.make("env-m3") };
const listEntry = (id: "local" | "m1" | "m3") => ({
  machineId: id,
  environmentId:
    id === "local"
      ? EnvironmentId.make("env-m4")
      : id === "m1"
        ? M1.environmentId
        : M3.environmentId,
  projectId: null,
});
const codeProjectId = ProjectId.make("example-code");
const missingProjectId = ProjectId.make("missing");

const setup = (
  options: {
    readonly workerMachine?: boolean;
    /** The project's ordered worker machine list. */
    readonly workerMachines?: ReadonlyArray<"local" | "m1" | "m3">;
    /** Only these machines refuse the launch (with `remoteFails`, or machine_unreachable). */
    readonly failingMachines?: ReadonlyArray<string>;
    readonly outsideClient?: boolean;
    /** The outside client's approved access, full access unless given. */
    readonly clientAccess?: "read-only" | "approval-required" | "auto" | "full-access";
    /** The worker machine was saved for another environment than "m1" has now. */
    readonly staleEnvironment?: boolean;
    /** The machine's grant lowered the caller's mode to this one. */
    readonly grantedRuntimeMode?: "approval-required" | "auto-accept-edits";
    /** Another machine's work started the calling thread here. */
    readonly origin?: WorkOrigin;
    /** Whose machine the origin is, as this machine's grant records it (default the owner's). */
    readonly originOwner?: "self" | "other";
    /** The other machine refuses or loses the launch with this code. */
    readonly remoteFails?: OrchestratorMcpFailure["code"];
    /** The caller's project is this machine's personal assistant. */
    readonly personal?: boolean;
    /** The calling thread is a scratch chat here, outside every project. */
    readonly callerInScratch?: boolean;
    /**
     * The project is shared (M4 only so far) and M1 holds these projects; the launch
     * there is refused until one of them is linked into the shared project.
     */
    readonly sharedWithCopiesOnM1?: ReadonlyArray<Record<string, unknown>>;
    /** Threads M1's copy already has; none unless set. */
    readonly m1CopyThreads?: ReadonlyArray<Record<string, unknown>>;
    /** The shared project still lists an M1 member that M1 no longer has (unlinked there). */
    readonly staleM1Member?: boolean;
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
  const remoteLaunches: RemoteWorkers.RemoteLaunchInput[] = [];
  const proxied: string[] = [];
  const linkSteps: string[] = [];
  let linkedCopy: string | null = null;
  const kept = {
    environmentId: EnvironmentId.make("env-m4"),
    projectId,
    coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
  };
  const sharedIdentity = {
    canonicalKey: "github.com/example/widgets",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/widgets.git",
    },
    rootPath: "/Users/example/widgets",
  } as const;
  const logicalProject = {
    id: "logical:widgets",
    title: "Widgets",
    coordinatorId: "coordinator:logical:widgets",
    members: options.staleM1Member
      ? [
          kept,
          {
            environmentId: M1.environmentId,
            projectId: ProjectId.make("m1-widgets"),
            coordinatorThreadId: ThreadId.make("project-coordinator:m1-widgets"),
          },
        ]
      : [kept],
  };
  const localLaunches: ThreadLaunch.ThreadLaunchInput[] = [];
  const project = projectFixture(projectId, {
    defaultModelSelection: workerModel,
    ...(options.personal
      ? { title: "Example Household", workspaceRoot: "/fixtures/example-household" }
      : {}),
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      ...(options.personal ? { kind: "personal" as const } : {}),
      coordinatorThreadId: callerId,
      ...(options.workerMachine
        ? {
            workerMachine: {
              machineId: "m1",
              environmentId: options.staleEnvironment
                ? EnvironmentId.make("env-old")
                : M1.environmentId,
              projectId: null,
            },
          }
        : {}),
      ...(options.workerMachines ? { workerMachines: options.workerMachines.map(listEntry) } : {}),
      ...(options.sharedWithCopiesOnM1 ? { logicalProject } : {}),
    },
    ...(options.sharedWithCopiesOnM1
      ? { workspaceRoot: "/Users/example/widgets", repositoryIdentity: sharedIdentity as never }
      : {}),
  });
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" })
        : target === "m1" || target === "M1"
          ? Effect.succeed({ kind: "remote", machine: M1 })
          : target === "m3" || target === "M3"
            ? Effect.succeed({ kind: "remote", machine: M3 })
            : Effect.die("unexpected machine"),
    launch: (input) =>
      Effect.suspend(() => {
        remoteLaunches.push(input);
        if (options.sharedWithCopiesOnM1 !== undefined) {
          const members = input.localProject?.workspaceSettings?.logicalProject?.members ?? [];
          if (options.staleM1Member)
            return Effect.fail(
              new OrchestratorMcpFailure({
                code: "project_unavailable_on_machine",
                message: "The destination project no longer belongs to this logical project.",
              }),
            );
          if (!members.some((member) => member.environmentId === M1.environmentId))
            return Effect.fail(
              new OrchestratorMcpFailure({
                code: "project_unavailable_on_machine",
                message: "M1: This logical project has no execution binding on this machine.",
              }),
            );
        }
        const failing =
          options.failingMachines === undefined
            ? options.remoteFails !== undefined
            : options.failingMachines.includes(input.machine.id);
        if (failing) {
          const code = options.remoteFails ?? "machine_unreachable";
          return Effect.fail(
            new OrchestratorMcpFailure({ code, message: `${input.machine.label}: ${code}` }),
          );
        }
        return Effect.succeed({
          threadId: ThreadId.make("b-thread"),
          projectId: ProjectId.make("remote-project"),
          modelSelection: workerModel,
          runId: RunId.make("b-run"),
          status: "queued" as const,
          machine: input.machine,
          threadRef: "studio://thread/env-m1/b-thread",
          threadLink: "[Fix CI](studio://thread/env-m1/b-thread)",
          reportsBack: input.reportBack,
          ...(linkedCopy === null ? {} : { projectId: ProjectId.make(linkedCopy) }),
          ...(options.grantedRuntimeMode === undefined
            ? { runtimeMode: input.runtimeMode }
            : {
                runtimeMode: options.grantedRuntimeMode,
                runtimeModeLoweredFrom: input.runtimeMode,
              }),
        });
      }),
  };
  const proxy: RemoteWorkers.RemoteWorkersShape["proxy"] = (input) =>
    Effect.suspend((): Effect.Effect<Record<string, unknown>, OrchestratorMcpFailure> => {
      proxied.push(input.tool);
      if (input.tool === "studio_project_list")
        return Effect.succeed({ projects: options.sharedWithCopiesOnM1 ?? [], nextCursor: null });
      if (input.tool === "studio_thread_list")
        return Effect.succeed({
          projectId: input.arguments.projectId,
          currentThreadId: null,
          threads: options.m1CopyThreads ?? [],
          nextCursor: null,
          total: (options.m1CopyThreads ?? []).length,
          includeArchived: true,
        });
      if (input.tool === "studio_project_link_accept") {
        const joined = {
          environmentId: M1.environmentId,
          projectId: ProjectId.make(String(input.arguments.projectId)),
          coordinatorThreadId: ThreadId.make(`project-coordinator:${input.arguments.projectId}`),
        };
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
    });
  const linkedProject = () =>
    linkedCopy === null
      ? project
      : {
          ...project,
          workspaceSettings: {
            ...project.workspaceSettings!,
            logicalProject: {
              ...logicalProject,
              members: [
                kept,
                {
                  environmentId: M1.environmentId,
                  projectId: ProjectId.make(linkedCopy),
                  coordinatorThreadId: ThreadId.make(`project-coordinator:${linkedCopy}`),
                },
              ],
            },
          },
        };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(RemoteWorkers.RemoteWorkers, { ...remote, proxy }),
    Layer.mock(ProjectLink.ProjectLink)({
      prepare: (input) => {
        linkSteps.push(`prepare:${input.joining.projectId}`);
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
      commit: (input) => {
        linkSteps.push(`commit:${input.joining.projectId}`);
        linkedCopy = input.joining.projectId;
        return Effect.succeed({
          operationId: input.operationId,
          logicalProject: { ...logicalProject, members: [kept, input.joining] },
          notesWritten: 0,
          replayed: false,
        });
      },
    }),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...WorkGrants.WorkGrants.defaultValue(),
      enabled: true,
      originOf: () => Effect.succeed(options.origin),
      forCoordinator: (id) =>
        Effect.succeed({ ...unscopedGrant(id), owner: options.originOwner ?? "self" }),
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
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        localLaunches.push(input);
        return Effect.succeed({
          threadId: input.threadId,
          projection: {
            thread: { id: input.threadId, projectId, modelSelection: input.modelSelection },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === missingProjectId
            ? Option.none()
            : Option.some(
                id === codeProjectId
                  ? projectFixture(codeProjectId, {
                      title: "Example Code",
                      defaultModelSelection: workerModel,
                      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "code" },
                    })
                  : linkedProject(),
              ),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratch: (id) => Effect.succeed(options.callerInScratch === true && id === projectId),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-remote-launch-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const launch = (params: Record<string, unknown>) =>
    ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("studio_thread_launch", params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as Record<string, unknown>),
    );
  /** What the calling agent actually receives: the encoded tool result. */
  const launchEncoded = (params: Record<string, unknown>) =>
    ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("studio_thread_launch", params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies)),
      ),
      Effect.map((results) => results.at(-1)?.encodedResult as Record<string, unknown>),
    );
  return { launch, launchEncoded, remoteLaunches, localLaunches, proxied, linkSteps };
};

it.effect(
  "starts a thread on the named machine with the caller's modes and inherited model",
  () => {
    const { launch, remoteLaunches, localLaunches } = setup();
    return Effect.gen(function* () {
      const result = yield* launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
      expect(result).toMatchObject({
        threadId: "b-thread",
        projectId: "remote-project",
        machine: M1,
        threadRef: "studio://thread/env-m1/b-thread",
        reportsBack: true,
      });
      expect(localLaunches).toEqual([]);
      expect(remoteLaunches).toHaveLength(1);
      expect(remoteLaunches[0]).toMatchObject({
        machine: M1,
        callerThreadId: callerId,
        originHint: { parentThreadId: callerId },
        title: "Fix CI",
        message: "Fix it",
        runtimeMode: "full-access",
        requestedRuntimeMode: undefined,
        // The coordinator's workers inherit the project's worker model, not its own.
        inheritedModelSelection: workerModel,
        reportBack: true,
      });
    });
  },
);

it.effect("tells the coordinator which mode the remote worker runs on and what it lowered", () => {
  const lowered = setup({ grantedRuntimeMode: "approval-required" });
  const kept = setup();
  return Effect.gen(function* () {
    const result = yield* lowered.launchEncoded({
      title: "Fix CI",
      message: "Fix it",
      machine: "M1",
    });
    expect(result).toMatchObject({
      threadId: "b-thread",
      runtimeMode: "approval-required",
      runtimeModeLoweredFrom: "full-access",
    });
    const same = yield* kept.launchEncoded({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(same).toMatchObject({ runtimeMode: "full-access" });
    expect(same).not.toHaveProperty("runtimeModeLoweredFrom");
  });
});

it.effect("sends a coordinator's workers to the project's worker machine unless told local", () => {
  const { launch, remoteLaunches, localLaunches } = setup({ workerMachine: true });
  return Effect.gen(function* () {
    yield* launch({ title: "Fix CI", message: "Fix it" });
    expect(remoteLaunches).toHaveLength(1);
    yield* launch({ title: "Fix CI here", message: "Fix it", machine: "local" });
    expect(localLaunches).toHaveLength(1);
    expect(remoteLaunches).toHaveLength(1);
  });
});

it.effect("never sends workers to a machine other than the one chosen, nor scratch there", () => {
  const moved = setup({ workerMachine: true, staleEnvironment: true });
  const routed = setup({ workerMachine: true });
  return Effect.gen(function* () {
    // The re-pointed entry is skipped with its reason; the thread runs here, not there.
    const result = yield* moved.launch({ title: "Fix CI", message: "Fix it" });
    expect(result).toMatchObject({
      placement: {
        machine: "this machine",
        reason: "this_machine",
        skipped: [{ machine: "M1", reason: expect.stringContaining("different machine") }],
      },
    });
    expect(moved.remoteLaunches).toEqual([]);
    expect(moved.localLaunches).toHaveLength(1);
    // A scratch thread runs here only when the coordinator says so.
    expect(yield* routed.launch({ title: "x", scratch: true })).toMatchObject({
      code: "invalid_request",
    });
    expect(routed.localLaunches).toEqual([]);
    expect(routed.remoteLaunches).toEqual([]);
  });
});

it.effect("reports where each thread runs and why", () => {
  const routed = setup({ workerMachine: true });
  return Effect.gen(function* () {
    expect(yield* routed.launch({ title: "a", message: "go" })).toMatchObject({
      machine: M1,
      placement: { machine: "M1", reason: "project_worker_machine", skipped: [] },
    });
    expect(yield* routed.launch({ title: "b", message: "go", machine: "M1" })).toMatchObject({
      placement: { machine: "M1", reason: "explicit", skipped: [] },
    });
    expect(yield* routed.launch({ title: "c", message: "go", machine: "local" })).toMatchObject({
      placement: { machine: "this machine", reason: "explicit", skipped: [] },
    });
    const plain = setup();
    expect(yield* plain.launch({ title: "d", message: "go" })).toMatchObject({
      placement: { machine: "this machine", reason: "this_machine", skipped: [] },
    });
  });
});

it.effect("keeps the project going here when its worker machine cannot take the thread", () => {
  const codes = [
    "machine_unreachable",
    "machine_not_authorized",
    "model_unavailable_on_machine",
    "project_unavailable_on_machine",
    "outside_grant_scope",
  ] as const;
  return Effect.gen(function* () {
    for (const code of codes) {
      const out = setup({ workerMachine: true, remoteFails: code });
      const result = yield* out.launch({ title: "Fix CI", message: "Fix it" });
      expect(result, code).toMatchObject({
        placement: {
          machine: "this machine",
          reason: "this_machine",
          skipped: [{ machine: "M1", reason: expect.stringMatching(`^M1: ${code}`) }],
        },
      });
      expect(out.remoteLaunches, code).toHaveLength(1);
      expect(out.localLaunches, code).toHaveLength(1);
    }
  });
});

it.effect("tells the agent to add a missing project to the machine, then launch again", () => {
  const missing = setup({ remoteFails: "project_unavailable_on_machine" });
  const scratch = setup({ remoteFails: "project_unavailable_on_machine" });
  return Effect.gen(function* () {
    const refused = yield* missing.launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(refused).toMatchObject({ code: "project_unavailable_on_machine" });
    expect(String(refused.message)).toContain(
      `studio_project_add_to_machine {machine:"M1", projectId:"${projectId}"}`,
    );
    expect(String(refused.message)).toContain("machineProjectId");
    // A scratch launch has no project to add.
    const bare = yield* scratch.launch({
      title: "Check disk",
      message: "df -h",
      machine: "M1",
      scratch: true,
    });
    expect(String(bare.message)).not.toContain("studio_project_add_to_machine");
  });
});

it.effect("never substitutes a machine the agent named, nor a launch that may have started", () => {
  const named = setup({ remoteFails: "machine_unreachable" });
  const unknown = setup({ workerMachine: true, remoteFails: "remote_launch_unconfirmed" });
  return Effect.gen(function* () {
    expect(
      yield* named.launch({ title: "Fix CI", message: "Fix it", machine: "M1" }),
    ).toMatchObject({ code: "machine_unreachable" });
    expect(named.localLaunches).toEqual([]);
    // A second thread here could duplicate one already running on M1.
    expect(yield* unknown.launch({ title: "Fix CI", message: "Fix it" })).toMatchObject({
      code: "remote_launch_unconfirmed",
    });
    expect(unknown.localLaunches).toEqual([]);
  });
});

it.effect("refuses attachments to another machine", () => {
  const inside = setup();
  return Effect.gen(function* () {
    expect(
      yield* inside.launch({
        title: "x",
        machine: "m1",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
      }),
    ).toMatchObject({ code: "invalid_request" });
    expect(inside.remoteLaunches).toEqual([]);
  });
});

it.effect("lets an outside client start work on another machine, without reporting back", () => {
  const outside = setup({ outsideClient: true, clientAccess: "auto" });
  return Effect.gen(function* () {
    const result = yield* outside.launch({
      title: "Fix CI",
      message: "Fix it",
      projectId: "project",
      machine: "m1",
    });
    expect(result).toMatchObject({ threadId: "b-thread", machine: M1, reportsBack: false });
    expect(outside.remoteLaunches).toHaveLength(1);
    expect(outside.remoteLaunches[0]).toMatchObject({
      launchedBy: { kind: "client", sessionId: "client", label: "Outside agent" },
      localProject: { id: "project" },
      // Its approval caps the mode; the machine's grant caps it again there.
      runtimeMode: "auto",
      reportBack: false,
      delegation: { path: ["env-m4"], hops: 1 },
    });
    expect(outside.remoteLaunches[0]).not.toHaveProperty("callerThreadId");
    // The badge there names the client, not just this machine.
    expect(outside.remoteLaunches[0]?.originHint).toEqual({ clientLabel: "Outside agent" });
    expect(outside.localLaunches).toEqual([]);
  });
});

it.effect("refuses an outside client work above its access or any as read-only", () => {
  const capped = setup({ outsideClient: true, clientAccess: "approval-required" });
  const readOnly = setup({ outsideClient: true, clientAccess: "read-only" });
  return Effect.gen(function* () {
    expect(
      yield* capped.launch({
        title: "x",
        message: "go",
        projectId: "project",
        machine: "m1",
        runtimeMode: "full-access",
      }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(
      yield* readOnly.launch({ title: "x", message: "go", scratch: true, machine: "m1" }),
    ).toMatchObject({ code: "capability_denied" });
    expect(capped.remoteLaunches).toEqual([]);
    expect(readOnly.remoteLaunches).toEqual([]);
  });
});

it.effect("starts a scratch thread on another machine for scratch or no project", () => {
  const outside = setup({ outsideClient: true });
  const inside = setup();
  return Effect.gen(function* () {
    // An outside client naming no project, and one passing scratch.
    yield* outside.launch({ title: "Disk and RAM", message: "Report", machine: "m1" });
    yield* outside.launch({
      title: "Disk and RAM",
      message: "Report",
      machine: "m1",
      scratch: true,
    });
    expect(outside.remoteLaunches.map((launch) => launch.localProject)).toEqual([
      undefined,
      undefined,
    ]);
    // A thread here asking for scratch there, as the user asked.
    yield* inside.launch({
      title: "Disk and RAM",
      message: "Report",
      machine: "m1",
      scratch: true,
      projectless: true,
    });
    expect(inside.remoteLaunches[0]).toMatchObject({
      callerThreadId: callerId,
      localProject: undefined,
      reportBack: true,
    });
    expect(
      yield* inside.launch({
        title: "x",
        machine: "m1",
        scratch: true,
        workspaceStrategy: { type: "root" },
      }),
    ).toMatchObject({ code: "invalid_request" });
    expect(outside.localLaunches).toEqual([]);
    expect(inside.localLaunches).toEqual([]);
  });
});

it.effect("carries the calling thread's delegation path to the other machine", () => {
  const plain = setup();
  const relayed = setup({
    origin: {
      coordinatorEnvironmentId: EnvironmentId.make("env-m3"),
      path: [EnvironmentId.make("env-m3")],
      hops: 1,
    },
  });
  return Effect.gen(function* () {
    yield* plain.launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(plain.remoteLaunches[0]?.delegation).toEqual({ path: ["env-m4"], hops: 1 });
    yield* relayed.launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(relayed.remoteLaunches[0]?.delegation).toEqual({
      path: ["env-m3", "env-m4"],
      hops: 2,
    });
  });
});

it.effect("passes the increment ref on for the other machine to resolve", () => {
  const { launch, remoteLaunches } = setup();
  return Effect.gen(function* () {
    yield* launch({ title: "Fix CI", message: "Fix it", machine: "M1", increment: "0996" });
    expect(remoteLaunches[0]?.increment).toBe("0996");
    yield* launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(remoteLaunches[1]?.increment).toBeUndefined();
  });
});

it.effect("never forwards a worktree ask that would override the other machine's switch", () => {
  const { launch, remoteLaunches } = setup();
  return Effect.gen(function* () {
    yield* launch({
      title: "Fix CI",
      message: "Fix it",
      machine: "M1",
      workspaceStrategy: { type: "worktree", branchName: "fix/ci", baseRef: "main" },
      userAskedForWorktree: true,
    });
    expect(remoteLaunches).toHaveLength(1);
    expect(remoteLaunches[0]?.userAskedForWorktree).toBe(false);
  });
});

it.effect(
  "starts work back on the owner's machine that sent it, under this machine's grant",
  () => {
    // The owner's M1 started the calling thread here; the user also let this machine use M1.
    const { launch, remoteLaunches } = setup({
      origin: { coordinatorEnvironmentId: M1.environmentId, path: [M1.environmentId], hops: 1 },
    });
    return Effect.gen(function* () {
      yield* launch({ title: "Fetch clip", message: "Find it", machine: "M1" });
      // The path starts here, and the hop count carries on, so the work cannot bounce for ever.
      expect(remoteLaunches[0]?.delegation).toEqual({ path: ["env-m4"], hops: 2 });
    });
  },
);

it.effect("never sends work further back along its path than the machine that sent it", () => {
  const { launch, remoteLaunches } = setup({
    origin: {
      coordinatorEnvironmentId: EnvironmentId.make("env-m3"),
      path: [M1.environmentId, EnvironmentId.make("env-m3")],
      hops: 2,
    },
  });
  return Effect.gen(function* () {
    const result = yield* launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(result).toMatchObject({ code: "delegation_cycle" });
    expect(remoteLaunches).toEqual([]);
  });
});

it.effect("refuses to send work back to the machine it came from, before sending it", () => {
  // Another person's M1 started the calling thread here; it may not start work on M1 in turn.
  const { launch, remoteLaunches } = setup({
    origin: { coordinatorEnvironmentId: M1.environmentId, path: [M1.environmentId], hops: 1 },
    originOwner: "other",
  });
  return Effect.gen(function* () {
    const result = yield* launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
    expect(result).toMatchObject({ code: "delegation_cycle" });
    expect(String(result.message)).toContain("env-m1 → this machine → env-m1");
    expect(remoteLaunches).toEqual([]);
  });
});

it.effect("keeps a personal assistant's work on this machine", () => {
  const household = setup({ personal: true });
  const code = setup();
  return Effect.gen(function* () {
    // Its coordinator cannot start a thread on another machine, in its own project or another.
    for (const params of [
      { title: "Errands", message: "go", machine: "M1" },
      { title: "Fix CI", message: "go", machine: "M1", projectId: codeProjectId },
    ]) {
      const refused = yield* household.launch(params);
      expect(refused, params.title).toMatchObject({ code: "invalid_request" });
      expect(String(refused.message).startsWith(PERSONAL_ASSISTANT_PRIVATE_MESSAGE)).toBe(true);
    }
    expect(household.remoteLaunches).toEqual([]);
    // Here it still launches.
    expect(
      yield* household.launch({ title: "Errands", message: "go", machine: "local" }),
    ).toMatchObject({ placement: { machine: "this machine", reason: "explicit" } });
    expect(yield* household.launch({ title: "Errands", message: "go" })).toMatchObject({
      placement: { machine: "this machine", reason: "this_machine" },
    });
    expect(household.localLaunches).toHaveLength(2);
    // A code project's coordinator still starts work on M1.
    expect(
      yield* code.launch({
        title: "Fix CI",
        message: "go",
        machine: "M1",
        projectId: codeProjectId,
      }),
    ).toMatchObject({ threadId: "b-thread", machine: M1 });
    expect(code.remoteLaunches).toHaveLength(1);
  });
});

it.effect("refuses a project not on this machine instead of a scratch launch there", () => {
  const outside = setup({ outsideClient: true });
  const inside = setup();
  return Effect.gen(function* () {
    for (const world of [outside, inside]) {
      const refused = yield* world.launch({
        title: "Fix CI",
        message: "Fix it",
        projectId: missingProjectId,
        machine: "m1",
      });
      expect(refused).toMatchObject({
        code: "invalid_request",
        message: "The project was not found.",
      });
      expect(world.remoteLaunches).toEqual([]);
      expect(world.localLaunches).toEqual([]);
    }
  });
});

it.effect("keeps a project thread's scratch work elsewhere to projectless, as here", () => {
  const inside = setup();
  const scratchChat = setup({ callerInScratch: true });
  const outside = setup({ outsideClient: true });
  return Effect.gen(function* () {
    const params = { title: "Disk", message: "df -h", machine: "m1", scratch: true };
    const refused = yield* inside.launch(params);
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(String(refused.message)).toContain("projectless:true");
    expect(inside.remoteLaunches).toEqual([]);
    yield* inside.launch({ ...params, projectless: true });
    expect(inside.remoteLaunches).toHaveLength(1);
    // A scratch chat here, and an outside client, have no project to stay in.
    yield* scratchChat.launch(params);
    expect(scratchChat.remoteLaunches).toHaveLength(1);
    yield* outside.launch(params);
    expect(outside.remoteLaunches).toHaveLength(1);
  });
});

it.effect("tries the project's worker machines in order and skips one that cannot take it", () => {
  const routed = setup({ workerMachines: ["m3", "m1", "local"], failingMachines: ["m3"] });
  return Effect.gen(function* () {
    expect(yield* routed.launch({ title: "a", message: "go" })).toMatchObject({
      machine: M1,
      placement: {
        machine: "M1",
        reason: "project_worker_machine",
        skipped: [{ machine: "M3", reason: "M3: machine_unreachable" }],
      },
    });
    expect(routed.remoteLaunches.map((input) => input.machine.id)).toEqual(["m3", "m1"]);
    expect(routed.localLaunches).toEqual([]);
  });
});

it.effect("runs here when every listed machine fails and this machine is in the list", () => {
  const routed = setup({ workerMachines: ["m3", "local", "m1"], failingMachines: ["m3", "m1"] });
  return Effect.gen(function* () {
    expect(yield* routed.launch({ title: "a", message: "go" })).toMatchObject({
      placement: { machine: "this machine", reason: "this_machine" },
    });
    // This machine comes before M1, so M1 is never tried.
    expect(routed.remoteLaunches.map((input) => input.machine.id)).toEqual(["m3"]);
    expect(routed.localLaunches).toHaveLength(1);
  });
});

it.effect("starts nothing here when the list leaves this machine out and all refuse", () => {
  const routed = setup({ workerMachines: ["m3", "m1"], failingMachines: ["m3", "m1"] });
  return Effect.gen(function* () {
    const result = yield* routed.launch({ title: "a", message: "go" });
    expect(result).toMatchObject({
      code: "machine_unreachable",
      message: expect.stringContaining("nothing started here"),
    });
    expect(result.message).toContain("M3: M3: machine_unreachable");
    expect(routed.remoteLaunches.map((input) => input.machine.id)).toEqual(["m3", "m1"]);
    expect(routed.localLaunches).toEqual([]);
  });
});

it.effect("starts work here first when this machine heads the list", () => {
  const routed = setup({ workerMachines: ["local", "m3"] });
  return Effect.gen(function* () {
    expect(yield* routed.launch({ title: "a", message: "go" })).toMatchObject({
      placement: { machine: "this machine", reason: "this_machine" },
    });
    expect(routed.remoteLaunches).toEqual([]);
    expect(routed.localLaunches).toHaveLength(1);
  });
});

/** M1's own project of the same repository, added there by itself: not shared yet. */
const m1Copy = (id: string, extra: Record<string, unknown> = {}) =>
  projectFixture(ProjectId.make(id), {
    title: "widgets",
    workspaceRoot: "/home/example/Projects/widgets",
    repositoryIdentity: {
      canonicalKey: "github.com/example/widgets",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/widgets.git",
      },
      // Git reports the root with the home link resolved.
      rootPath: "/srv/work/Projects/widgets",
    } as never,
    ...extra,
  });

it.effect(
  "links the machine's own copy of the repository into the shared project, then launches",
  () => {
    const out = setup({ sharedWithCopiesOnM1: [m1Copy("m1-widgets")] });
    return Effect.gen(function* () {
      const result = yield* out.launch({ title: "Fix CI", message: "Fix it", machine: "M1" });
      expect(result).toMatchObject({ projectId: "m1-widgets", machine: M1 });
      expect(out.linkSteps).toEqual(["prepare:m1-widgets", "commit:m1-widgets"]);
      expect(out.proxied).toEqual([
        "studio_project_list",
        "studio_thread_list",
        "studio_project_link_accept",
      ]);
      expect(out.remoteLaunches).toHaveLength(2);
    });
  },
);

it.effect("never links a copy that is already shared, nor guesses between two copies", () => {
  const sharedElsewhere = setup({
    sharedWithCopiesOnM1: [
      m1Copy("m1-other", {
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          logicalProject: {
            id: "logical:other",
            title: "widgets",
            coordinatorId: "coordinator:logical:other",
            members: [
              { environmentId: M1.environmentId, projectId: "m1-other", coordinatorThreadId: "c1" },
              { environmentId: M3.environmentId, projectId: "m3-other", coordinatorThreadId: "c3" },
            ],
          },
        },
      }),
    ],
  });
  const two = setup({ sharedWithCopiesOnM1: [m1Copy("m1-a"), m1Copy("m1-b")] });
  return Effect.gen(function* () {
    const refused = yield* sharedElsewhere.launch({ title: "Fix", message: "Fix", machine: "M1" });
    expect(refused).toMatchObject({ code: "project_unavailable_on_machine" });
    expect(String(refused.message)).toContain("studio_project_add_to_machine");
    expect(sharedElsewhere.linkSteps).toEqual([]);
    const ambiguous = yield* two.launch({ title: "Fix", message: "Fix", machine: "M1" });
    expect(ambiguous).toMatchObject({ code: "project_unavailable_on_machine" });
    expect(String(ambiguous.message)).toContain("m1-a");
    expect(String(ambiguous.message)).toContain("m1-b");
    expect(two.linkSteps).toEqual([]);
  });
});

it.effect("leaves a copy with threads of its own for the person to link with Link…", () => {
  const out = setup({
    sharedWithCopiesOnM1: [m1Copy("m1-widgets")],
    m1CopyThreads: [{ threadId: "thread-on-m1" }],
  });
  return Effect.gen(function* () {
    const refused = yield* out.launch({ title: "Fix", message: "Fix", machine: "M1" });
    expect(refused).toMatchObject({ code: "project_unavailable_on_machine" });
    expect(String(refused.message)).toContain("m1-widgets");
    expect(String(refused.message)).toContain("Link…");
    expect(out.linkSteps).toEqual([]);
  });
});

it.effect("never relinks a copy this project still lists there, as after an unlink there", () => {
  const out = setup({ sharedWithCopiesOnM1: [m1Copy("m1-widgets")], staleM1Member: true });
  return Effect.gen(function* () {
    const refused = yield* out.launch({ title: "Fix", message: "Fix", machine: "M1" });
    expect(refused).toMatchObject({ code: "project_unavailable_on_machine" });
    expect(out.proxied).toEqual([]);
    expect(out.linkSteps).toEqual([]);
  });
});

it.effect("keeps an explicit machineProjectId and never links for another machine's work", () => {
  const explicit = setup({ sharedWithCopiesOnM1: [m1Copy("m1-widgets")] });
  const relayed = setup({
    sharedWithCopiesOnM1: [m1Copy("m1-widgets")],
    origin: {
      coordinatorEnvironmentId: EnvironmentId.make("env-m3"),
      path: [EnvironmentId.make("env-m3")],
      hops: 1,
    } as unknown as WorkOrigin,
  });
  return Effect.gen(function* () {
    yield* explicit.launch({
      title: "Fix",
      message: "Fix",
      machine: "M1",
      machineProjectId: "m1-widgets",
    });
    expect(explicit.linkSteps).toEqual([]);
    yield* relayed.launch({ title: "Fix", message: "Fix", machine: "M1" });
    expect(relayed.linkSteps).toEqual([]);
  });
});
