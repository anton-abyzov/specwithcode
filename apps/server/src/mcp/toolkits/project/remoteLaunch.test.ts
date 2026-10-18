import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
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

const projectId = ProjectId.make("project");
const callerId = ThreadId.make("coordinator");
const providerInstanceId = ProviderInstanceId.make("codex");
const workerModel = { instanceId: providerInstanceId, model: "gpt-5.5" } as ModelSelection;
const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };

const setup = (
  options: {
    readonly workerMachine?: boolean;
    readonly outsideClient?: boolean;
    /** The worker machine was saved for another environment than "m1" has now. */
    readonly staleEnvironment?: boolean;
    /** The machine's grant lowered the caller's mode to this one. */
    readonly grantedRuntimeMode?: "approval-required" | "auto-accept-edits";
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
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
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
      Effect.sync(() => {
        remoteLaunches.push(input);
        return {
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
        };
      }),
  };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
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
    Layer.mock(Project.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
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
    expect(yield* moved.launch({ title: "Fix CI", message: "Fix it" })).toMatchObject({
      code: "machine_identity_mismatch",
    });
    expect(moved.remoteLaunches).toEqual([]);
    expect(moved.localLaunches).toEqual([]);
    // A scratch thread runs here only when the coordinator says so.
    expect(yield* routed.launch({ title: "x", scratch: true })).toMatchObject({
      code: "invalid_request",
    });
    expect(routed.localLaunches).toEqual([]);
    expect(routed.remoteLaunches).toEqual([]);
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
