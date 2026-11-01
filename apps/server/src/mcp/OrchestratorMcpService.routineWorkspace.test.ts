import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerSettings as ServerSettingsValue,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/**
 * Routines an agent makes over MCP that are not bound to its thread follow the
 * project's "Use worktrees" switch: the project folder unless it is on.
 */
const projectId = ProjectId.make("project");
const codex = ProviderInstanceId.make("codex");
const project = projectFixture(projectId, {
  title: "Project",
  defaultModelSelection: { instanceId: codex, model: "gpt-5" } as never,
});

const withProjectMode = (
  mode: "worktree" | "local" | null,
  patch: Partial<ServerSettingsValue> = {},
): ServerSettingsValue => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...patch,
  projectSettingsFolded: true,
  projectSettingsOverrides: mode === null ? {} : { [projectId]: { defaultThreadEnvMode: mode } },
});

describe("scheduledTaskWorkspaceStrategy", () => {
  const strategy = (settings: ServerSettingsValue | null, boundToThread = false) =>
    OrchestratorMcpService.scheduledTaskWorkspaceStrategy({
      boundToThread,
      resolved: settings === null ? null : resolveProjectSettings(settings, projectId),
      separateClones: false,
    });

  it("keeps the project folder unless the project's Use worktrees is on", () => {
    expect(strategy(withProjectMode(null))).toEqual({ type: "root" });
    expect(strategy(withProjectMode("local"))).toEqual({ type: "root" });
    expect(strategy(null)).toEqual({ type: "root" });
    // An environment-wide worktree default is not the project's own choice.
    expect(strategy({ ...withProjectMode(null), defaultThreadEnvMode: "worktree" })).toEqual({
      type: "root",
    });
  });

  it("gives each run a worktree off main when Use worktrees is on", () => {
    expect(strategy(withProjectMode("worktree"))).toEqual({
      type: "worktree",
      baseRef: "main",
      startFromOrigin: true,
    });
    expect(strategy(withProjectMode("worktree", { newWorktreesStartFromOrigin: false }))).toEqual({
      type: "worktree",
      baseRef: "main",
      startFromOrigin: false,
    });
  });

  it("keeps the folder for a bound routine and for an umbrella folder", () => {
    expect(strategy(withProjectMode("worktree"), true)).toEqual({ type: "root" });
    expect(
      OrchestratorMcpService.scheduledTaskWorkspaceStrategy({
        boundToThread: false,
        resolved: resolveProjectSettings(withProjectMode("worktree"), projectId),
        separateClones: true,
      }),
    ).toEqual({ type: "root" });
  });
});

const local: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-here"),
  requestNamespace: "client:desktop",
  thread: undefined,
  client: {
    sessionId: "session",
    principal: { kind: "device", id: "desktop" },
    label: "Desktop",
    access: "full-access",
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const world = (settings: ServerSettingsValue) => {
  const saved: Array<ScheduledTaskUpsertInput> = [];
  const existing = {
    id: ScheduledTaskId.make("task-1"),
    projectId,
    prompt: "Check",
    schedule: { type: "interval", everyMs: 3_600_000 },
    threadId: null,
    workspaceStrategy: { type: "worktree", baseRef: "release", startFromOrigin: false },
    runtimeMode: "full-access",
    interactionMode: "default",
    nextRunAt: null,
    lastRunStatus: "never",
  };
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([]),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [existing] } as never),
          upsert: (input) =>
            Effect.sync(() => {
              saved.push(input);
              return { task: { ...existing, ...input, threadId: input.threadId ?? null } } as never;
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
  const run = <A, E>(
    use: (service: OrchestratorMcpService.OrchestratorMcpService["Service"]) => Effect.Effect<A, E>,
  ) =>
    OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap(use),
      Effect.provide(layer),
      Effect.provideService(
        WorkGrants.WorkGrants,
        WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape,
      ),
      Effect.provideService(
        RemoteWorkers.RemoteWorkers,
        RemoteWorkers.RemoteWorkers.defaultValue() as RemoteWorkers.RemoteWorkersShape,
      ),
      Effect.runPromise,
    );
  return { run, saved };
};

const schedule = { type: "interval", everyMs: 3_600_000 } as const;

describe("routines scheduled over MCP", () => {
  it("start in the project folder when Use worktrees is off", async () => {
    const { run, saved } = world(withProjectMode(null));
    await run((service) => service.scheduleTask(local, { projectId, prompt: "Check", schedule }));
    expect(saved[0]?.workspaceStrategy).toEqual({ type: "root" });
  });

  it("get a worktree per run when Use worktrees is on", async () => {
    const { run, saved } = world(
      withProjectMode("worktree", { newWorktreesStartFromOrigin: false }),
    );
    await run((service) => service.scheduleTask(local, { projectId, prompt: "Check", schedule }));
    expect(saved[0]?.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "main",
      startFromOrigin: false,
    });
  });

  it("keep a stored strategy on an update that does not rebind, and follow the switch on unbind", async () => {
    const { run, saved } = world(withProjectMode(null));
    const id = ScheduledTaskId.make("task-1");
    await run((service) =>
      service.updateScheduledTask(local, { scheduledTaskId: id, prompt: "x" }),
    );
    expect(saved[0]?.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "release",
      startFromOrigin: false,
    });
    await run((service) =>
      service.updateScheduledTask(local, { scheduledTaskId: id, bindToCurrentThread: false }),
    );
    expect(saved[1]?.workspaceStrategy).toEqual({ type: "root" });
  });
});
