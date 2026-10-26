import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2LimitPreswitchOrigin,
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
import {
  limitFallbackPairing,
  limitPreswitchAfterMove,
  threadModelIdentity,
} from "@specweave-studio/shared/threadModelIdentity";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  makeSweep,
  PROVIDER_FALLBACK_SWEEP_INTERVAL_MS,
  ProviderFallbackEnv,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// 1075: the sweep sends an idle thread the usage pre-switch moved back to
// its original model once that model has room or the window resets.
const movedAt = Date.parse("2026-10-26T12:00:00.000Z");
const resetAt = "2026-10-26T15:00:00.000Z";
const opus = "claude-opus-5-5";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const preswitchId = CommandId.make(`limit-preswitch:t1:${claudeId}:${resetAt}`);
const returnId = `limit-preswitch-return:t1:${claudeId}:${resetAt}`;
const origin: OrchestrationV2LimitPreswitchOrigin = {
  modelSelection: { instanceId: claudeId, model: opus },
  commandId: preswitchId,
  resetAt,
};
const project = {
  id: ProjectId.make("preswitch-return"),
  title: "Pre-switch return",
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

// The thread ran r1 on Claude, which then reached 92%: the pre-switch moved
// it to Codex before its next turn, so it has no run there yet.
const r1 = {
  id: RunId.make("r1"),
  threadId: ThreadId.make("t1"),
  ordinal: 1,
  providerInstanceId: claudeId,
  modelSelection: { instanceId: claudeId, model: opus },
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
  preswitch: OrchestrationV2LimitPreswitchOrigin | null;
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
  preswitch: origin,
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
                limitPreswitchFrom: state.preswitch,
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

describe("the way back from a usage pre-switch", () => {
  it.effect("returns once the original has room below the switch threshold", () =>
    Effect.gen(function* () {
      const state = world(40);
      expect(yield* sweepAt(state, later)).toEqual([returnId]);
      expect(state.dispatched[0]).toMatchObject({
        type: "thread.model-selection.set",
        modelSelection: { instanceId: claudeId, model: opus },
      });
    }),
  );

  it.effect("stays while the original is still at the threshold", () =>
    Effect.gen(function* () {
      expect(yield* sweepAt(world(92), later)).toEqual([]);
    }),
  );

  it.effect("returns once the window it moved in has reset", () =>
    Effect.gen(function* () {
      // The read still lists the old window at 95%, but it has reset.
      const state = world(95);
      expect(yield* sweepAt(state, Date.parse(resetAt) + 60_000)).toEqual([returnId]);
    }),
  );

  it.effect("never reverses a pick made after the move", () =>
    Effect.gen(function* () {
      // The person picked another model, then the fallback's again: the pick
      // cleared the origin, though the thread sits on the same model.
      const state = world(92);
      expect(yield* sweepAt(state, later)).toEqual([]);
      state.preswitch = null;
      state.claude = withWindow(provider(claudeId, "claudeAgent", later), opus, 10);
      expect(yield* sweepAt(state, later + 60_000)).toEqual([]);
    }),
  );

  it.effect("never reverses a pick learned between sweeps of one server lifetime", () =>
    Effect.gen(function* () {
      const state = world(92);
      const sweeps = Effect.gen(function* () {
        yield* TestClock.setTime(later);
        const sweep = yield* makeSweep;
        yield* sweep();
        // The origin was read while the original was full; the person picks now.
        state.preswitch = null;
        state.claude = withWindow(provider(claudeId, "claudeAgent", later), opus, 10);
        yield* TestClock.adjust(PROVIDER_FALLBACK_SWEEP_INTERVAL_MS);
        yield* sweep();
        return state.dispatched.map((command) => command.commandId);
      }).pipe(Effect.provide(layers(state)), Effect.provideService(ProviderFallbackEnv, {}));
      expect(yield* sweeps).toEqual([]);
    }),
  );

  it.effect("returns after a restart in between, from the thread's own record", () =>
    Effect.gen(function* () {
      const state = world(92);
      expect(yield* sweepAt(state, later)).toEqual([]);
      // The service restarts: a new sweep with nothing in memory reads the record.
      state.claude = withWindow(provider(claudeId, "claudeAgent", later), opus, 20);
      expect(yield* sweepAt(state, later + 5 * 60_000)).toEqual([returnId]);
    }),
  );

  it.effect("never returns to an excluded origin", () =>
    Effect.gen(function* () {
      const state = world(10, {
        settings: { ...settings, providerLimitExcludedModels: [{ model: opus }] },
      });
      expect(yield* sweepAt(state, Date.parse(resetAt) + 60_000, 2)).toEqual([]);
    }),
  );

  it.effect("never returns to a per-token origin", () =>
    Effect.gen(function* () {
      const base = withWindow(provider(claudeId, "claudeAgent", movedAt), opus, 10);
      const state = world(10, { claude: { ...base, auth: { ...base.auth, type: "apiKey" } } });
      expect(yield* sweepAt(state, later)).toEqual([]);
    }),
  );

  it.effect("never moves a thread a person stopped", () =>
    Effect.gen(function* () {
      expect(yield* sweepAt(world(10, { stopped: true }), later)).toEqual([]);
    }),
  );

  it.effect("sends the way back once per origin", () =>
    Effect.gen(function* () {
      const state = world(10);
      expect(yield* sweepAt(state, later, 3)).toEqual([returnId]);
    }),
  );
});

// Claude stopped r1 on its limit and the limit fallback continued it on
// Codex as r2, which is still the latest run when the pre-switch comes.
const stoppedAt = movedAt - 3 * 60 * 60_000;
const stoppedResetAt = "2026-10-26T10:00:00.000Z";
const stoppedOnLimit = {
  ...r1,
  status: "failed" as const,
  requestedAt: DateTime.makeUnsafe(stoppedAt - 60_000),
  startedAt: DateTime.makeUnsafe(stoppedAt - 60_000),
  completedAt: DateTime.makeUnsafe(stoppedAt),
};
const continuation = {
  ...r1,
  id: RunId.make("r2"),
  ordinal: 2,
  providerInstanceId: codexId,
  modelSelection: { instanceId: codexId, model: "gpt-6" },
  userMessageId: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1` as never,
  rootNodeId: "r2-root" as never,
  requestedAt: DateTime.makeUnsafe(stoppedAt + 10_000),
  startedAt: DateTime.makeUnsafe(stoppedAt + 10_000),
  completedAt: DateTime.makeUnsafe(stoppedAt + 60_000),
};
const limitStop = {
  type: "error",
  runId: stoppedOnLimit.id,
  failure: {
    class: "usage_limit",
    message: "limit",
    code: null,
    retryable: false,
    resetAt: stoppedResetAt,
  },
};
const continued = (overrides: Partial<World> = {}) =>
  world(40, { runs: [stoppedOnLimit, continuation], turnItems: [limitStop], ...overrides });

describe("a pre-switch after a limit-fallback continuation", () => {
  it.effect("returns the pre-switch after a restart once the continuation went home", () =>
    Effect.gen(function* () {
      // The sweep sent r2 home (limit-return:t1:r2), Claude reached 92% and
      // the pre-switch moved the idle thread to Codex again. After a restart
      // only the pre-switch has somewhere to go back to.
      const state = continued();
      const sent = yield* sweepAt(state, later);
      expect(sent).toEqual([returnId]);
      expect(sent.filter((id) => id.startsWith("limit-return:"))).toEqual([]);
      expect(state.dispatched[0]).toMatchObject({
        type: "thread.model-selection.set",
        modelSelection: { instanceId: claudeId, model: opus },
      });
    }),
  );

  it.effect("returns to the pre-switch origin over an unsent continuation home", () =>
    Effect.gen(function* () {
      // The person picked Sonnet on the continuation's fallback, and the
      // pre-switch then moved Sonnet to Codex: the thread goes back to
      // Sonnet, not to Opus, which they had moved off.
      const sonnet = { instanceId: claudeId, model: "claude-sonnet-5" };
      const state = continued({ preswitch: { ...origin, modelSelection: sonnet } });
      state.claude = withWindow(provider(claudeId, "claudeAgent", movedAt), "claude-sonnet-5", 40);
      expect(yield* sweepAt(state, later)).toEqual([returnId]);
      expect(state.dispatched[0]).toMatchObject({
        type: "thread.model-selection.set",
        modelSelection: sonnet,
      });
    }),
  );
});

// One server lifetime in which the thread really moves: each model-selection
// command the sweep sends lands on the thread as the orchestrator writes it.
interface LiveWorld {
  selection: { instanceId: ProviderInstanceId; model: string };
  preswitch: OrchestrationV2LimitPreswitchOrigin | null;
  /** Claude's usage, read fresh at each sweep. */
  claude: { usedPercent: number; resetsAt: string };
  settings: ServerSettings;
  readonly dispatched: OrchestrationV2ServerCommand[];
  /** The thread's runs and turn items (default: r1 only). */
  runs?: ReadonlyArray<TestRun>;
  turnItems?: ReadonlyArray<unknown>;
}

// The identity the shell carries, derived as the projection derives it.
function liveShell(state: LiveWorld) {
  const runs = state.runs ?? [r1];
  const latest = runs.at(-1) ?? r1;
  const pairing = limitFallbackPairing(
    runs.map((run) => ({ id: String(run.userMessageId), runId: run.id })),
    runs as never,
    state.selection,
    null,
    state.preswitch,
  );
  return {
    ...shell,
    latestRunId: latest.id,
    latestRunCompletedAt: latest.completedAt,
    providerInstanceId: state.selection.instanceId,
    modelSelection: state.selection,
    modelIdentity: threadModelIdentity({
      thread: state.selection,
      fallbackFrom: (pairing?.original as LiveWorld["selection"] | undefined) ?? null,
      launched: pairing?.launched === true,
      preswitched: pairing?.preswitched === true,
    }),
  };
}

function liveLayers(state: LiveWorld) {
  return Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(state.settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.map(DateTime.now, (now) => {
        const at = DateTime.toEpochMillis(now);
        return [
          withWindow(
            provider(claudeId, "claudeAgent", at),
            opus,
            state.claude.usedPercent,
            state.claude.resetsAt,
          ),
          withWindow(provider(codexId, "codex", at), "gpt-6", 30),
        ];
      }),
      refreshInstance: () => Effect.succeed([]),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.sync(() => ({ threads: [liveShell(state)] }) as never),
      getThreadShell: () => Effect.sync(() => liveShell(state) as never),
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              thread: { ...liveShell(state), limitPreswitchFrom: state.preswitch },
              runs: state.runs ?? [r1],
              turnItems: state.turnItems ?? [],
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
          if (command.type === "thread.model-selection.set" && command.modelSelection) {
            const to = command.modelSelection as LiveWorld["selection"];
            const next = limitPreswitchAfterMove(
              state.preswitch,
              state.selection,
              to,
              command.commandId.startsWith("limit-"),
              command.commandId,
            );
            state.preswitch =
              next == null ? null : { ...next, commandId: CommandId.make(next.commandId) };
            state.selection = to;
          }
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
}

// The sweep itself sends no pre-switch (providerLimitStep acts on limit
// stops only), so these apply one as the orchestrator records it.
function preswitchOnto(state: LiveWorld, commandId: string) {
  const to = { instanceId: codexId, model: "gpt-6" };
  const next = limitPreswitchAfterMove(state.preswitch, state.selection, to, true, commandId);
  state.preswitch = next == null ? null : { ...next, commandId: CommandId.make(next.commandId) };
  state.selection = to;
}

describe("the way back from a repeated usage pre-switch", () => {
  const live = (overrides: Partial<LiveWorld> = {}): LiveWorld => ({
    selection: { instanceId: codexId, model: "gpt-6" },
    preswitch: origin,
    claude: { usedPercent: 40, resetsAt: resetAt },
    settings,
    dispatched: [],
    ...overrides,
  });
  const ids = (state: LiveWorld) => state.dispatched.map((command) => command.commandId);
  const originOf = (state: LiveWorld) => state.preswitch;
  const run = (state: LiveWorld, body: (sweep: () => Effect.Effect<void>) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(later);
      const sweep = yield* makeSweep;
      yield* body(() => Effect.orDie(Effect.asVoid(sweep())));
    }).pipe(Effect.provide(liveLayers(state)), Effect.provideService(ProviderFallbackEnv, {}));
  const next = () => TestClock.adjust(PROVIDER_FALLBACK_SWEEP_INTERVAL_MS);

  it.effect("returns again after a second pre-switch to the same model", () =>
    Effect.gen(function* () {
      const state = live();
      const nextReset = "2026-10-26T20:00:00.000Z";
      const second = `limit-preswitch:t1:${claudeId}:${nextReset}`;
      yield* run(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          expect(ids(state)).toEqual([returnId]);
          expect(state.selection).toEqual({ instanceId: claudeId, model: opus });
          // Claude passes 90% in its next window: the idle thread moves to Codex again.
          state.claude = { usedPercent: 92, resetsAt: nextReset };
          preswitchOnto(state, second);
          yield* next();
          yield* sweep();
          expect(ids(state)).toEqual([returnId]);
          // Claude has room again: the second pre-switch goes back too.
          state.claude = { usedPercent: 30, resetsAt: nextReset };
          yield* next();
          yield* sweep();
          expect(ids(state)).toEqual([
            returnId,
            `limit-preswitch-return:t1:${claudeId}:${nextReset}`,
          ]);
          expect(state.selection).toEqual({ instanceId: claudeId, model: opus });
        }),
      );
    }),
  );

  it.effect("returns a pre-switch after the continuation went home in one lifetime", () =>
    Effect.gen(function* () {
      // Claude stopped r1 on its limit and r2 continued on Codex. The sweep
      // sends r2 home; Claude then reaches 92% and the pre-switch moves the
      // idle thread onto the same Codex model, with r2 still the latest run.
      const state = live({
        preswitch: null,
        runs: [stoppedOnLimit, continuation],
        turnItems: [limitStop],
      });
      yield* run(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          expect(ids(state)).toEqual(["limit-return:t1:r2"]);
          expect(state.selection).toEqual({ instanceId: claudeId, model: opus });
          state.claude = { usedPercent: 92, resetsAt: resetAt };
          preswitchOnto(state, preswitchId);
          yield* next();
          yield* sweep();
          expect(ids(state)).toEqual(["limit-return:t1:r2"]);
          state.claude = { usedPercent: 30, resetsAt: resetAt };
          yield* next();
          yield* sweep();
          expect(ids(state)).toEqual(["limit-return:t1:r2", returnId]);
          expect(state.selection).toEqual({ instanceId: claudeId, model: opus });
        }),
      );
    }),
  );

  it.effect("returns a pre-switch onto a model the person had picked before", () =>
    Effect.gen(function* () {
      // The person put the thread on Codex by hand: no way back to send.
      const state = live({ preswitch: null });
      yield* run(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          expect(ids(state)).toEqual([]);
          // They pick Claude again; at 92% the pre-switch moves the thread back to Codex.
          state.selection = { instanceId: claudeId, model: opus };
          state.claude = { usedPercent: 92, resetsAt: resetAt };
          yield* next();
          yield* sweep();
          preswitchOnto(state, preswitchId);
          yield* next();
          yield* sweep();
          expect(ids(state)).toEqual([]);
          state.claude = { usedPercent: 30, resetsAt: resetAt };
          yield* next();
          yield* sweep();
          expect(ids(state)).toEqual([returnId]);
        }),
      );
    }),
  );

  it.effect("follows a newer pre-switch from another model", () =>
    Effect.gen(function* () {
      const sonnet = "claude-sonnet-5";
      const state = live({ claude: { usedPercent: 92, resetsAt: resetAt } });
      yield* run(state, (sweep) =>
        Effect.gen(function* () {
          // The cached origin is Opus; the person then picks Sonnet, which the
          // next pre-switch moves off, from the same latest run.
          yield* sweep();
          state.preswitch = null;
          state.selection = { instanceId: claudeId, model: sonnet };
          preswitchOnto(state, preswitchId);
          expect(originOf(state)?.modelSelection.model).toBe(sonnet);
          state.claude = { usedPercent: 30, resetsAt: resetAt };
          yield* next();
          yield* sweep();
          expect(state.dispatched).toHaveLength(1);
          expect(state.dispatched[0]).toMatchObject({
            commandId: returnId,
            modelSelection: { instanceId: claudeId, model: sonnet },
          });
        }),
      );
    }),
  );
});

// Pre-switched from Codex to a Claude subscription, the thread then stopped on
// that subscription's limit and continued on a Claude API key (#599).
describe("a pre-switch before a continuation on API credits", () => {
  const apiId = ProviderInstanceId.make("claudeApi");
  const codexOrigin: OrchestrationV2LimitPreswitchOrigin = {
    modelSelection: { instanceId: codexId, model: "gpt-6" },
    commandId: CommandId.make(`limit-preswitch:t1:${codexId}:2026-10-30T00:00:00.000Z`),
    resetAt: "2026-10-30T00:00:00.000Z",
  };
  const at = (hoursBefore: number, plusMs = 0) =>
    DateTime.makeUnsafe(movedAt - hoursBefore * 3_600_000 + plusMs);
  const onCodex = {
    ...r1,
    id: RunId.make("ra"),
    providerInstanceId: codexId,
    modelSelection: { instanceId: codexId, model: "gpt-6" },
    requestedAt: at(5),
    startedAt: at(5),
    completedAt: at(5, 1_000),
  };
  const stoppedOnClaude = {
    ...r1,
    id: RunId.make("rb"),
    ordinal: 2,
    status: "failed" as const,
    userMessageId: "m2" as never,
    requestedAt: at(4),
    startedAt: at(4),
    completedAt: at(4, 1_000),
  };
  const onApi = {
    ...r1,
    id: RunId.make("rc"),
    ordinal: 3,
    providerInstanceId: apiId,
    modelSelection: { instanceId: apiId, model: opus },
    userMessageId: "limit-api:t1:rb" as never,
    requestedAt: at(4, 5_000),
    startedAt: at(4, 5_000),
    completedAt: at(4, 60_000),
  };
  const runs = [onCodex, stoppedOnClaude, onApi];
  const stop = {
    type: "error",
    runId: stoppedOnClaude.id,
    failure: {
      class: "usage_limit",
      message: "limit",
      code: null,
      retryable: false,
      resetAt: "2026-10-26T10:00:00.000Z",
    },
  };
  const sweepOnApi = (ruleOn: boolean) => {
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const selection = { instanceId: apiId, model: opus };
    const pairing = limitFallbackPairing(
      runs.map((run) => ({ id: String(run.userMessageId), runId: run.id })),
      runs as never,
      selection,
      null,
      codexOrigin,
    );
    const onApiShell = {
      ...shell,
      providerInstanceId: apiId,
      modelSelection: selection,
      latestRunId: onApi.id,
      latestRunCompletedAt: onApi.completedAt,
      modelIdentity: threadModelIdentity({
        thread: selection,
        fallbackFrom: (pairing?.original as typeof selection | undefined) ?? null,
        preswitched: pairing?.preswitched === true,
      }),
    };
    const apiBase = provider(apiId, "claudeAgent", movedAt);
    return Effect.gen(function* () {
      yield* TestClock.setTime(later);
      const sweep = yield* makeSweep;
      yield* sweep();
      return dispatched.map((command) => command.commandId);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Projects.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
          }),
          fallbackPolicyTestLayer({ ...settings, providerLimitUseApiCredits: ruleOn }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Effect.sync(() => [
              withWindow(
                provider(claudeId, "claudeAgent", later),
                opus,
                10,
                "2026-10-26T17:00:00.000Z",
              ),
              {
                ...withWindow(apiBase, opus, 0),
                usageLimits: undefined,
                auth: { ...apiBase.auth, type: "apiKey" },
              } as ServerProvider,
              withWindow(
                provider(codexId, "codex", later),
                "gpt-6",
                95,
                "2026-10-30T00:00:00.000Z",
              ),
            ]),
            refreshInstance: () => Effect.succeed([]),
          }),
          Layer.mock(Instances.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(undefined),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () => Effect.sync(() => ({ threads: [onApiShell] }) as never),
            getThreadShell: () => Effect.sync(() => onApiShell as never),
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { ...onApiShell, limitPreswitchFrom: codexOrigin, limitRecovery: null },
                    runs,
                    turnItems: [stop],
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
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] };
              }),
          }),
        ),
      ),
      Effect.provideService(ProviderFallbackEnv, {}),
    );
  };

  it.effect("leaves per-token credits for the subscription, with the rule on or off", () =>
    Effect.gen(function* () {
      expect(yield* sweepOnApi(true)).toEqual(["limit-api-return:t1:rc"]);
      expect(yield* sweepOnApi(false)).toEqual(["limit-api-return:t1:rc"]);
    }),
  );
});
