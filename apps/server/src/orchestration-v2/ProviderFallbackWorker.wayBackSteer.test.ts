import {
  orchestrationV2SteeredStartMessageId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
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
import { describe, expect, it } from "vite-plus/test";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import {
  apiCreditOrigin,
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  makeSweep,
  providerFallbackCommand,
  ProviderFallbackEnv,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { unopenableFallbackCommand } from "./unopenableFallback.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// October 23, 2026: a limit-fallback continuation took a steer before its
// first turn. The steer restarted the run under the steering message, the
// `limit-fallback:` id was gone from the run, and the thread stayed on the
// fallback (Devin, Gemini) after Claude had room again.

const stoppedAt = Date.parse("2026-10-23T17:35:53.000Z");
const opus = "claude-opus-5-5";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const grokId = ProviderInstanceId.make("grok");
const project = {
  id: ProjectId.make("way-back-steer"),
  title: "Way back steer project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
  deletedAt: null,
};
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 90,
  providerLimitWaitUnderMinutes: 0,
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
          resetsAt: "2026-10-23T20:50:00.000Z",
        },
      ],
    },
  };
}

const run = (input: {
  id: string;
  ordinal: number;
  instanceId: ProviderInstanceId;
  model: string;
  options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  message: string;
  startMessage?: string;
  status: "completed" | "failed" | "interrupted";
  completedAt: number;
  restartContinuationOf?: string;
}) => ({
  id: RunId.make(input.id),
  threadId: ThreadId.make("t1"),
  ordinal: input.ordinal,
  providerInstanceId: input.instanceId,
  modelSelection: {
    instanceId: input.instanceId,
    model: input.model,
    ...(input.options === undefined ? {} : { options: input.options }),
  },
  providerThreadId: null,
  userMessageId: input.message as never,
  ...(input.startMessage === undefined ? {} : { startMessageId: input.startMessage as never }),
  ...(input.restartContinuationOf === undefined
    ? {}
    : { restartContinuationOfRunId: RunId.make(input.restartContinuationOf) }),
  rootNodeId: `${input.id}-root` as never,
  activeAttemptId: null,
  status: input.status,
  queueHeld: false,
  requestedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  startedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  completedAt: DateTime.makeUnsafe(input.completedAt),
  checkpointId: null,
  contextHandoffId: null,
});
type Run = ReturnType<typeof run>;

const stopped = run({
  id: "r1",
  ordinal: 1,
  instanceId: claudeId,
  model: opus,
  options: [{ id: "effort", value: "high" }],
  message: "m1",
  status: "failed",
  completedAt: stoppedAt,
});
const fallbackId = `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1`;
// The continuation, restarted by a steer under the steering message.
const steered = run({
  id: "r2",
  ordinal: 2,
  instanceId: codexId,
  model: "gpt-6",
  message: "message:mcp:owner:thread-send:steer",
  startMessage: fallbackId,
  status: "completed",
  completedAt: stoppedAt + 60_000,
});

function harness(runs: ReadonlyArray<Run>) {
  const latest = runs.at(-1)!;
  const thread = {
    id: ThreadId.make("t1"),
    projectId: project.id,
    providerInstanceId: latest.providerInstanceId,
    modelSelection: latest.modelSelection,
    status: latest.status,
    lastErrorClass: null,
    usageLimitResetAt: null,
    latestRunId: latest.id,
    latestRunCompletedAt: latest.completedAt,
    activeRunId: null,
    pendingRuntimeRequest: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
  };
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.succeed([
        // Claude has room again; Codex has room too, so nothing else moves.
        withWindow(provider(claudeId, "claudeAgent", stoppedAt + 120_000), opus, 20),
        withWindow(provider(codexId, "codex", stoppedAt), "gpt-6", 30),
        withWindow(provider(grokId, "grok", stoppedAt), "grok-4.7", 30),
      ]),
      refreshInstance: () => Effect.succeed([]),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.succeed({ threads: [thread] } as never),
      getThreadShell: () => Effect.succeed(thread as never),
      getThreadRecords: () =>
        Effect.succeed({
          runs,
          turnItems: [],
          runtimeRequests: [],
          nodes: [],
          messages: [],
          providerThreads: [{ appThreadId: "t1", nativeThreadRef: "native" }],
        } as never),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(stoppedAt + 180_000);
    const sweep = yield* makeSweep;
    yield* sweep();
    return dispatched.map((command) => ({
      id: command.commandId,
      selection: "modelSelection" in command ? command.modelSelection : null,
    }));
  }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
}

// The way home restores the full selection the limit stopped, effort included.
const home = { instanceId: claudeId, model: opus, options: [{ id: "effort", value: "high" }] };

describe("the way back after a steer or replay", () => {
  it("reads the move from the message that started the steered run", () => {
    const onCodex = { id: ThreadId.make("t1"), providerInstanceId: codexId };
    expect(apiCreditOrigin(onCodex, [stopped, steered], LIMIT_FALLBACK_MESSAGE_PREFIX)).toEqual({
      stoppedRunId: stopped.id,
      continuedByRunId: steered.id,
      modelSelection: home,
      resetAt: null,
    });
  });

  itEffect.effect("goes home once Claude has room, though a steer restarted the move", () =>
    Effect.gen(function* () {
      expect(yield* harness([stopped, steered])).toEqual([
        { id: "limit-return:t1:r2", selection: home },
      ]);
    }),
  );

  itEffect.effect("goes home after an update replayed the steered move as a new run", () =>
    Effect.gen(function* () {
      const interrupted = { ...steered, status: "interrupted" as const };
      const replay = run({
        id: "r3",
        ordinal: 3,
        instanceId: codexId,
        model: "gpt-6",
        message: "restart-continuation:r2",
        status: "completed",
        completedAt: stoppedAt + 120_000,
        restartContinuationOf: "r2",
      });
      expect(yield* harness([stopped, interrupted, replay])).toEqual([
        { id: "limit-return:t1:r2", selection: home },
      ]);
    }),
  );

  it("keeps the start id only while a steer stays on the run's instance", () => {
    expect(orchestrationV2SteeredStartMessageId(steered, codexId)).toBe(fallbackId);
    const fresh = { ...steered, startMessageId: undefined, userMessageId: fallbackId as never };
    expect(orchestrationV2SteeredStartMessageId(fresh, codexId)).toBe(fallbackId);
    expect(orchestrationV2SteeredStartMessageId(steered, grokId)).toBeUndefined();
  });

  itEffect.effect("leaves a run a person's steer moved to a third provider", () =>
    Effect.gen(function* () {
      // As the Orchestrator stores it: the steer's message, no start id.
      const movedByPerson = run({
        id: "r2",
        ordinal: 2,
        instanceId: grokId,
        model: "grok-4.7",
        message: "message:web:steer-to-grok",
        status: "completed",
        completedAt: stoppedAt + 60_000,
      });
      expect(
        apiCreditOrigin(
          { id: ThreadId.make("t1"), providerInstanceId: grokId },
          [stopped, movedByPerson],
          LIMIT_FALLBACK_MESSAGE_PREFIX,
        ),
      ).toBeNull();
      expect(yield* harness([stopped, movedByPerson])).toEqual([]);
    }),
  );

  itEffect.effect("leaves a thread a person moved to the other model", () =>
    Effect.gen(function* () {
      const pinned = run({
        id: "r2",
        ordinal: 2,
        instanceId: codexId,
        model: "gpt-6",
        message: "m2",
        status: "completed",
        completedAt: stoppedAt + 60_000,
      });
      expect(yield* harness([stopped, pinned])).toEqual([]);
    }),
  );
});

// 1039 medium finding: a second account of the same driver serves the same
// model, so the thread keeps its effort there.
describe("a same-driver fallback keeps the selected options", () => {
  const secondClaudeId = ProviderInstanceId.make("claudeAgent-2");
  const copilotId = ProviderInstanceId.make("copilot");
  const high = [{ id: "effort", value: "high" }];
  const spent = withWindow(provider(claudeId, "claudeAgent", stoppedAt), opus, 100);
  const second = withWindow(provider(secondClaudeId, "claudeAgent", stoppedAt), opus, 10);
  const rule = {
    providerLimitAction: "switch" as const,
    providerLimitFallbackModelSelection: null,
    providerLimitFallbackModels: [],
    providerLimitSwitchAtPercent: 90,
    providerLimitWaitUnderMinutes: 0,
    defaultModelSelection: null,
  };
  const onClaude = (status: "failed" | "completed") => ({
    id: ThreadId.make("t1"),
    providerInstanceId: claudeId,
    modelSelection: { instanceId: claudeId, model: opus, options: high },
    status,
    lastErrorClass: status === "failed" ? ("usage_limit" as const) : null,
    usageLimitResetAt: null,
    latestRunId: RunId.make("r1"),
    latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
    activeRunId: null,
    pendingRuntimeRequest: null,
    settledOverride: null,
  });
  const selectionOf = (command: OrchestrationV2ServerCommand | null) =>
    command !== null && "modelSelection" in command ? command.modelSelection : null;

  it.each(["failed", "completed"] as const)(
    "keeps effort on the next Claude account (%s: stopped run and pre-switch)",
    (status) => {
      expect(
        selectionOf(
          providerFallbackCommand(onClaude(status) as never, [spent, second], rule, stoppedAt),
        ),
      ).toEqual({ instanceId: secondClaudeId, model: opus, options: high });
    },
  );

  // 1039 recheck: same-model discovery refuses a stale usage read, and the
  // working coordinator's model is taken instead.
  describe("on the coordinator's model after a stale usage read", () => {
    const stale = withWindow(
      provider(secondClaudeId, "claudeAgent", stoppedAt - 6 * 60_000),
      opus,
      10,
    );
    const copilot = withWindow(provider(copilotId, "copilot", stoppedAt - 6 * 60_000), opus, 10);
    const move = (providers: ReadonlyArray<ServerProvider>, proven: ModelSelection) =>
      selectionOf(
        providerFallbackCommand(
          onClaude("failed") as never,
          [spent, ...providers],
          rule,
          stoppedAt,
          proven,
        ),
      );

    it("keeps effort on the same driver and model", () => {
      expect(move([stale], { instanceId: secondClaudeId, model: opus })).toEqual({
        instanceId: secondClaudeId,
        model: opus,
        options: high,
      });
    });

    it("gives another model or driver its own defaults", () => {
      expect(move([stale], { instanceId: secondClaudeId, model: "claude-sonnet-5-5" })).toEqual({
        instanceId: secondClaudeId,
        model: "claude-sonnet-5-5",
      });
      expect(move([copilot], { instanceId: copilotId, model: opus })).toEqual({
        instanceId: copilotId,
        model: opus,
      });
    });
  });

  it("gives another driver its own defaults", () => {
    const copilot = withWindow(provider(copilotId, "copilot", stoppedAt), opus, 10);
    expect(
      selectionOf(
        providerFallbackCommand(onClaude("failed") as never, [spent, copilot], rule, stoppedAt),
      ),
    ).toEqual({ instanceId: copilotId, model: opus });
  });
});

describe("an open failure on the same model keeps the selected options", () => {
  it("moves to the next Claude account with effort", () => {
    const secondClaudeId = ProviderInstanceId.make("claudeAgent-2");
    const high = [{ id: "effort", value: "high" }];
    const failedAt = stoppedAt;
    const thread = {
      id: ThreadId.make("t1"),
      providerInstanceId: claudeId,
      modelSelection: { instanceId: claudeId, model: opus, options: high },
      status: "failed" as const,
      lastErrorClass: "provider_error" as const,
      usageLimitResetAt: null,
      latestRunId: RunId.make("r1"),
      latestRunCompletedAt: DateTime.makeUnsafe(failedAt),
      activeRunId: null,
      pendingRuntimeRequest: null,
      settledOverride: null,
    };
    const stop = {
      runId: RunId.make("r1"),
      instanceId: claudeId,
      selection: thread.modelSelection,
      failedAtMs: failedAt,
      userMessageId: "m1",
      failure: { class: "provider_error", code: "provider_unavailable", message: "x" },
      originRunId: RunId.make("r1"),
      nextHop: 0,
      originIsLimit: false,
    };
    const command = unopenableFallbackCommand(
      thread as never,
      [
        withWindow(provider(claudeId, "claudeAgent", failedAt), opus, 10),
        withWindow(provider(secondClaudeId, "claudeAgent", failedAt), opus, 10),
      ],
      {
        providerLimitAction: "switch",
        providerLimitFallbackModelSelection: null,
        providerLimitFallbackModels: [],
        providerLimitSwitchAtPercent: 90,
        providerLimitWaitUnderMinutes: 0,
        defaultModelSelection: null,
      },
      failedAt + 1_000,
      stop as never,
    );
    expect(command?.modelSelection).toEqual({
      instanceId: secondClaudeId,
      model: opus,
      options: high,
    });
  });
});
