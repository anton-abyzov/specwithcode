import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import {
  apiCreditOrigin,
  LIMIT_FALLBACK_MAX_HOPS,
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  makeSweep,
  ProviderFallbackEnv,
  providerLimitStep,
  UNOPENABLE_HOLD_MS,
  unopenableHolds,
  unopenableStop,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// The 2026-10-21 incident: native Claude hit its 5-hour limit at 06:44Z with
// no reset time on the stop; the fallback picked the same model on Copilot,
// whose registry had moved past the prepared version, so no session opened.
const stoppedAt = Date.parse("2026-10-21T06:44:00.000Z");
const opus = "claude-opus-5.5";
const claudeId = ProviderInstanceId.make("claudeAgent");
const copilotId = ProviderInstanceId.make("acpRegistry_copilot");
const codexId = ProviderInstanceId.make("codex");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const project = {
  id: ProjectId.make("incident"),
  title: "Incident project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  deletedAt: null,
};

function withWindow(base: ServerProvider, model: string, usedPercent: number): ServerProvider {
  return {
    ...base,
    models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2026-10-21T09:30:00.000Z",
        },
      ],
    },
  };
}
const claudeAt = (usedPercent: number) =>
  withWindow(provider(claudeId, "claudeAgent", stoppedAt), opus, usedPercent);
const codexAt = (usedPercent: number) =>
  withWindow(provider(codexId, "codex", stoppedAt), "gpt-6", usedPercent);
// An ACP agent reports no usage; its "ready" was read ten minutes before the stop.
function copilotCheckedAt(at: number): ServerProvider {
  const { usageLimits: _none, ...base } = provider(copilotId, "acpRegistry", at);
  return {
    ...base,
    models: [{ slug: opus, name: "Claude Opus 5.5", isCustom: false, capabilities: null }],
  };
}

const run = (input: {
  id: string;
  ordinal: number;
  instanceId: ProviderInstanceId;
  model: string;
  message: string;
  status: "completed" | "failed";
  completedAt: number;
}) => ({
  id: RunId.make(input.id),
  threadId: ThreadId.make("t1"),
  ordinal: input.ordinal,
  providerInstanceId: input.instanceId,
  modelSelection: { instanceId: input.instanceId, model: input.model },
  providerThreadId: null,
  userMessageId: input.message as never,
  rootNodeId: `${input.id}-root` as never,
  activeAttemptId: null,
  status: input.status,
  requestedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  startedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  completedAt: DateTime.makeUnsafe(input.completedAt),
  checkpointId: null,
  contextHandoffId: null,
});
type Run = ReturnType<typeof run>;

/** The error item a session that could not open leaves on its run's root node. */
const unopenableError = (
  failed: Run,
  code: string | null = ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
) =>
  ({
    type: "error",
    id: `${failed.id}-error`,
    status: "failed",
    runId: failed.id,
    nodeId: failed.rootNodeId,
    ordinal: 1,
    updatedAt: failed.completedAt,
    failure: {
      class: "provider_error",
      message:
        "Copilot 1.0.101 is not prepared. Use Install / update agent in Settings → Providers.",
      code,
      retryable: false,
    },
  }) as unknown as OrchestrationV2TurnItem;

const shell = (input: {
  id?: string;
  instanceId: ProviderInstanceId;
  model: string;
  latest: Run;
  errorClass: "usage_limit" | "provider_error" | null;
}) => ({
  id: ThreadId.make(input.id ?? "t1"),
  projectId: project.id,
  providerInstanceId: input.instanceId,
  modelSelection: { instanceId: input.instanceId, model: input.model },
  status: input.latest.status,
  lastErrorClass: input.errorClass,
  usageLimitResetAt: null,
  latestRunId: input.latest.id,
  latestRunCompletedAt: input.latest.completedAt,
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
});
type Shell = ReturnType<typeof shell>;

const r1 = run({
  id: "r1",
  ordinal: 1,
  instanceId: claudeId,
  model: opus,
  message: "m1",
  status: "failed",
  completedAt: stoppedAt,
});
const onClaude = shell({
  instanceId: claudeId,
  model: opus,
  latest: r1,
  errorClass: "usage_limit",
});
// The limit fallback continued r1 on Copilot, and that session never opened.
const r2 = run({
  id: "r2",
  ordinal: 2,
  instanceId: copilotId,
  model: opus,
  message: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1`,
  status: "failed",
  completedAt: stoppedAt + 45_000,
});
const failedOnCopilot = shell({
  instanceId: copilotId,
  model: opus,
  latest: r2,
  errorClass: "provider_error",
});

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 90,
  providerLimitWaitUnderMinutes: 0,
};

function harness(
  preferences: ServerSettings,
  readNow: (entry: ServerProvider) => ServerProvider = (entry) => entry,
) {
  const state = {
    providers: [claudeAt(100), copilotCheckedAt(stoppedAt - 10 * 60_000), codexAt(30)],
    threads: [] as Shell[],
    runs: new Map<string, Run[]>(),
    turnItems: new Map<string, unknown[]>(),
    refreshed: [] as string[],
    dispatched: [] as OrchestrationV2ServerCommand[],
  };
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(preferences),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(() => state.providers),
      // By default the registry still reads Copilot as ready: only a session open finds out.
      refreshInstance: (id) =>
        Effect.gen(function* () {
          state.refreshed.push(id);
          const at = DateTime.toEpochMillis(yield* DateTime.now);
          state.providers = state.providers.map((entry) =>
            entry.instanceId === id ? readNow({ ...entry, checkedAt: iso(at) }) : entry,
          );
          return state.providers;
        }),
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
      getThreadRecords: (threadId) =>
        Effect.sync(
          () =>
            ({
              runs: state.runs.get(threadId) ?? [],
              turnItems: state.turnItems.get(threadId) ?? [],
              // The Claude session exists, so a continuation hands it over.
              providerThreads: [{ appThreadId: threadId, nativeThreadRef: "native" }],
            }) as never,
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => (state.dispatched.push(command), { sequence: 1, storedEvents: [] })),
    }),
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(stoppedAt + 30_000);
    const sweep = yield* makeSweep;
    return { state, sweep };
  }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
}

const target = (command: OrchestrationV2ServerCommand | undefined) =>
  command !== undefined && "modelSelection" in command
    ? command.modelSelection?.instanceId
    : undefined;

describe("a fallback target that cannot open", () => {
  itEffect.effect("moves on to the next provider and keeps everyone off the broken one", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness(settings);
      state.threads = [onClaude];
      state.runs.set("t1", [r1]);

      // Copilot reports no usage, so it is read again before the move; it still reads ready.
      yield* sweep();
      expect(state.refreshed).toEqual([copilotId]);
      expect(state.dispatched).toHaveLength(1);
      expect(state.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        commandId: "limit-fallback:t1:r1",
        manualContinuationOfRunId: "r1",
        modelSelection: { instanceId: copilotId, model: opus },
      });

      // The continuation fails to open; another thread stops on Claude meanwhile.
      const r5 = run({
        id: "r5",
        ordinal: 1,
        instanceId: claudeId,
        model: opus,
        message: "m5",
        status: "failed",
        completedAt: stoppedAt + 50_000,
      });
      const t2 = shell({
        id: "t2",
        instanceId: claudeId,
        model: opus,
        latest: r5,
        errorClass: "usage_limit",
      });
      state.threads = [failedOnCopilot, t2];
      state.runs.set("t1", [r1, r2]);
      state.turnItems.set("t1", [unopenableError(r2)]);
      state.runs.set("t2", [r5]);
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.dispatched.slice(1)).toMatchObject([
        {
          type: "message.dispatch",
          threadId: "t1",
          commandId: "limit-fallback:t1:hop-1:r1",
          messageId: "limit-fallback:t1:hop-1:r1",
          modelSelection: { instanceId: codexId, model: "gpt-6" },
          text: "Continue where you left off.",
        },
        {
          type: "message.dispatch",
          threadId: "t2",
          commandId: "limit-fallback:t2:r5",
          modelSelection: { instanceId: codexId, model: "gpt-6" },
        },
      ]);
      // The orchestrator continues only interrupted or usage-limited runs.
      expect(state.dispatched[1]).not.toHaveProperty("manualContinuationOfRunId");
      expect(state.refreshed).toEqual([copilotId]);

      // Codex takes the work, then the thread's next turn stops on Codex's own
      // limit: Copilot is the only other provider, and it is still held.
      const r3 = run({
        id: "r3",
        ordinal: 3,
        instanceId: codexId,
        model: "gpt-6",
        message: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:hop-1:r1`,
        status: "completed",
        completedAt: stoppedAt + 70_000,
      });
      const r4 = run({
        id: "r4",
        ordinal: 4,
        instanceId: codexId,
        model: "gpt-6",
        message: "m4",
        status: "failed",
        completedAt: stoppedAt + 85_000,
      });
      state.threads = [
        shell({ instanceId: codexId, model: "gpt-6", latest: r4, errorClass: "usage_limit" }),
      ];
      state.runs.set("t1", [r1, r2, r3, r4]);
      state.providers = state.providers.map((entry) =>
        entry.instanceId === codexId ? codexAt(100) : entry,
      );
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.dispatched).toHaveLength(3);

      // Once Claude has room again the idle thread goes home, past both hops.
      state.threads = [
        shell({
          instanceId: codexId,
          model: "gpt-6",
          latest: { ...r4, status: "completed" },
          errorClass: null,
        }),
      ];
      state.runs.set("t1", [r1, r2, r3, { ...r4, status: "completed" }]);
      state.providers = state.providers.map((entry) =>
        entry.instanceId === codexId
          ? codexAt(30)
          : entry.instanceId === claudeId
            ? withWindow(provider(claudeId, "claudeAgent", stoppedAt + 92_000), opus, 20)
            : entry,
      );
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.dispatched.slice(3)).toEqual([
        {
          type: "thread.model-selection.set",
          commandId: "limit-return:t1:r3",
          threadId: "t1",
          modelSelection: { instanceId: claudeId, model: opus },
        },
      ]);
    }),
  );

  itEffect.effect(
    "reads an unreported target again and skips it once it no longer reads ready",
    () =>
      Effect.gen(function* () {
        const { state, sweep } = yield* harness(settings, (entry) =>
          entry.instanceId === copilotId
            ? { ...entry, status: "error", message: "Copilot 1.0.101 is not prepared." }
            : entry,
        );
        state.threads = [onClaude];
        state.runs.set("t1", [r1]);
        yield* sweep();
        expect(state.refreshed).toEqual([copilotId]);
        expect(state.dispatched.map((command) => [command.commandId, target(command)])).toEqual([
          ["limit-fallback:t1:r1", codexId],
        ]);
      }),
  );

  itEffect.effect("never moves a thread under ask or wait", () =>
    Effect.gen(function* () {
      for (const action of ["ask", "wait"] as const) {
        const { state, sweep } = yield* harness({ ...settings, providerLimitAction: action });
        state.threads = [failedOnCopilot];
        state.runs.set("t1", [r1, r2]);
        state.turnItems.set("t1", [unopenableError(r2)]);
        yield* sweep();
        expect(state.dispatched).toEqual([]);
      }
    }),
  );

  itEffect.effect("moves a thread whose own provider could not open", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness(settings);
      // A person picked Copilot (or a scheduled run uses it) and the session never opened.
      const own = { ...r2, userMessageId: "m2" as never };
      state.threads = [{ ...failedOnCopilot, latestRunId: own.id }];
      state.runs.set("t1", [own]);
      state.turnItems.set("t1", [unopenableError(own)]);
      yield* sweep();
      expect(state.dispatched.map((command) => [command.commandId, target(command)])).toEqual([
        ["provider-fallback:t1:r2", codexId],
      ]);

      // Codex finishes the turn. Copilot was no usage limit, so nothing goes back to it.
      const r3 = run({
        id: "r3",
        ordinal: 2,
        instanceId: codexId,
        model: "gpt-6",
        message: "provider-fallback:t1:r2",
        status: "completed",
        completedAt: stoppedAt + 70_000,
      });
      state.threads = [
        shell({ instanceId: codexId, model: "gpt-6", latest: r3, errorClass: null }),
      ];
      state.runs.set("t1", [own, r3]);
      state.providers = state.providers.map((entry) =>
        entry.instanceId === copilotId ? copilotCheckedAt(stoppedAt + 5 * 60 * 60_000) : entry,
      );
      yield* TestClock.adjust("6 hours");
      yield* sweep();
      expect(state.dispatched).toHaveLength(1);
    }),
  );

  itEffect.effect("continues the failed turn at home once the stopped provider resets", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness(settings);
      // Claude keeps its published denial past the reset; Codex is spent too.
      const denied = (entry: ServerProvider): ServerProvider => ({
        ...entry,
        usageLimits: { ...entry.usageLimits!, ordinaryUsageAllowed: false },
      });
      state.providers = [denied(claudeAt(100)), copilotCheckedAt(stoppedAt), codexAt(100)];
      const resetAt = "2026-10-21T09:30:00.000Z";
      const limitError = {
        type: "error",
        id: "r1-error",
        status: "failed",
        runId: r1.id,
        nodeId: r1.rootNodeId,
        ordinal: 1,
        updatedAt: r1.completedAt,
        failure: { class: "usage_limit", message: "limit", resetAt, retryable: false },
      } as unknown as OrchestrationV2TurnItem;
      state.threads = [onClaude];
      state.runs.set("t1", [r1]);
      state.turnItems.set("t1", [limitError]);
      yield* sweep();
      expect(state.dispatched.map((command) => [command.commandId, target(command)])).toEqual([
        ["limit-fallback:t1:r1", copilotId],
      ]);

      // Copilot could not open, and no other provider can take the turn.
      state.threads = [failedOnCopilot];
      state.runs.set("t1", [r1, r2]);
      state.turnItems.set("t1", [limitError, unopenableError(r2)]);
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.dispatched).toHaveLength(1);

      // At the reset the thread goes home and its unfinished turn runs there.
      yield* TestClock.setTime(Date.parse(resetAt) + 60_000);
      yield* sweep();
      expect(state.dispatched.slice(1)).toEqual([
        {
          type: "message.dispatch",
          commandId: "limit-return:t1:r2",
          messageId: "limit-return:t1:r2",
          threadId: "t1",
          modelSelection: { instanceId: claudeId, model: opus },
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        },
      ]);
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.dispatched).toHaveLength(2);
    }),
  );
});

describe("unopenableStop", () => {
  const providers = [claudeAt(100), copilotCheckedAt(stoppedAt), codexAt(30)];
  const now = stoppedAt + 60_000;
  const step = (latest: Run, runs: Run[]) => {
    const thread = { ...failedOnCopilot, latestRunId: latest.id };
    const stop = unopenableStop(thread, runs, [unopenableError(latest)]);
    return {
      stop,
      step: providerLimitStep(thread, providers, settings, now, {
        resetAttempted: false,
        unopenable: stop,
      }),
    };
  };
  const hop = (n: number) => ({
    ...r2,
    userMessageId: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:hop-${n}:r1` as never,
  });

  it("reads the failure code, never the message, and finds the stop it answers", () => {
    expect(step(r2, [r1, r2]).stop).toMatchObject({
      runId: "r2",
      instanceId: copilotId,
      originRunId: "r1",
      nextHop: 1,
      failedAtMs: stoppedAt + 45_000,
    });
    expect(unopenableStop(failedOnCopilot, [r1, r2], [unopenableError(r2, null)])).toBeNull();
    expect(
      unopenableStop(
        { ...failedOnCopilot, lastErrorClass: "usage_limit" },
        [r1, r2],
        [unopenableError(r2)],
      ),
    ).toBeNull();
  });

  it("stops after the hop cap", () => {
    expect(
      step(hop(LIMIT_FALLBACK_MAX_HOPS - 1), [r1, hop(LIMIT_FALLBACK_MAX_HOPS - 1)]).step,
    ).toMatchObject({
      type: "switch",
      command: { commandId: `limit-fallback:t1:hop-${LIMIT_FALLBACK_MAX_HOPS}:r1` },
    });
    expect(step(hop(LIMIT_FALLBACK_MAX_HOPS), [r1, hop(LIMIT_FALLBACK_MAX_HOPS)]).step).toBeNull();
  });

  it("skips the selections the original stop already tried", () => {
    const { stop } = step(r2, [r1, r2]);
    const thread = { ...failedOnCopilot, latestRunId: r2.id };
    expect(
      providerLimitStep(thread, providers, settings, stoppedAt + 60_000, {
        resetAttempted: false,
        unopenable: stop,
        failedTargets: new Set([`${codexId}\u0000gpt-6`]),
      }),
    ).toBeNull();
  });

  it("keeps the origin run last, whatever colons the run ids hold", () => {
    const origin = { ...r1, id: RunId.make("run:t1:ordinal:1") };
    const failed = {
      ...hop(2),
      id: RunId.make("run:t1:ordinal:4"),
      userMessageId: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:hop-2:run:t1:ordinal:1` as never,
    };
    const { stop, step: next } = step(failed, [origin, failed]);
    expect(stop).toMatchObject({
      originRunId: "run:t1:ordinal:1",
      nextHop: 3,
      originIsLimit: true,
    });
    expect(next).toMatchObject({
      command: { commandId: "limit-fallback:t1:hop-3:run:t1:ordinal:1" },
    });
  });

  it("marks a move off a provider that could not start, and its hops, as no limit", () => {
    const own = { ...r2, userMessageId: "m2" as never };
    expect(step(own, [own])).toMatchObject({
      stop: { originRunId: "r2", nextHop: 0, originIsLimit: false },
      step: {
        command: { commandId: "provider-fallback:t1:r2", messageId: "provider-fallback:t1:r2" },
      },
    });
    const moved = {
      ...r2,
      id: RunId.make("r3"),
      ordinal: 3,
      userMessageId: "provider-fallback:t1:r2" as never,
    };
    expect(step(moved, [own, moved])).toMatchObject({
      stop: { originRunId: "r2", nextHop: 1, originIsLimit: false },
      step: { command: { commandId: "provider-fallback:t1:hop-1:r2" } },
    });
    // The way back reads only usage-limit moves.
    expect(
      apiCreditOrigin(
        { id: ThreadId.make("t1"), providerInstanceId: copilotId },
        [own, moved],
        LIMIT_FALLBACK_MESSAGE_PREFIX,
      ),
    ).toBeNull();
  });

  it("leads the way back through each hop to the original stop", () => {
    const r3 = run({
      id: "r3",
      ordinal: 3,
      instanceId: codexId,
      model: "gpt-6",
      message: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:hop-1:r1`,
      status: "completed",
      completedAt: stoppedAt + 80_000,
    });
    expect(
      apiCreditOrigin(
        { id: ThreadId.make("t1"), providerInstanceId: codexId },
        [r1, r2, r3],
        LIMIT_FALLBACK_MESSAGE_PREFIX,
      ),
    ).toMatchObject({ stoppedRunId: "r1", continuedByRunId: "r3" });
  });
});

describe("unopenableHolds", () => {
  const stop = unopenableStop(failedOnCopilot, [r1, r2], [unopenableError(r2)])!;
  const failedAt = stoppedAt + 45_000;

  it("holds the instance until a newer read shows it ready, or the hold runs out", () => {
    const stale = [copilotCheckedAt(stoppedAt)];
    const held = unopenableHolds(new Map(), [stop], stale, failedAt + 1_000);
    expect([...held]).toEqual([[copilotId, failedAt]]);
    // The thread has moved on; the hold outlives it.
    expect(unopenableHolds(held, [], stale, failedAt + 10 * 60_000).has(copilotId)).toBe(true);
    expect(unopenableHolds(held, [], stale, failedAt + UNOPENABLE_HOLD_MS).size).toBe(0);
    // A read after the failure that can take a turn ends it; one that cannot does not.
    const fresh = copilotCheckedAt(failedAt + 60_000);
    expect(unopenableHolds(held, [stop], [fresh], failedAt + 61_000).size).toBe(0);
    const notReady = { ...fresh, status: "error" as const };
    expect(unopenableHolds(held, [stop], [notReady], failedAt + 61_000).has(copilotId)).toBe(true);
  });
});
