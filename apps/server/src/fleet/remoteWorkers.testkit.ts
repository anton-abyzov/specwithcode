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
  RunId,
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
import type { FleetTarget } from "../studioFleet.ts";
import { fakeMachine, ORIGIN, target } from "./fleetMachine.testkit.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import { type ReleasedPeer, releasedPeer } from "./releasedPeer.testkit.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkers from "./RemoteWorkers.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";
import * as WorkGrants from "./WorkGrants.ts";

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

/** Lets a test wait for something that was written or asked, without a timer. */
export interface Signal {
  readonly fire: () => void;
  /** Settles at the next `fire`. Take it before reading the state it guards. */
  readonly next: () => Promise<void>;
}

export const makeSignal = (): Signal => {
  let wake = () => {};
  let pending = new Promise<void>((resolve) => {
    wake = resolve;
  });
  return {
    fire: () => {
      const settle = wake;
      pending = new Promise<void>((resolve) => {
        wake = resolve;
      });
      settle();
    },
    next: () => pending,
  };
};

/** A message a thread here keeps. The orchestrator takes a command id once per thread. */
export interface KeptMessage {
  readonly threadId: string;
  readonly commandId: string;
  readonly text: string;
}

/**
 * Machines named by what they do in a test, so it does not lean on the shared
 * world's names: this server, the machine work goes to, and any further ones.
 */
export interface Roles {
  readonly self: string;
  readonly target: FleetTarget;
  readonly more?: ReadonlyArray<{
    readonly target: FleetTarget;
    readonly tools: Record<string, FakeToolHandler>;
  }>;
}

export const machine = (role: string): FleetTarget => ({
  ...target,
  id: role,
  label: `${role[0]?.toUpperCase() ?? ""}${role.slice(1)}`,
  environmentId: EnvironmentId.make(`env-${role}`),
  url: `https://${role}.example.ts.net`,
});

/** This server as "source" and the machine its work goes to as "target". */
export const ROLES: Roles = { self: "env-source", target: machine("target") };

export interface World {
  readonly tools: Record<string, FakeToolHandler>;
  readonly local: { current: Project };
  readonly caller: { archived: boolean; deleted?: boolean; settled?: boolean };
  /** Every send to a thread here, repeats included. */
  readonly wakes: Array<{
    readonly commandId: string;
    readonly text: string;
    readonly mode: string;
    readonly threadId: string;
  }>;
  /** What people see for each wake: its author and notification summary. */
  readonly notices: Array<{ readonly createdBy: string; readonly summary: string | undefined }>;
  /** What the threads here keep of those sends: one message per command id and thread. */
  readonly kept: Array<KeptMessage>;
  /** Fires when a row is written, a message is sent here, or another machine is asked. */
  readonly changed: Signal;
  /** Row writes fail, as on a disk that cannot be written. */
  storeFails: boolean;
  /** Asked at every read of this machine's fleet file: whether that read fails. */
  fleetReadFails: () => boolean;
  /** The threads on this machine that a takeover created here, kept as a machine keeps them. */
  readonly here: ReleasedPeer;
  /** Calls to other machines and row writes this server has under way. */
  inFlight: number;
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
  fleet: {
    /** More rows in this machine's fleet file, after M1. */
    readonly extraTargets?: ReadonlyArray<typeof target>;
    /** What this machine lets other machines do here ("Who can run work here"). */
    readonly workGrants?: Partial<WorkGrants.WorkGrantsShape>;
    /** Machines named by role instead of the shared names. */
    readonly roles?: Roles;
    /** A folder that outlives this layer: a second setup over it is the server restarted. */
    readonly baseDir?: string;
    /** The messages the threads here already keep, as their database does across a restart. */
    readonly kept?: Array<KeptMessage>;
    /** One signal for several setups in a test. */
    readonly changed?: Signal;
    /** This machine's own threads, which outlive one server life. */
    readonly here?: ReleasedPeer;
  } = {},
) => {
  const self = fleet.roles?.self ?? "env-m4";
  const first = fleet.roles?.target ?? target;
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
    kept: fleet.kept ?? [],
    changed: fleet.changed ?? makeSignal(),
    storeFails: false,
    fleetReadFails: () => false,
    here: fleet.here ?? releasedPeer(self),
    inFlight: 0,
  };
  /** A machine's tools as they are when called; every call is something a test may wait for. */
  const live = (tools: () => Record<string, FakeToolHandler>) =>
    new Proxy({} as Record<string, FakeToolHandler>, {
      get: (_target, name: string) => {
        const handler = tools()[name];
        return handler === undefined
          ? undefined
          : async (args: Record<string, unknown>) => {
              try {
                return await handler(args);
              } finally {
                world.changed.fire();
              }
            };
      },
      ownKeys: () => Object.keys(tools()),
      getOwnPropertyDescriptor: (_target, name: string) =>
        name in tools()
          ? { enumerable: true, configurable: true, value: tools()[name] }
          : undefined,
    });
  const origin = fleet.roles === undefined ? ORIGIN : first.url;
  const auth = fakeMachine(
    fleet.roles === undefined ? {} : { environmentId: first.environmentId, origins: [origin] },
  );
  const remote = fakeStudioMcp({
    origin,
    environmentId: first.environmentId,
    tokens,
    tools: live(() => world.tools),
  });
  const others = (fleet.roles?.more ?? []).map((other) => ({
    origin: other.target.url,
    auth: fakeMachine({ environmentId: other.target.environmentId, origins: [other.target.url] }),
    remote: fakeStudioMcp({
      origin: other.target.url,
      environmentId: other.target.environmentId,
      tokens,
      tools: live(() => other.tools),
    }),
  }));
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const asked = others.find((other) => other.origin === url.origin) ?? { auth, remote };
    world.inFlight += 1;
    try {
      return await (url.pathname === "/mcp" || url.pathname === "/.well-known/studio/environment"
        ? asked.remote.fetcher(input, init)
        : asked.auth.fetcher(input, init));
    } finally {
      world.inFlight -= 1;
    }
  }) as typeof fetch;

  const shell = (id: string) => ({
    id: ThreadId.make(id),
    projectId: world.local.current.id,
    archivedAt: world.caller.archived ? DateTime.toDateUtc(DateTime.nowUnsafe()) : null,
    deletedAt: world.caller.deleted ? DateTime.toDateUtc(DateTime.nowUnsafe()) : null,
    settledAt: world.caller.settled ? DateTime.toDateUtc(DateTime.nowUnsafe()) : null,
    settledOverride: world.caller.settled ? "settled" : null,
  });
  const at = (value: string | null) => (value === null ? null : DateTime.makeUnsafe(value));
  const hereThread = (id: string) => {
    const thread = world.here.threads.get(id);
    return thread === undefined
      ? Effect.fail({ _tag: "ProjectionStoreV2ThreadNotFoundError" } as never)
      : Effect.succeed(thread);
  };
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    // A continuation exists here only once a takeover created it.
    getThreadShell: (id) =>
      Effect.sync(
        () => (id.startsWith("handoff:") && !world.here.threads.has(id) ? null : shell(id)) as never,
      ),
    getThreadRecords: ((id: string) =>
      Effect.map(hereThread(id), (thread) => ({
        thread:
          thread.movedTo === undefined
            ? {}
            : {
                movedTo: {
                  kind: "handoff",
                  environmentId: thread.movedTo.environmentId,
                  machineLabel: thread.movedTo.label,
                },
                execution: {
                  ownerMachineId: self,
                  executionMachineId: thread.movedTo.environmentId,
                  epoch: thread.movedTo.epoch,
                  history: [
                    { machine: self, to: "2026-10-20T13:00:00.000Z", epoch: thread.movedTo.epoch - 1 },
                    { machine: thread.movedTo.environmentId, to: null, epoch: thread.movedTo.epoch },
                  ],
                },
              },
        runs: thread.runs.map((run) => ({
          id: run.id,
          ordinal: run.ordinal,
          status: run.status,
          startedAt: at(run.startedAt),
          completedAt: at(run.completedAt),
        })),
        messages: thread.runs.map((run) => ({
          id: run.message.id,
          runId: run.id,
          role: "user",
          creationSource: run.message.creationSource,
        })),
      }))) as never,
    waitForThread: ((input: { threadId: string; runId?: string; timeoutMs: number }) =>
      Effect.gen(function* () {
        const thread = yield* hereThread(input.threadId);
        const find = () =>
          input.runId === undefined
            ? thread.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]
            : thread.runs.find((candidate) => candidate.id === input.runId);
        if (input.runId !== undefined && find() === undefined)
          return yield* new ThreadManagementService.ThreadManagementRunNotFoundError({
            threadId: ThreadId.make(input.threadId),
            runId: RunId.make(input.runId),
          });
        const ended = (status: string | undefined) =>
          status !== undefined &&
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
        // As the service does: an open run is waited for, up to the time given.
        if (!ended(find()?.status)) yield* Effect.sleep(Math.min(input.timeoutMs, 10));
        const run = find();
        world.changed.fire();
        return { threadId: input.threadId, run: run ?? null, timedOut: !ended(run?.status) && run !== undefined };
      })) as never,
    sendToThread: (input) =>
      Effect.sync(() => {
        world.wakes.push({
          commandId: input.commandId,
          text: input.text,
          mode: input.mode,
          threadId: input.threadId,
        });
        world.notices.push({
          createdBy: input.createdBy,
          summary: input.notification?.summary,
        });
        // As the orchestrator does: a command id it already took adds no message.
        if (
          !world.kept.some(
            (message) =>
              message.threadId === input.threadId && message.commandId === input.commandId,
          )
        )
          world.kept.push({
            threadId: input.threadId,
            commandId: input.commandId,
            text: input.text,
          });
        world.changed.fire();
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
    getEnvironmentId: Effect.succeed(EnvironmentId.make(self)),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make(self),
      label: fleet.roles === undefined ? "M4" : "Source",
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
    fallbackGraceMs: 30,
    recheckFailedWithinMs: 60_000,
    recheckUnconfirmedMs: 60_000,
    ...timingOverrides,
  });
  /** The real file store; a test can wait for its writes and make them fail. */
  const store = Layer.effect(
    RemoteWorkerStore.RemoteWorkerStore,
    Effect.map(RemoteWorkerStore.RemoteWorkerStore, (real) =>
      RemoteWorkerStore.RemoteWorkerStore.of({
        list: real.list,
        prune: real.prune,
        modify: (id, change) =>
          world.storeFails
            ? Effect.fail(
                new RemoteWorkerStore.RemoteWorkerStoreError({
                  operation: "write",
                  cause: "The test's disk cannot be written.",
                }),
              )
            : Effect.suspend(() => {
                world.inFlight += 1;
                return real.modify(id, change);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    world.inFlight -= 1;
                    world.changed.fire();
                  }),
                ),
              ),
      }),
    ),
  ).pipe(Layer.provide(RemoteWorkerStore.layer));
  const layer = Layer.mergeAll(RemoteWorkers.layer, RemoteWorkerFollower.layerResume).pipe(
    Layer.provideMerge(RemoteWorkerFollower.layer),
    Layer.provideMerge(RemoteStudioMcpClient.layer),
    Layer.provideMerge(Layer.merge(FleetWorkerGrants.layer, store)),
    Layer.provideMerge(
      Layer.succeed(FleetTargets.FleetTargets, {
        load: Effect.suspend(() =>
          world.fleetReadFails()
            ? Effect.fail(
                new FleetTargets.FleetConfigReadError({ cause: "The test's file is unreadable." }),
              )
            : Effect.succeed({
                version: 1 as const,
                machines: [
                  first,
                  ...(fleet.roles?.more ?? []).map((other) => other.target),
                  ...(fleet.extraTargets ?? []),
                ],
              }),
        ),
        fetch: fetcher,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(threads, projects, providers, environment, timings)),
    Layer.provideMerge(
      Layer.succeed(WorkGrants.WorkGrants, {
        ...WorkGrants.WorkGrants.defaultValue(),
        ...fleet.workGrants,
      }),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        fleet.baseDir ?? { prefix: "studio-remote-workers-" },
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { world, remote, auth, layer };
};

/** A thread's project launch; pass `localProject: undefined` to the launch itself for scratch. */
export const launchInput = (
  overrides: Partial<RemoteWorkers.RemoteLaunchInput> & { readonly localProject?: Project } = {},
): RemoteWorkers.RemoteLaunchInput & { readonly localProject: Project } => ({
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
  delegation: { path: [EnvironmentId.make("env-m4")], hops: 1 },
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

export const allow = (access: "auto" | "full-access" = "auto", machineId = "m1") =>
  FleetWorkerGrants.FleetWorkerGrants.pipe(
    Effect.flatMap((grants) => grants.allow({ machineId, access })),
  );

/**
 * Waits until this server has nothing under way: no call to another machine
 * and no row write, across many turns of the event loop. For the one thing a
 * state cannot show, that nothing more happens after a restart.
 */
export const quiet = (world: Pick<World, "inFlight">) =>
  Effect.promise(async () => {
    for (let calm = 0; calm < 50; ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      calm = world.inFlight === 0 ? calm + 1 : 0;
    }
  });

/**
 * Waits until `check` shows what `until` asks for, looking again only when a
 * row was written, a message was sent here or another machine was asked.
 * No timer: a state that never comes ends with the test's own timeout.
 */
export const settled = <A, E, R>(
  world: Pick<World, "changed">,
  check: Effect.Effect<A, E, R>,
  until: (value: A) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const next = world.changed.next();
      const value = yield* check;
      if (until(value)) return value;
      yield* Effect.promise(() => next);
    }
  });

/** Allows workers again with the clock past the one-mint-a-minute limit. */
export const allowLater = Effect.gen(function* () {
  const live = yield* Clock.clockWith(Effect.succeed);
  const ahead: Clock.Clock = Object.assign(Object.create(live) as Clock.Clock, {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe() + 120_000,
    currentTimeMillis: Effect.sync(() => live.currentTimeMillisUnsafe() + 120_000),
  });
  yield* allow().pipe(Effect.provideService(Clock.Clock, ahead));
});
