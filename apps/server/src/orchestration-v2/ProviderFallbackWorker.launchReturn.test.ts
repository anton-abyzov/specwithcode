import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import { it } from "@effect/vitest";
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
  makeSweep,
  PROVIDER_FALLBACK_SWEEP_INTERVAL_MS,
  ProviderFallbackEnv,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// 1339: a worker that started on a stand-in because its pick had no room
// goes back to the pick once a usage read shows the pick has room.
const movedAt = Date.parse("2026-10-26T12:00:00.000Z");
const resetAt = "2026-10-26T15:00:00.000Z";
const opus = "claude-opus-5-5";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const pick = { instanceId: claudeId, model: opus };
const returnId = `limit-launch-return:t1:${claudeId}/${opus}`;
const project = {
  id: ProjectId.make("launch-return"),
  title: "Launch return",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  deletedAt: null,
};
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: { instanceId: codexId, model: "gpt-6" },
  providerLimitSwitchAtPercent: 90,
  providerLimitWaitUnderMinutes: 0,
};

function withWindow(
  base: ServerProvider,
  model: string,
  usedPercent: number,
  resetsAt = resetAt,
): ServerProvider {
  return {
    ...base,
    models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  };
}

// The worker launched on Codex because Claude had no room, and ran r1 there.
const r1 = {
  id: RunId.make("r1"),
  threadId: ThreadId.make("t1"),
  ordinal: 1,
  providerInstanceId: codexId,
  modelSelection: { instanceId: codexId, model: "gpt-6" },
  providerThreadId: null,
  userMessageId: "m1" as never,
  rootNodeId: "r1-root" as never,
  activeAttemptId: null,
  status: "completed" as const,
  queueHeld: false,
  requestedAt: DateTime.makeUnsafe(movedAt - 60_000),
  startedAt: DateTime.makeUnsafe(movedAt - 60_000),
  completedAt: DateTime.makeUnsafe(movedAt - 30_000),
  checkpointId: null,
  contextHandoffId: null,
};
type TestRun = Omit<typeof r1, "status"> & { readonly status: "completed" | "failed" };

const shell = {
  id: ThreadId.make("t1"),
  projectId: project.id,
  providerInstanceId: codexId,
  modelSelection: { instanceId: codexId, model: "gpt-6" },
  status: "completed" as const,
  lastErrorClass: null,
  usageLimitResetAt: null,
  latestRunId: r1.id,
  latestRunCompletedAt: r1.completedAt,
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
};

interface World {
  /** What the thread record holds: a pick clears it at write time. */
  launch: typeof pick | null;
  claude: ServerProvider;
  settings: ServerSettings;
  /** A person's Stop on the latest run. */
  stopped: boolean;
  /** The thread's runs, oldest first; the last is the latest. */
  runs: ReadonlyArray<TestRun>;
  /** Turn items besides a person's Stop. */
  turnItems: ReadonlyArray<unknown>;
  readonly dispatched: OrchestrationV2ServerCommand[];
}

const world = (claudeUsed: number, overrides: Partial<World> = {}): World => ({
  launch: pick,
  claude: withWindow(provider(claudeId, "claudeAgent", movedAt), opus, claudeUsed),
  settings,
  stopped: false,
  runs: [r1],
  turnItems: [],
  dispatched: [],
  ...overrides,
});

function shellOf(state: World) {
  const latest = state.runs.at(-1)!;
  return { ...shell, latestRunId: latest.id, latestRunCompletedAt: latest.completedAt };
}

function layers(state: World) {
  return Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(state.settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(() => [
        state.claude,
        withWindow(provider(codexId, "codex", movedAt), "gpt-6", 30),
      ]),
      refreshInstance: () => Effect.succeed([]),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.sync(() => ({ threads: [shellOf(state)] }) as never),
      getThreadShell: () => Effect.sync(() => shellOf(state) as never),
      getThreadRecords: (_threadId, _fields, filter) =>
        Effect.sync(
          () =>
            ({
              thread: {
                ...shellOf(state),
                limitPreswitchFrom: null,
                launchFallbackFrom: state.launch,
                limitRecovery: null,
              },
              runs: state.runs,
              turnItems: [
                ...state.turnItems,
                ...(state.stopped && filter?.turnItemTypes?.includes("run_interrupt_request")
                  ? [
                      {
                        type: "run_interrupt_request",
                        runId: shellOf(state).latestRunId,
                        message: "Stop",
                      },
                    ]
                  : []),
              ],
              runtimeRequests: [],
              nodes: [],
              messages: [],
              providerThreads: [],
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
}

/** One server lifetime: a fresh sweep, with nothing remembered from before. */
const sweepAt = (state: World, atMs: number, sweeps = 1) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(atMs);
    const sweep = yield* makeSweep;
    for (let index = 0; index < sweeps; index++) {
      if (index > 0) yield* TestClock.adjust(PROVIDER_FALLBACK_SWEEP_INTERVAL_MS);
      yield* sweep();
    }
    return state.dispatched.map((command) => command.commandId);
  }).pipe(Effect.provide(layers(state)), Effect.provideService(ProviderFallbackEnv, {}));

const later = movedAt + 60 * 60_000;

describe("the way back from a launch fallback", () => {
  it.effect("returns to the pick once a read shows it below the switch threshold", () =>
    Effect.gen(function* () {
      const state = world(40);
      expect(yield* sweepAt(state, later)).toEqual([returnId]);
      expect(state.dispatched[0]).toMatchObject({
        type: "thread.model-selection.set",
        modelSelection: pick,
      });
    }),
  );

  it.effect("stays while the pick is still at the threshold, then returns", () =>
    Effect.gen(function* () {
      const state = world(92);
      expect(yield* sweepAt(state, later)).toEqual([]);
      state.claude = withWindow(provider(claudeId, "claudeAgent", later), opus, 20);
      expect(yield* sweepAt(state, later + 5 * 60_000)).toEqual([returnId]);
    }),
  );

  it.effect("never reverses a pick made by hand, which clears the origin", () =>
    Effect.gen(function* () {
      expect(yield* sweepAt(world(10, { launch: null }), later)).toEqual([]);
    }),
  );

  it.effect("leaves a pick with no usage read to go back by hand", () =>
    Effect.gen(function* () {
      const unread = { ...provider(claudeId, "claudeAgent", movedAt), usageLimits: undefined };
      expect(yield* sweepAt(world(10, { claude: unread }), later)).toEqual([]);
    }),
  );
});
