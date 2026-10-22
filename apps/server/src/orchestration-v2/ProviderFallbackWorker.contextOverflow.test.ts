import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import { ContextHandoffBudgetError } from "./ContextHandoffDelivery.ts";
import { contextOverflowStop, contextWindowOf } from "./contextOverflowFallback.ts";
import {
  makeSweep,
  ProviderFallbackEnv,
  providerLimitStep,
  unopenableHolds,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// October 22, 2026, the DCFC thread: run 45 went to Codex GPT-6.1-Sol and its
// handoff did not fit. Codex reported a 258,400-token window, Claude 1M; the
// home Claude reading was older than five minutes.
const failedAt = Date.parse("2026-10-22T19:49:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const copilotId = ProviderInstanceId.make("acpRegistry_copilot");
const opus = "claude-opus-5-5";
const sol = "gpt-6.1-sol";
const small = "small-model";

const project = {
  id: ProjectId.make("easychamp"),
  title: "EasyChamp",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  deletedAt: null,
};

function withModel(
  base: ServerProvider,
  model: string,
  usedPercent: number,
  checkedAt: number,
): ServerProvider {
  return {
    ...base,
    models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: null }],
    slashCommands: [{ name: "compact", description: "Compact" }] as never,
    usageLimits: {
      ...base.usageLimits!,
      checkedAt: iso(checkedAt),
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Week",
          usedPercent,
          resetsAt: "2026-10-27T00:00:00.000Z",
        },
      ],
    },
  };
}
const claudeRead = (at: number) => withModel(provider(claudeId, "claudeAgent", at), opus, 40, at);
const codexFull = withModel(provider(codexId, "codex", failedAt), sol, 100, failedAt);
// An agent that reports no usage, with a window too small for the request.
const copilot = (() => {
  const { usageLimits: _none, ...base } = provider(copilotId, "acpRegistry", failedAt);
  return {
    ...base,
    models: [
      {
        slug: small,
        name: small,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select",
              options: [{ id: "32k", label: "32k", isDefault: true }],
            },
          ],
        },
      },
    ],
  } as unknown as ServerProvider;
})();

const run = (input: {
  id: string;
  ordinal: number;
  instanceId: ProviderInstanceId;
  model: string;
  message: string;
  providerThreadId: string;
  completedAt: number;
}) => ({
  id: RunId.make(input.id),
  threadId: ThreadId.make("t1"),
  ordinal: input.ordinal,
  providerInstanceId: input.instanceId,
  modelSelection: { instanceId: input.instanceId, model: input.model },
  providerThreadId: input.providerThreadId,
  userMessageId: input.message as never,
  rootNodeId: `${input.id}-root` as never,
  activeAttemptId: null,
  status: "failed" as const,
  requestedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  startedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  completedAt: DateTime.makeUnsafe(input.completedAt),
  checkpointId: null,
  contextHandoffId: null,
});
type Run = ReturnType<typeof run>;

const r44 = {
  ...run({
    id: "r44",
    ordinal: 44,
    instanceId: claudeId,
    model: opus,
    message: "m44",
    providerThreadId: "pt-claude",
    completedAt: failedAt - 60 * 60_000,
  }),
  status: "completed" as const,
};
const r45 = run({
  id: "r45",
  ordinal: 45,
  instanceId: codexId,
  model: sol,
  message: "m45",
  providerThreadId: "pt-codex",
  completedAt: failedAt,
});
const errorItem = (failed: Run, message: string, code: string | null = null) =>
  ({
    type: "error",
    id: `${failed.id}-error`,
    status: "failed",
    runId: failed.id,
    nodeId: failed.rootNodeId,
    ordinal: 1,
    updatedAt: failed.completedAt,
    failure: { class: "provider_error", message, code, retryable: false },
  }) as unknown as OrchestrationV2TurnItem;
const budgetError = errorItem(r45, new ContextHandoffBudgetError().message);
const messages = [
  {
    id: "m45",
    text: "Why do payments show all zeros? Complete the job!",
    attachments: [],
  },
] as never;
const providerThreads = [
  { id: "pt-codex", contextUsage: { usedTokens: 221_400, maxTokens: 258_400 } },
  { id: "pt-claude", contextUsage: { usedTokens: 300_000, maxTokens: 1_000_000 } },
] as never;

const shell = {
  id: ThreadId.make("t1"),
  projectId: project.id,
  providerInstanceId: codexId,
  modelSelection: { instanceId: codexId, model: sol },
  status: "failed" as const,
  lastErrorClass: "provider_error" as const,
  usageLimitResetAt: null,
  latestRunId: r45.id,
  latestRunCompletedAt: r45.completedAt,
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
  // A delegated subagent: context recovery used to skip these for good.
  lineage: {
    parentThreadId: ThreadId.make("coordinator"),
    relationshipToParent: "subagent",
    rootThreadId: ThreadId.make("coordinator"),
  },
};

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitFallbackModels: [{ instanceId: copilotId, model: small }],
  providerLimitSwitchAtPercent: 100,
  providerLimitWaitUnderMinutes: 0,
  defaultModelSelection: { instanceId: claudeId, model: opus },
};

describe("contextOverflowStop", () => {
  const input = {
    runs: [r44, r45] as unknown as OrchestrationV2Run[],
    turnItems: [budgetError],
    messages,
    providerThreads,
    providers: [claudeRead(failedAt), codexFull, copilot],
  };

  it("makes a handoff that did not fit a stop that moves only to a window that holds it", () => {
    const stop = contextOverflowStop(shell, input);
    expect(stop).toMatchObject({
      runId: "r45",
      instanceId: codexId,
      originRunId: "r45",
      nextHop: 0,
      originIsLimit: false,
      cause: "context",
    });
    expect(stop?.contextFit?.windowOf({ instanceId: codexId, model: sol })).toBe(258_400);
    expect(stop?.contextFit?.windowOf({ instanceId: claudeId, model: opus })).toBe(1_000_000);
    // A context stop never keeps other threads off the provider.
    expect(unopenableHolds(new Map(), [stop!], input.providers, failedAt).size).toBe(0);
  });

  it("leaves an overflow the context recovery can still compact alone", () => {
    const overflow = errorItem(r45, "Prompt is too long", "prompt_too_long");
    expect(contextOverflowStop(shell, { ...input, turnItems: [overflow] })).toBeNull();
    // Without native compaction, recovery has nothing to do: the fallback moves it.
    const noCompact = { ...codexFull, slashCommands: [] };
    expect(
      contextOverflowStop(shell, {
        ...input,
        turnItems: [overflow],
        providers: [claudeRead(failedAt), noCompact, copilot],
      }),
    ).toMatchObject({ cause: "context", originRunId: "r45" });
    // Any other failure is not a context stop.
    expect(
      contextOverflowStop(shell, { ...input, turnItems: [errorItem(r45, "Network hiccup")] }),
    ).toBeNull();
  });

  it("reads a window from the model's option first, then from this thread's sessions", () => {
    expect(contextWindowOf({ instanceId: copilotId, model: small }, [copilot], [], [])).toBe(
      32_000,
    );
    expect(contextWindowOf({ instanceId: codexId, model: sol }, [codexFull], [], [])).toBeNull();
  });

  it("goes home to Claude when its reading is fresh, never to a window too small", () => {
    const stop = contextOverflowStop(shell, input)!;
    const step = providerLimitStep(shell, input.providers, settings, failedAt + 30_000, {
      resetAttempted: false,
      unopenable: stop,
    });
    expect(step?.type).toBe("switch");
    expect(step?.type === "switch" ? step.command : null).toMatchObject({
      type: "message.dispatch",
      commandId: "provider-fallback:t1:r45",
      modelSelection: { instanceId: claudeId, model: opus },
    });
    // A request too large for the 32k agent keeps the move off it even when home is out.
    const bigRequest = {
      ...stop,
      contextFit: { ...stop.contextFit!, requestTokens: 20_000 },
    };
    const homeless = providerLimitStep(shell, [codexFull, copilot], settings, failedAt + 30_000, {
      resetAttempted: false,
      unopenable: bigRequest,
    });
    expect(homeless).toBeNull();
  });
});

function harness(providers: ServerProvider[]) {
  const state = {
    providers,
    refreshed: [] as string[],
    dispatched: [] as OrchestrationV2ServerCommand[],
  };
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    fallbackPolicyTestLayer(settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(() => state.providers),
      refreshInstance: (id) =>
        Effect.gen(function* () {
          state.refreshed.push(id);
          const at = DateTime.toEpochMillis(yield* DateTime.now);
          state.providers = state.providers.map((entry) =>
            entry.instanceId === claudeId && id === claudeId ? claudeRead(at) : entry,
          );
          return state.providers;
        }),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.succeed({ threads: [shell] } as never),
      getThreadShell: () => Effect.succeed(shell as never),
      getThreadRecords: () =>
        Effect.succeed({
          runs: [r44, r45],
          turnItems: [budgetError],
          messages,
          providerThreads,
          runtimeRequests: [],
          nodes: [],
        } as never),
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
    yield* TestClock.setTime(failedAt + 30_000);
    const sweep = yield* makeSweep;
    return { state, sweep };
  }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
}

describe("a handoff that does not fit, in the sweep", () => {
  itEffect.effect("reads home's stale usage, then moves the thread back to Claude", () =>
    Effect.gen(function* () {
      // Claude's last reading is an hour old: it only looks like unknown room.
      const { state, sweep } = yield* harness([
        claudeRead(failedAt - 60 * 60_000),
        codexFull,
        copilot,
      ]);
      yield* sweep();
      expect(state.refreshed).toContain(claudeId);
      expect(state.dispatched).toHaveLength(1);
      expect(state.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        commandId: "provider-fallback:t1:r45",
        modelSelection: { instanceId: claudeId, model: opus },
      });
    }),
  );
});
