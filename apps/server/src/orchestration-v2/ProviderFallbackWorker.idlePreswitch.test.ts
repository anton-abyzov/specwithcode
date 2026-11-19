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
import { describe, expect, it as itPure } from "vite-plus/test";
import {
  limitFallbackPairing,
  limitPreswitchAfterMove,
  threadModelIdentity,
} from "@specweave-studio/shared/threadModelIdentity";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import { limitHandoffTrigger, MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import { PRESWITCH_TURN_STARTED } from "./limitPreswitchGuard.ts";
import {
  makeSweep,
  PROVIDER_FALLBACK_SWEEP_INTERVAL_MS,
  ProviderFallbackEnv,
  providerLimitStep,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// 1089: "Switch before the limit" moves an idle thread whose provider reached
// the threshold to the fallback before its next turn, from the sweep itself.
const at = Date.parse("2026-11-19T12:00:00.000Z");
const resetAt = "2026-11-19T15:00:00.000Z";
const opus = "claude-opus-5-5";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const preswitchId = `limit-preswitch:t1:${claudeId}:${resetAt}`;
const returnId = `limit-preswitch-return:t1:${claudeId}:${resetAt}`;
const onClaude = { instanceId: claudeId, model: opus };
const onCodex = { instanceId: codexId, model: "gpt-6" };
const project = {
  id: ProjectId.make("idle-preswitch"),
  title: "Idle pre-switch",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:00:00Z",
  deletedAt: null,
};
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: onCodex,
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
      // An empty reset stands for a window that reports no reset time.
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          ...(resetsAt === "" ? {} : { resetsAt }),
        },
      ],
    },
  };
}

const run = (id: string, threadId: string, selection: typeof onClaude, status: string) => ({
  id: RunId.make(id),
  threadId: ThreadId.make(threadId),
  ordinal: 1,
  providerInstanceId: selection.instanceId,
  modelSelection: selection,
  providerThreadId: null,
  userMessageId: `m-${id}` as never,
  rootNodeId: `${id}-root` as never,
  activeAttemptId: null,
  status,
  queueHeld: false,
  requestedAt: DateTime.makeUnsafe(at - 120_000),
  startedAt: DateTime.makeUnsafe(at - 120_000),
  completedAt: DateTime.makeUnsafe(at - 60_000),
  checkpointId: null,
  contextHandoffId: null,
});

interface Thread {
  readonly id: string;
  selection: typeof onClaude;
  preswitch: OrchestrationV2LimitPreswitchOrigin | null;
  status: "completed" | "failed";
  lastErrorClass: "usage_limit" | null;
  activeRunId: string | null;
  settledOverride: "settled" | null;
  latestRunId: string | null;
  runs: ReadonlyArray<ReturnType<typeof run>>;
  /** A person's Stop on the latest run. */
  stopped: boolean;
  /** A subagent the provider spawned, which takes no messages. */
  providerSubagent?: boolean;
  /** Background work the provider session still hosts. */
  background?: boolean;
  /** Snoozed by a person until an hour from now. */
  snoozed?: boolean;
  /** Sends waiting in a held queue. */
  heldQueued?: number;
  lastError?: string;
}

interface World {
  claudeUsed: number;
  /** When Claude's window resets: a new reset is a new usage window. */
  claudeResetAt: string;
  settings: ServerSettings;
  threads: Thread[];
  /** Dispatches fail with this error while set. */
  failDispatch: boolean;
  /** The next dispatch is refused because a turn beat the move, as the orchestrator does. */
  turnBeatsMove?: boolean;
  /** When Codex's usage was last read; null reads it fresh at every sweep. */
  codexReadAt: number | null;
  /** Instances the sweep asked to read again. */
  readonly refreshed: string[];
  /** The handoff keys the sweep asked another machine about. */
  readonly considered?: string[];
  /** Called on each shell re-read (the admission re-check reads the shell again). */
  onReread?: (thread: Thread) => void;
  readonly dispatched: OrchestrationV2ServerCommand[];
}

const idleThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "t1",
  selection: onClaude,
  preswitch: null,
  status: "completed",
  lastErrorClass: null,
  activeRunId: null,
  settledOverride: null,
  latestRunId: "r1",
  runs: [run("r1", "t1", onClaude, "completed")],
  stopped: false,
  ...overrides,
});

const world = (overrides: Partial<World> = {}): World => ({
  claudeUsed: 92,
  claudeResetAt: resetAt,
  settings,
  threads: [idleThread()],
  failDispatch: false,
  codexReadAt: null,
  refreshed: [],
  dispatched: [],
  ...overrides,
});

// The shell as the projection derives it, model identity included.
function shellOf(thread: Thread) {
  const latest = thread.runs.at(-1);
  const pairing = limitFallbackPairing(
    thread.runs.map((entry) => ({ id: String(entry.userMessageId), runId: entry.id })),
    thread.runs as never,
    thread.selection,
    null,
    thread.preswitch,
  );
  return {
    id: ThreadId.make(thread.id),
    projectId: project.id,
    providerInstanceId: thread.selection.instanceId,
    modelSelection: thread.selection,
    status: thread.status,
    lastErrorClass: thread.lastErrorClass,
    lastError:
      thread.lastError ?? (thread.lastErrorClass === null ? null : "You've hit your usage limit."),
    usageLimitResetAt: thread.lastErrorClass === null ? null : resetAt,
    latestRunId: thread.latestRunId === null ? null : RunId.make(thread.latestRunId),
    latestRunStartedAt: latest?.startedAt ?? null,
    latestRunCompletedAt: latest?.completedAt ?? null,
    activeRunId: thread.activeRunId === null ? null : RunId.make(thread.activeRunId),
    pendingRuntimeRequest: null,
    settledOverride: thread.settledOverride,
    ...(thread.snoozed === true ? { snoozedUntil: DateTime.makeUnsafe(at + 3_600_000) } : {}),
    ...(thread.heldQueued === undefined ? {} : { heldQueuedCount: thread.heldQueued }),
    ...(thread.background === true
      ? { pendingBackgroundTasks: [{ kind: "command", taskId: "task-1" }] }
      : {}),
    ...(thread.providerSubagent === true
      ? {
          creationSource: "provider",
          lineage: {
            parentThreadId: ThreadId.make("coordinator"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("coordinator"),
          },
        }
      : {}),
    archivedAt: null,
    deletedAt: null,
    modelIdentity: threadModelIdentity({
      thread: thread.selection,
      fallbackFrom: (pairing?.original as typeof onClaude | undefined) ?? null,
      launched: pairing?.launched === true,
      preswitched: pairing?.preswitched === true,
    }),
  };
}

const threadOf = (command: OrchestrationV2ServerCommand) =>
  (command as { readonly threadId?: string }).threadId;

function layers(state: World) {
  const find = (threadId: string) => state.threads.find((thread) => thread.id === threadId)!;
  return Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(state.settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.map(DateTime.now, (now) => {
        const ms = DateTime.toEpochMillis(now);
        return [
          withWindow(provider(claudeId, "claudeAgent", ms), opus, state.claudeUsed, state.claudeResetAt),
          withWindow(provider(codexId, "codex", state.codexReadAt ?? ms), "gpt-6", 30),
        ];
      }),
      refreshInstance: (instanceId) =>
        Effect.sync(() => {
          state.refreshed.push(instanceId);
          if (instanceId === codexId) state.codexReadAt = null;
          return [];
        }),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.sync(() => ({ threads: state.threads.map(shellOf) }) as never),
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          const thread = find(threadId);
          state.onReread?.(thread);
          return shellOf(thread) as never;
        }),
      getThreadRecords: (threadId, _fields, filter) =>
        Effect.sync(() => {
          const thread = find(threadId);
          return {
            thread: { ...shellOf(thread), limitPreswitchFrom: thread.preswitch, limitRecovery: null },
            runs: thread.runs,
            turnItems:
              thread.stopped && filter?.turnItemTypes?.includes("run_interrupt_request")
                ? [
                    {
                      type: "run_interrupt_request",
                      runId: thread.latestRunId,
                      message: "Stop",
                    },
                  ]
                : [],
            runtimeRequests: [],
            nodes: [],
            messages: [],
            providerThreads: [],
          } as never;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          state.dispatched.push(command);
          if (state.failDispatch) return yield* Effect.die(new Error("dispatch refused"));
          if (state.turnBeatsMove === true) {
            state.turnBeatsMove = false;
            return yield* Effect.fail({
              _tag: "OrchestratorDispatchError",
              cause: PRESWITCH_TURN_STARTED,
            } as never);
          }
          const thread = find(threadOf(command)!);
          if (command.type === "thread.model-selection.set" && command.modelSelection) {
            // As the orchestrator records it (launchFallbackFields).
            const to = command.modelSelection as typeof onClaude;
            const next = limitPreswitchAfterMove(
              thread.preswitch,
              thread.selection,
              to,
              command.commandId.startsWith("limit-"),
              command.commandId,
            );
            thread.preswitch =
              next == null ? null : { ...next, commandId: CommandId.make(next.commandId) };
            thread.selection = to;
          }
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
}

const sweeps = (state: World, body: (sweep: () => Effect.Effect<void>) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const sweep = yield* makeSweep;
    yield* body(() => Effect.orDie(Effect.asVoid(sweep())));
  }).pipe(
    Effect.provide(layers(state)),
    Effect.provideService(ProviderFallbackEnv, {}),
    Effect.provideService(MachineLimitHandoff, {
      bind: () => Effect.void,
      consider: (input) =>
        Effect.sync(() => {
          state.considered?.push(input.trigger.key);
          return "skipped" as const;
        }),
      holds: () => Effect.succeed(false),
      localTurnBlocked: () => Effect.succeed(false),
      candidates: () => Effect.die("No other machine in these tests"),
    }),
  );
const nextSweep = () => TestClock.adjust(PROVIDER_FALLBACK_SWEEP_INTERVAL_MS);
const ids = (state: World, threadId = "t1") =>
  state.dispatched
    .filter((command) => threadOf(command) === threadId)
    .map((command) => command.commandId);
const once = (state: World) => sweeps(state, (sweep) => sweep());

describe("the idle move before the limit, from the sweep (1089)", () => {
  it.effect("moves an idle thread at the threshold once and records where it came from", () =>
    Effect.gen(function* () {
      const state = world();
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(state.dispatched).toEqual([
        {
          type: "thread.model-selection.set",
          commandId: preswitchId,
          threadId: "t1",
          modelSelection: onCodex,
          expectedModelSelection: onClaude,
        },
      ]);
      expect(state.threads[0]!.preswitch).toMatchObject({
        modelSelection: onClaude,
        commandId: preswitchId,
        resetAt,
      });
    }),
  );

  it.effect("goes back once the original has room: the 1075 round trip", () =>
    Effect.gen(function* () {
      const state = world();
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          state.claudeUsed = 40;
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([preswitchId, returnId]);
      expect(state.threads[0]!.selection).toEqual(onClaude);
      expect(state.threads[0]!.preswitch).toBeNull();
    }),
  );

  it.effect("keeps a hand switch back until the window resets", () =>
    Effect.gen(function* () {
      const state = world();
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          // The person picks Claude again; the pick clears the origin.
          state.threads[0]!.selection = onClaude;
          state.threads[0]!.preswitch = null;
          yield* nextSweep();
          yield* sweep();
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([preswitchId]);
    }),
  );

  it.effect("keeps a hand switch back when another window becomes the fullest", () =>
    Effect.gen(function* () {
      const state = world();
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          state.threads[0]!.selection = onClaude;
          state.threads[0]!.preswitch = null;
          // Another window, resetting later, is now the fullest: a new id,
          // but the window the move went out for has not reset.
          state.claudeResetAt = "2026-11-19T20:00:00.000Z";
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([preswitchId]);
    }),
  );

  it.effect("gives each window with no reset time its own move", () =>
    Effect.gen(function* () {
      const state = world({ claudeResetAt: "" });
      const open = `limit-preswitch:t1:${claudeId}:open`;
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          state.threads[0]!.selection = onClaude;
          state.threads[0]!.preswitch = null;
          // Still at the threshold: the hand switch back is kept.
          yield* nextSweep();
          yield* sweep();
          // A reading under the threshold ends the window; the next is a new one.
          state.claudeUsed = 40;
          yield* nextSweep();
          yield* sweep();
          state.claudeUsed = 92;
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([open, `${open}-1`]);
    }),
  );

  it.effect("ends a window with no reset time read on the fallback, then moves again", () =>
    Effect.gen(function* () {
      const state = world({ claudeResetAt: "" });
      const open = `limit-preswitch:t1:${claudeId}:open`;
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          // A turn runs on Codex; Claude reads under the threshold and the
          // thread goes home. That reading, taken on Codex, ends the window.
          const thread = state.threads[0]!;
          thread.runs = [...thread.runs, { ...run("r2", "t1", onCodex, "completed"), ordinal: 2 }];
          thread.latestRunId = "r2";
          state.claudeUsed = 40;
          yield* nextSweep();
          yield* sweep();
          expect(thread.selection).toEqual(onClaude);
          // Other threads push Claude over again before this thread is read at home.
          state.claudeUsed = 92;
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)[0]).toBe(open);
      expect(ids(state).at(-1)).toBe(`${open}-1`);
      expect(ids(state)).toHaveLength(3);
    }),
  );

  it.effect("asks no other machine again after a hand switch back", () =>
    Effect.gen(function* () {
      const state = world({
        considered: [],
        settings: {
          ...settings,
          providerLimitMachineTargets: [{ environmentId: "other", modelSelection: onCodex }] as never,
          providerLimitTargetOrder: "other-machine-first",
        },
      });
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          state.threads[0]!.selection = onClaude;
          state.threads[0]!.preswitch = null;
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([preswitchId]);
      expect(state.considered).toEqual([`limit-premove:t1:${claudeId}:${resetAt}`]);
    }),
  );

  it.effect("does the round trip beside a thread stopped on the limit", () =>
    Effect.gen(function* () {
      // A sibling's limit stop makes the sweep read completed runs too.
      const sibling = idleThread({
        id: "t2",
        status: "failed",
        lastErrorClass: "usage_limit",
        latestRunId: "s1",
        runs: [run("s1", "t2", onClaude, "failed")],
      });
      const state = world({ threads: [idleThread(), sibling] });
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          state.claudeUsed = 40;
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([preswitchId, returnId]);
      expect(ids(state, "t2")).toEqual(["limit-fallback:t2:s1"]);
    }),
  );

  it.effect("sends a failed move once per window, never under a retry id", () =>
    Effect.gen(function* () {
      const state = world({ failDispatch: true });
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          for (let index = 0; index < 6; index++) {
            yield* sweep();
            yield* TestClock.adjust(10 * 60_000);
          }
        }),
      );
      expect(ids(state)).toEqual([preswitchId]);
    }),
  );

  it.effect("moves a model picked at the threshold once, between turns", () =>
    Effect.gen(function* () {
      // Picked after the latest turn, on a provider already past the threshold.
      const sonnet = { instanceId: claudeId, model: "claude-sonnet-5-5" };
      const state = world({ threads: [idleThread({ selection: sonnet })] });
      yield* once(state);
      expect(state.dispatched).toMatchObject([
        { commandId: preswitchId, modelSelection: onCodex, expectedModelSelection: sonnet },
      ]);
      expect(state.threads[0]!.preswitch?.modelSelection).toEqual(sonnet);
    }),
  );

  it.effect("moves again in a later window after a turn on the fallback and the way back", () =>
    Effect.gen(function* () {
      const state = world();
      const nextReset = "2026-11-19T20:00:00.000Z";
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          // A turn runs on Codex, then Claude has room and the thread goes home.
          const thread = state.threads[0]!;
          thread.runs = [...thread.runs, { ...run("r2", "t1", onCodex, "completed"), ordinal: 2 }];
          thread.latestRunId = "r2";
          state.claudeUsed = 40;
          yield* nextSweep();
          yield* sweep();
          expect(thread.selection).toEqual(onClaude);
          // Read home under the threshold: the window is over and its hold ends.
          yield* nextSweep();
          yield* sweep();
          // Claude passes the threshold in its next window: the move comes again.
          state.claudeUsed = 92;
          state.claudeResetAt = nextReset;
          yield* nextSweep();
          yield* sweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([
        preswitchId,
        returnId,
        `limit-preswitch:t1:${claudeId}:${nextReset}`,
      ]);
    }),
  );

  it.effect("reads nothing more for a window whose move already went out", () =>
    Effect.gen(function* () {
      const state = world({ failDispatch: true });
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          // The failed move stays sent; Codex's reading then ages past use.
          state.codexReadAt = at;
          for (let index = 0; index < 4; index++) {
            yield* TestClock.adjust(10 * 60_000);
            yield* sweep();
          }
        }),
      );
      expect(ids(state)).toEqual([preswitchId]);
      expect(state.refreshed).toEqual([]);
    }),
  );

  it.effect("reads an old fallback reading again, then moves", () =>
    Effect.gen(function* () {
      // Codex was last read 20 minutes ago: too old to count as room.
      const state = world({ codexReadAt: at - 20 * 60_000 });
      yield* once(state);
      expect(state.refreshed).toEqual([codexId]);
      expect(ids(state)).toEqual([preswitchId]);
    }),
  );

  it.effect("sends the move again after a turn that beat it", () =>
    Effect.gen(function* () {
      const state = world({ turnBeatsMove: true });
      yield* sweeps(state, (sweep) =>
        Effect.gen(function* () {
          yield* sweep();
          yield* nextSweep();
          yield* sweep();
        }),
      );
      expect(ids(state)).toEqual([preswitchId, preswitchId]);
      expect(state.threads[0]!.selection).toEqual(onCodex);
    }),
  );

  it.effect("sends nothing when a turn starts before the move commits", () =>
    Effect.gen(function* () {
      const state = world({
        onReread: (thread) => {
          thread.activeRunId = "r2";
        },
      });
      yield* once(state);
      expect(ids(state)).toEqual([]);
    }),
  );
});

describe("what the idle move leaves alone (1089)", () => {
  const nothing = (state: World) =>
    Effect.gen(function* () {
      yield* once(state);
      expect(ids(state)).toEqual([]);
    });

  it.effect("under the threshold", () => nothing(world({ claudeUsed: 80 })));
  it.effect("mid-turn", () => nothing(world({ threads: [idleThread({ activeRunId: "r2" })] })));
  it.effect("a settled thread", () =>
    nothing(world({ threads: [idleThread({ settledOverride: "settled" })] })),
  );
  it.effect("a thread with held sends", () =>
    nothing(world({ threads: [idleThread({ heldQueued: 1 })] })),
  );
  it.effect("a snoozed thread", () => nothing(world({ threads: [idleThread({ snoozed: true })] })));
  it.effect("a thread with no run", () =>
    nothing(world({ threads: [idleThread({ latestRunId: null, runs: [] })] })),
  );
  it.effect("a thread a person stopped", () =>
    nothing(world({ threads: [idleThread({ stopped: true })] })),
  );
  it.effect("under wait", () =>
    nothing(world({ settings: { ...settings, providerLimitAction: "wait" } })),
  );
  it.effect("under ask", () =>
    nothing(world({ settings: { ...settings, providerLimitAction: "ask" } })),
  );
  it.effect("with no threshold", () =>
    nothing(world({ settings: { ...settings, providerLimitSwitchAtPercent: null } })),
  );
  it.effect("a thread whose turn failed for another reason", () =>
    nothing(
      world({
        threads: [
          idleThread({
            status: "failed",
            lastError: "Provider error",
            runs: [run("r1", "t1", onClaude, "failed")],
          }),
        ],
      }),
    ),
  );
  it.effect("a session still hosting background work", () =>
    nothing(world({ threads: [idleThread({ background: true })] })),
  );
  it.effect("a subagent the provider spawned", () =>
    nothing(world({ threads: [idleThread({ providerSubagent: true })] })),
  );
});

describe("providerLimitStep for an idle thread (1089)", () => {
  const providers = [
    withWindow(provider(claudeId, "claudeAgent", at), opus, 92),
    withWindow(provider(codexId, "codex", at), "gpt-6", 30),
  ];
  const thread = shellOf(idleThread()) as never;

  itPure("is a switch step with the window's idempotent id", () => {
    const step = providerLimitStep(thread, providers, settings, at, { resetAttempted: false });
    expect(step).toEqual({
      type: "switch",
      command: {
        type: "thread.model-selection.set",
        commandId: preswitchId,
        threadId: "t1",
        modelSelection: onCodex,
        expectedModelSelection: onClaude,
      },
    });
    // The same window gives the same id on every read.
    expect(
      providerLimitStep(thread, providers, settings, at + 60_000, { resetAttempted: false }),
    ).toEqual(step);
  });

  itPure("leaves a limit stop on its own steps", () => {
    const stopped = shellOf(
      idleThread({ status: "failed", lastErrorClass: "usage_limit" }),
    ) as never;
    expect(
      providerLimitStep(stopped, providers, settings, at, { resetAttempted: true }),
    ).toMatchObject({
      type: "switch",
      command: { type: "message.dispatch", commandId: "limit-fallback:t1:r1" },
    });
  });
});

describe("the machine handoff beside the idle move (1089)", () => {
  const trigger = (order: "other-machine-first" | "same-machine-first") =>
    limitHandoffTrigger({
      thread: {
        ...shellOf(idleThread()),
        latestRunCompletedAt: DateTime.makeUnsafe(at - 60_000),
      } as never,
      rule: {
        providerLimitAction: "switch",
        providerLimitMachineTargets: [{ environmentId: "other" }] as never,
        providerLimitTargetOrder: order,
      },
      nowMs: at,
      stopped: false,
      atThreshold: true,
      localStep: "switch",
      windowKey: resetAt,
    });

  itPure("asks another machine first unless this machine's fallback goes first", () => {
    expect(trigger("other-machine-first")).toMatchObject({ reason: "threshold", resume: false });
    expect(trigger("same-machine-first")).toBeNull();
  });
});
