import * as DateTime from "effect/DateTime";
/** Shared world for RemoteWorkers and RemoteWorkerFollower tests: a fake machine B and this server. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  type OrchestratorMcpMachineRef,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { type FakeToolHandler, fakeStudioMcp } from "./fakeStudioMcp.testkit.ts";
import { fakeMachine, ORIGIN, target } from "./fleetMachine.testkit.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkers from "./RemoteWorkers.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

export const identity = (key: string, rootPath: string): RepositoryIdentity => ({
  canonicalKey: key,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${key}.git` },
  rootPath,
});

export const NOW = "2026-10-12T00:00:00.000Z";
export const project = (overrides: Partial<Project> = {}): Project => ({
  id: ProjectId.make("local-project"),
  title: "App",
  workspaceRoot: "/work/app",
  repositoryIdentity: identity("github.com/acme/app", "/work/app"),
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex-local"),
    model: "gpt-5.5",
  } as ModelSelection,
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    coordinatorThreadId: ThreadId.make("coordinator"),
  },
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

export const remoteProject = {
  ...project(),
  id: "remote-project",
  workspaceRoot: "/home/b/app",
  repositoryIdentity: identity("github.com/acme/app", "/home/b/app"),
  workspaceSettings: undefined,
};

export const M1: OrchestratorMcpMachineRef = {
  id: "m1",
  label: "M1",
  environmentId: EnvironmentId.make("env-m1"),
};

export const capabilities = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "auto",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      models: [{ id: "gpt-5.5", label: null }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {},
};

export interface World {
  readonly tools: Record<string, FakeToolHandler>;
  readonly local: { current: Project };
  readonly caller: { archived: boolean };
  readonly wakes: Array<{
    readonly commandId: string;
    readonly text: string;
    readonly mode: string;
  }>;
  /** What people see for each wake: its author and notification summary. */
  readonly notices: Array<{ readonly createdBy: string; readonly summary: string | undefined }>;
}

export const launchAnswer = {
  threadId: "b-thread-1",
  projectId: "remote-project",
  modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  runId: "b-run-1",
  status: "queued",
};

export const setup = (
  tools: Record<string, FakeToolHandler> = {},
  timingOverrides: Partial<RemoteWorkerFollower.RemoteWorkerFollowerTimingsShape> = {},
) => {
  const tokens = ["approval-required", "auto-accept-edits", "auto", "full-access"].flatMap(
    (access) => [1, 2, 3, 4].map((n) => `mcp-token-${access}-${n}`),
  );
  const world: World = {
    tools: {
      orchestrator_capabilities: () => ({ result: capabilities }),
      studio_project_list: () => ({ result: { projects: [remoteProject], nextCursor: null } }),
      studio_thread_launch: () => ({ result: launchAnswer }),
      studio_thread_wait: () => ({
        result: { threadId: "b-thread-1", runId: "b-run-1", status: "completed", timedOut: false },
      }),
      ...tools,
    },
    local: { current: project() },
    caller: { archived: false },
    wakes: [],
    notices: [],
  };
  const auth = fakeMachine();
  const remote = fakeStudioMcp({
    origin: ORIGIN,
    environmentId: "env-m1",
    tokens,
    tools: new Proxy({} as Record<string, FakeToolHandler>, {
      get: (_target, name: string) => world.tools[name],
      ownKeys: () => Object.keys(world.tools),
      getOwnPropertyDescriptor: (_target, name: string) =>
        name in world.tools
          ? { enumerable: true, configurable: true, value: world.tools[name] }
          : undefined,
    }),
  });
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.pathname === "/mcp" || url.pathname === "/.well-known/studio/environment"
      ? remote.fetcher(input, init)
      : auth.fetcher(input, init);
  }) as typeof fetch;

  const shell = (id: string) => ({
    id: ThreadId.make(id),
    projectId: world.local.current.id,
    archivedAt: world.caller.archived ? DateTime.toDateUtc(DateTime.nowUnsafe()) : null,
    deletedAt: null,
  });
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (id) => Effect.sync(() => shell(id) as never),
    sendToThread: (input) =>
      Effect.sync(() => {
        world.wakes.push({ commandId: input.commandId, text: input.text, mode: input.mode });
        world.notices.push({
          createdBy: input.createdBy,
          summary: input.notification?.summary,
        });
        return {} as never;
      }),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.sync(() =>
        id === world.local.current.id ? Option.some(world.local.current) : Option.none(),
      ),
  });
  const providers = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([{ instanceId: "codex-local", driver: "codex" }] as never),
  });
  const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env-m4")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("env-m4"),
      label: "M4",
    } as never),
  });
  const timings = Layer.succeed(RemoteWorkerFollower.RemoteWorkerFollowerTimings, {
    waitMs: 50,
    backoffStartMs: 5,
    backoffMaxMs: 20,
    lostContactMs: 60_000,
    wakeRetryMs: 20,
    authPollMs: 20,
    launchStaleMs: 10,
    redeliverWithinMs: 60_000,
    maxFollowsPerMachine: 16,
    ...timingOverrides,
  });
  const layer = Layer.mergeAll(RemoteWorkers.layer, RemoteWorkerFollower.layerResume).pipe(
    Layer.provideMerge(RemoteWorkerFollower.layer),
    Layer.provideMerge(RemoteStudioMcpClient.layer),
    Layer.provideMerge(Layer.merge(FleetWorkerGrants.layer, RemoteWorkerStore.layer)),
    Layer.provideMerge(
      Layer.succeed(FleetTargets.FleetTargets, {
        load: Effect.succeed({ version: 1 as const, machines: [target] }),
        fetch: fetcher,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(threads, projects, providers, environment, timings)),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-remote-workers-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { world, remote, auth, layer };
};

export const launchInput = (
  overrides: Partial<RemoteWorkers.RemoteLaunchInput> = {},
): RemoteWorkers.RemoteLaunchInput => ({
  machine: M1,
  commandId: "command-1",
  callerThreadId: ThreadId.make("coordinator"),
  localProject: project(),
  machineProjectId: undefined,
  title: "Fix the flaky test",
  explicitModelSelection: undefined,
  inheritedModelSelection: project().defaultModelSelection ?? undefined,
  runtimeMode: "full-access",
  requestedRuntimeMode: undefined,
  interactionMode: "default",
  workspaceStrategy: undefined,
  message: "Fix it",
  reportBack: true,
  ...overrides,
});

export const rows = Effect.flatMap(RemoteWorkerStore.RemoteWorkerStore, (store) => store.list);

/** Waits for a condition the follower reaches in the background. */
export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* check;
      if (until(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("condition not reached"));
  });

export const allow = (access: "auto" | "full-access" = "auto") =>
  FleetWorkerGrants.FleetWorkerGrants.pipe(
    Effect.flatMap((grants) => grants.allow({ machineId: "m1", access })),
  );

/** Allows workers again with the clock past the one-mint-a-minute limit. */
export const allowLater = Effect.gen(function* () {
  const live = yield* Clock.clockWith(Effect.succeed);
  const ahead: Clock.Clock = Object.assign(Object.create(live) as Clock.Clock, {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe() + 120_000,
    currentTimeMillis: Effect.sync(() => live.currentTimeMillisUnsafe() + 120_000),
  });
  yield* allow().pipe(Effect.provideService(Clock.Clock, ahead));
});
