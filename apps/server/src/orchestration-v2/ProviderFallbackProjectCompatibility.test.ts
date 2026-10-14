import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type Project,
  type ProjectEnvironmentSettings,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../project/ProjectService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { provider } from "../studio/fixtures.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Threads from "./ThreadManagementService.ts";

const ready = (instance: string, driver: string, usedPercent: number): ServerProvider => ({
  ...provider(instance, driver),
  models: [
    {
      slug: driver + "-model",
      name: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  usageLimits: {
    checkedAt: "2026-10-13T00:00:00Z",
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent,
        resetsAt: "2099-01-01T00:00:00Z",
      },
    ],
  },
});
const claude = ready("claude", "claudeAgent", 100);
// The switch rule's own target lists the model it names, so only folder
// compatibility (never an unusable rule) keeps it out of a restricted project.
const copilot: ServerProvider = (() => {
  const base = ready("copilot", "acpRegistry", 10);
  return {
    ...base,
    models: [
      ...base.models,
      { slug: "opus", name: "Opus", isCustom: false, isDefault: false, capabilities: null },
    ],
  };
})();
const codex = ready("codex", "codex", 20);
const project = (
  id: string,
  additionalFolders: ReadonlyArray<string>,
  repositories: ProjectEnvironmentSettings["repositories"] = [],
) =>
  ({
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: "/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-13T00:00:00Z",
    updatedAt: "2026-10-13T00:00:00Z",
    deletedAt: null,
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      environment: { additionalFolders, repositories },
    },
  }) satisfies Project;

const thread = (projectId: ProjectId, worktreePath: string | null = null) =>
  ({
    ...liveThreadShell(ThreadId.make("thread:" + projectId)),
    projectId,
    worktreePath,
    providerInstanceId: claude.instanceId,
    modelSelection: { instanceId: claude.instanceId, model: "claudeAgent-model" },
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    latestRunId: RunId.make("run:" + projectId),
    activeRunId: null,
    pendingRuntimeRequest: null,
    settledOverride: null,
    runtimeMode: "approval-required" as const,
  }) satisfies OrchestrationV2ThreadShell;

function sweepFixture(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  providers: ReadonlyArray<ServerProvider>,
  failProjectRead = false,
) {
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const snapshot: OrchestrationV2ThreadShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 0,
    threads,
    archivedThreads: [],
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        failProjectRead
          ? Effect.fail(
              new Projects.ProjectOperationError({
                operation: "read-project",
                projectId: id,
                cause: "fixture read failure",
              }),
            )
          : Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === id))),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providerLimitAction: "switch",
        providerLimitSwitchAtPercent: 95,
        providerLimitFallbackModelSelection: { instanceId: copilot.instanceId, model: "opus" },
      }),
    }),
    // Fallback only trusts a fresh usage read, so each sweep sees one taken now.
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.map(Clock.currentTimeMillis, (nowMs) =>
        providers.map((entry) =>
          entry.usageLimits === undefined
            ? entry
            : {
                ...entry,
                usageLimits: {
                  ...entry.usageLimits,
                  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
                },
              },
        ),
      ),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.die(new Error("Billing operations are outside this switch rule.")),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.succeed(snapshot),
      getThreadShell: (id) => Effect.succeed(threads.find((thread) => thread.id === id) ?? null),
      getThreadRecords: (id) =>
        Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId: id })),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
  return Effect.gen(function* () {
    const sweep = yield* makeSweep;
    yield* sweep();
    return dispatched;
  }).pipe(Effect.provide(dependencies), Effect.provideService(ProviderFallbackEnv, {}));
}

it.effect("sweeps each project with its own folder-compatible fallback candidates", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    const restricted = project("restricted", ["/approved-a", "/approved-b"]);
    const legacy = project("legacy", []);
    const commands = yield* sweepFixture(
      [restricted, legacy],
      [thread(restricted.id), thread(legacy.id)],
      [claude, copilot, codex],
    );
    expect(commands).toMatchObject([
      {
        type: "message.dispatch",
        threadId: "thread:restricted",
        modelSelection: { instanceId: codex.instanceId },
      },
      {
        type: "message.dispatch",
        threadId: "thread:legacy",
        modelSelection: { instanceId: copilot.instanceId },
      },
    ]);
    expect(restricted.workspaceSettings?.coordinatorModelSelection).toBeNull();
  }),
);
it.effect("retains ACP fallback only for the thread's actual full-access default policy", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    const restricted = project("restricted", ["/approved"]);
    for (const interactionMode of ["default", "plan"] as const) {
      const current = {
        ...thread(restricted.id),
        runtimeMode: "full-access" as const,
        interactionMode,
      };
      const commands = yield* sweepFixture([restricted], [current], [claude, copilot, codex]);
      expect(commands).toMatchObject([
        {
          modelSelection: {
            instanceId: interactionMode === "default" ? copilot.instanceId : codex.instanceId,
          },
        },
      ]);
    }
  }),
);

it.effect("does not dispatch when project permissions are missing or cannot be read", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    const restricted = project("restricted", ["/approved"]);
    const missing = yield* sweepFixture([], [thread(restricted.id)], [claude, copilot, codex]);
    const failed = yield* sweepFixture(
      [restricted],
      [thread(restricted.id)],
      [claude, copilot, codex],
      true,
    );
    expect(missing).toEqual([]);
    expect(failed).toEqual([]);
  }),
);

it.effect("keeps the configured project root grant beside a worktree out of ACP fallback", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    const configured = project(
      "configured",
      [],
      [{ id: "code", url: "https://github.com/example/code", localPath: "/project/code" }],
    );
    const legacy = project("legacy", []);
    const commands = yield* sweepFixture(
      [configured, legacy],
      [thread(configured.id, "/worktree"), thread(legacy.id, "/worktree")],
      [claude, copilot, codex],
    );
    expect(
      commands.map((command) =>
        "modelSelection" in command ? command.modelSelection?.instanceId : null,
      ),
    ).toEqual([codex.instanceId, copilot.instanceId]);
  }),
);

it.effect(
  "does not fall back to the incompatible rule target when compatible providers have no room",
  () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const restricted = project("restricted", ["/approved"]);
      const commands = yield* sweepFixture(
        [restricted],
        [thread(restricted.id)],
        [claude, copilot],
      );
      expect(commands).toEqual([]);
    }),
);
