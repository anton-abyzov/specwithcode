import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  makeSweep,
  ProviderFallbackEnv,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// 1460 through the real sweep: Copilot and Cursor both refuse Gemini 4 Neon
// while their account reads show room; the track's Claude Opus 5.5 has room.
const stoppedAt = Date.parse("2026-11-24T15:14:00.000Z");
const neon = "gemini-4-neon";
const opus = "claude-opus-5-5";
const copilotId = ProviderInstanceId.make("acpRegistry_copilot");
const cursorId = ProviderInstanceId.make("cursor");
const claudeId = ProviderInstanceId.make("claudeAgent");
const project = {
  id: ProjectId.make("ping-pong"),
  title: "Ping-pong project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
  deletedAt: null,
};

function withRoom(base: ServerProvider, slug: string, usedPercent: number): ServerProvider {
  return {
    ...base,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        {
          id: "monthly",
          kind: "weekly",
          label: "Monthly",
          usedPercent,
          resetsAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    },
  };
}

const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
  message: string,
  completedAt: number,
) => ({
  id: RunId.make(id),
  threadId: ThreadId.make("t1"),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
  providerThreadId: null,
  userMessageId: message as never,
  rootNodeId: `${id}-root` as never,
  activeAttemptId: null,
  status: "failed" as const,
  requestedAt: DateTime.makeUnsafe(completedAt - 2_000),
  startedAt: DateTime.makeUnsafe(completedAt - 2_000),
  completedAt: DateTime.makeUnsafe(completedAt),
  checkpointId: null,
  contextHandoffId: null,
});
type Run = ReturnType<typeof run>;

const stoppedShell = (latest: Run) => ({
  id: ThreadId.make("t1"),
  projectId: project.id,
  providerInstanceId: latest.providerInstanceId,
  modelSelection: latest.modelSelection,
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  usageLimitResetAt: null,
  latestRunId: latest.id,
  latestRunStartedAt: latest.startedAt,
  latestRunCompletedAt: latest.completedAt,
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
});

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 90,
  providerLimitWaitUnderMinutes: 0,
  defaultModelSelection: { instanceId: claudeId, model: opus },
  threadModelMode: "tracks",
  modelLanes: { routine: [{ instanceId: claudeId, model: opus }], complex: [] },
} as ServerSettings;

function harness() {
  const state = {
    providers: [
      withRoom(provider(copilotId, "acpRegistry", stoppedAt), neon, 40),
      withRoom(provider(cursorId, "cursor", stoppedAt), neon, 40),
      withRoom(provider(claudeId, "claudeAgent", stoppedAt), opus, 10),
    ],
    threads: [] as ReturnType<typeof stoppedShell>[],
    runs: [] as Run[],
    dispatched: [] as OrchestrationV2ServerCommand[],
  };
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(() => state.providers),
      refreshInstance: () => Effect.sync(() => state.providers),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.sync(() => ({ threads: state.threads }) as never),
      getThreadShell: (threadId) =>
        Effect.sync(
          () => (state.threads.find((thread) => thread.id === threadId) ?? null) as never,
        ),
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              runs: state.runs,
              turnItems: [],
              runtimeRequests: [],
              nodes: [],
              providerThreads: [{ appThreadId: "t1", nativeThreadRef: "native" }],
            }) as never,
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          state.dispatched.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(stoppedAt + 5_000);
    const sweep = yield* makeSweep;
    return { state, sweep };
  }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
}

const selection = (command: OrchestrationV2ServerCommand | undefined) =>
  command !== undefined && "modelSelection" in command ? command.modelSelection : undefined;

describe("the sweep between two spent sources of one model", () => {
  itEffect.effect("never sends the thread back to the source that just refused", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness();
      const r1 = run("r1", 1, copilotId, neon, "m1", stoppedAt);
      state.runs = [r1];
      state.threads = [stoppedShell(r1)];
      yield* sweep();
      expect(state.dispatched).toHaveLength(1);
      expect(state.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        messageId: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1`,
        modelSelection: { instanceId: cursorId, model: neon },
      });

      // Cursor refuses too; its read and Copilot's still show room.
      const r2 = run(
        "r2",
        2,
        cursorId,
        neon,
        `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1`,
        stoppedAt + 9_000,
      );
      state.runs = [r1, r2];
      state.threads = [stoppedShell(r2)];
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.dispatched).toHaveLength(2);
      // Before 1460 this was Copilot again, 918 times.
      expect(selection(state.dispatched[1])).toEqual({ instanceId: claudeId, model: opus });
    }),
  );
});
