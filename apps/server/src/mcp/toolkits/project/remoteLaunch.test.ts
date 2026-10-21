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
const codeProjectId = ProjectId.make("example-code");

const setup = (
  options: {
    readonly workerMachine?: boolean;
    readonly outsideClient?: boolean;
    /** The worker machine was saved for another environment than "m1" has now. */
    readonly staleEnvironment?: boolean;
    /** The machine's grant lowered the caller's mode to this one. */
    readonly grantedRuntimeMode?: "approval-required" | "auto-accept-edits";
    /** Another machine's work started the calling thread here. */
    readonly origin?: WorkOrigin;
    /** The other machine refuses or loses the launch with this code. */
    readonly remoteFails?: OrchestratorMcpFailure["code"];
    /** The caller's project is this machine's personal assistant. */
    readonly personal?: boolean;
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
    },
  });
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" })
        : target === "m1" || target === "M1"
          ? Effect.succeed({ kind: "remote", machine: M1 })
          : Effect.die("unexpected machine"),
    launch: (input) =>
      Effect.suspend(() => {
        remoteLaunches.push(input);
        if (options.remoteFails !== undefined)
          return Effect.fail(
            new OrchestratorMcpFailure({
              code: options.remoteFails,
              message: `M1: ${options.remoteFails}`,
            }),
          );
        return Effect.succeed({
          threadId: ThreadId.make("b-thread"),
          projectId: ProjectId.make("remote-project"),
          modelSelection: workerModel,
          runId: RunId.make("b-run"),
          status: "queued" as const,
          machine: M1,
          threadRef: "studio://thread/env-m1/b-thread",
          threadLink: "[Fix CI](studio://thread/env-m1/b-thread)",
          reportsBack: input.reportBack,
          ...(options.grantedRuntimeMode === undefined
            ? { runtimeMode: input.runtimeMode }
            : {
                runtimeMode: options.grantedRuntimeMode,
                runtimeModeLoweredFrom: input.runtimeMode,
              }),
        });
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
        ? { sessionId: "client", label: "Outside agent", access: "full-access" }
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
          Option.some(
            id === codeProjectId
              ? projectFixture(codeProjectId, {
                  title: "Example Code",
                  defaultModelSelection: workerModel,
                  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "code" },
                })
              : project,
          ),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
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
  return { launch, launchEncoded, remoteLaunches, localLaunches };
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
          skipped: [{ machine: "M1", reason: `M1: ${code}` }],
        },
      });
      expect(out.remoteLaunches, code).toHaveLength(1);
      expect(out.localLaunches, code).toHaveLength(1);
    }
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

it.effect("refuses other machines to outside clients, scratch threads and attachments", () => {
  const outside = setup({ outsideClient: true });
  const inside = setup();
  return Effect.gen(function* () {
    expect(
      yield* outside.launch({ title: "x", projectId: "project", machine: "m1" }),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* inside.launch({ title: "x", scratch: true, machine: "m1" })).toMatchObject({
      code: "invalid_request",
    });
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
    expect(outside.remoteLaunches).toEqual([]);
    expect(inside.remoteLaunches).toEqual([]);
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

it.effect("refuses to send work back to the machine it came from, before sending it", () => {
  // M1 started the calling thread here; it may not start work on M1 in turn.
  const { launch, remoteLaunches } = setup({
    origin: { coordinatorEnvironmentId: M1.environmentId, path: [M1.environmentId], hops: 1 },
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
