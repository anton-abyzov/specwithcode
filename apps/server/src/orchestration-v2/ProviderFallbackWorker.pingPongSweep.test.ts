import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
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
import { LIMIT_SOURCE_BACKOFF_MS } from "./limitSourceHolds.ts";
import { MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { LimitSourceHoldsShared } from "./UnopenableHolds.ts";
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

const stoppedShell = (
  latest: Run,
  lastErrorClass: "usage_limit" | "provider_error" = "usage_limit",
  id = "t1",
) => ({
  id: ThreadId.make(id),
  projectId: project.id,
  providerInstanceId: latest.providerInstanceId,
  modelSelection: latest.modelSelection,
  status: "failed" as const,
  lastErrorClass,
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

function harness(
  preferences: ServerSettings = settings,
  providers: ServerProvider[] = [
    withRoom(provider(copilotId, "acpRegistry", stoppedAt), neon, 40),
    withRoom(provider(cursorId, "cursor", stoppedAt), neon, 40),
    withRoom(provider(claudeId, "claudeAgent", stoppedAt), opus, 10),
  ],
) {
  const state = {
    providers,
    threads: [] as ReturnType<typeof stoppedShell>[],
    runs: [] as Run[],
    turnItems: [] as unknown[],
    /** Handoff triggers the sweep asked another machine about. */
    considered: [] as string[],
    /** What changes while the other machine answers, before the last check. */
    whileAsked: null as (() => void) | null,
    admitted: [] as string[],
    dispatched: [] as OrchestrationV2ServerCommand[],
  };
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(preferences),
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
              turnItems: state.turnItems,
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
  }).pipe(
    Effect.provide(deps),
    Effect.provideService(ProviderFallbackEnv, {}),
    Effect.provideService(MachineLimitHandoff, {
      bind: () => Effect.void,
      consider: (input) =>
        Effect.gen(function* () {
          state.considered.push(input.trigger.key);
          if (state.whileAsked !== null) {
            state.whileAsked();
            state.admitted.push(`${input.trigger.key}=${yield* input.admit}`);
          }
          return "skipped" as const;
        }),
      holds: () => Effect.succeed(false),
      localTurnBlocked: () => Effect.succeed(false),
      candidates: () => Effect.die("No other machine in these tests"),
    }),
  );
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

describe("the hop cap through the sweep", () => {
  // Eight sources of one model, every one refusing it while its read shows room.
  const ids = Array.from({ length: 8 }, (_, index) => ProviderInstanceId.make(`acp_${index + 1}`));
  const pool = ids.map((id) => withRoom(provider(id, "acpRegistry", stoppedAt), neon, 40));
  const poolSettings = {
    ...settings,
    defaultModelSelection: { instanceId: ids[0]!, model: neon },
    modelLanes: { routine: [{ instanceId: ids[0]!, model: neon }], complex: [] },
    // Another machine is a target once the track is out here.
    providerLimitMachineTargets: [
      {
        environmentId: "minis" as never,
        label: "Minis",
        modelSelection: { instanceId: ids[0]!, model: neon },
      },
    ],
  } as ServerSettings;

  itEffect.effect("a target that could not open never resets the count", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness(poolSettings, pool);
      let clock = stoppedAt + 5_000;
      const step = function* () {
        clock += 31_000;
        yield* TestClock.setTime(clock);
        yield* sweep();
      };
      let on = { instanceId: ids[0]!, model: neon };
      let message = "m1";
      // r1 (a person's turn) and four automatic hops r2..r5 that each stop.
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        const stopped = run(
          `r${ordinal}`,
          ordinal,
          on.instanceId,
          on.model,
          message,
          clock + 30_000,
        );
        state.runs.push(stopped);
        state.threads = [stoppedShell(stopped)];
        yield* step();
        const sent = state.dispatched.at(-1)!;
        expect(sent).toMatchObject({ messageId: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r${ordinal}` });
        on = selection(sent) as typeof on;
        message = (sent as { messageId: string }).messageId;
      }
      // r5, the fourth hop's run, never opens: the sweep moves on to another source.
      const unopened = run("r5", 5, on.instanceId, on.model, message, clock + 30_000);
      state.runs.push(unopened);
      state.threads = [stoppedShell(unopened, "provider_error")];
      state.turnItems = [
        {
          type: "error",
          id: "r5-error",
          status: "failed",
          runId: unopened.id,
          nodeId: unopened.rootNodeId,
          ordinal: 1,
          updatedAt: unopened.completedAt,
          failure: {
            class: "provider_error",
            message: "The agent is not prepared.",
            code: ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
            retryable: false,
          },
        },
      ];
      yield* step();
      const replacement = state.dispatched.at(-1)!;
      expect(replacement).toMatchObject({
        messageId: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:hop-1:r4`,
      });
      expect(state.dispatched).toHaveLength(5);

      // The replacement stops on the limit too: that is the fifth stop in the chain, so it parks.
      const last = selection(replacement) as typeof on;
      const r6 = run(
        "r6",
        6,
        last.instanceId,
        last.model,
        `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:hop-1:r4`,
        clock + 30_000,
      );
      state.runs.push(r6);
      state.threads = [stoppedShell(r6)];
      // Every source now reads full, so the track is out here and another
      // machine would be asked, but for the cap.
      state.providers = pool.map((entry) => withRoom(entry, neon, 100));
      const askedBefore = state.considered.length;
      yield* step();
      yield* step();
      expect(state.dispatched).toHaveLength(5);
      // Nor does a parked chain ask another machine to take it (D-04).
      expect(state.considered.slice(askedBefore)).toEqual([]);

      // An hour on, every hold has run out and the sources read room again:
      // a parked chain still waits for a person, with no way back sent.
      state.providers = pool;
      clock += LIMIT_SOURCE_BACKOFF_MS;
      yield* step();
      yield* step();
      expect(state.dispatched).toHaveLength(5);
    }),
  );
});

describe("a hold on a source whose read covers each model", () => {
  const codexId = ProviderInstanceId.make("codex");
  const gpt = "gpt-6";
  const codexAt = (at: number, usedPercent: number) =>
    withRoom(provider(codexId, "codex", at), gpt, usedPercent);
  const key = `${codexId}\u0000${gpt}`;

  itEffect.effect("ends on a usage read that shows room, never on a status refresh", () => {
    // The holds the sweep shares with launches and coordinator turns.
    let shared: ReadonlyMap<string, number> = new Map();
    return Effect.gen(function* () {
      const { state, sweep } = yield* harness(
        {
          ...settings,
          defaultModelSelection: { instanceId: codexId, model: gpt },
        } as ServerSettings,
        [codexAt(stoppedAt - 60_000, 100)],
      );
      const r1 = run("r1", 1, codexId, gpt, "m1", stoppedAt);
      state.runs = [r1];
      state.threads = [stoppedShell(r1)];
      yield* sweep();
      expect(shared.has(key)).toBe(true);

      // The status refreshes after the stop, but the usage read is unavailable.
      const refreshed = provider(codexId, "codex", stoppedAt + 20_000);
      state.providers = [
        {
          ...codexAt(stoppedAt + 20_000, 0),
          usageLimits: {
            ...refreshed.usageLimits!,
            unavailable: { reason: "not read" } as never,
            windows: [],
          },
        },
      ];
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(shared.has(key)).toBe(true);

      // A real read after the stop shows room: the hold ends, and stays ended.
      state.providers = [codexAt(stoppedAt + 40_000, 20)];
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(shared.has(key)).toBe(false);
      state.providers = [codexAt(stoppedAt - 60_000, 20)];
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(shared.has(key)).toBe(false);
    }).pipe(
      Effect.provideService(LimitSourceHoldsShared, {
        get: Effect.sync(() => shared),
        set: (next) =>
          Effect.sync(() => {
            shared = next;
          }),
      }),
    );
  });
});

describe("the last check before a handoff", () => {
  const codexId = ProviderInstanceId.make("codex");
  const gpt = "gpt-6";
  const codexAt = (at: number, usedPercent: number) =>
    withRoom(provider(codexId, "codex", at), gpt, usedPercent);
  const claudeAt = (at: number, usedPercent: number) =>
    withRoom(provider(claudeId, "claudeAgent", at), opus, usedPercent);

  itEffect.effect("reads a usage read that came in while the other machine answered", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness(
        {
          ...settings,
          defaultModelSelection: { instanceId: codexId, model: gpt },
          modelLanes: {
            routine: [
              { instanceId: codexId, model: gpt },
              { instanceId: claudeId, model: opus },
            ],
            complex: [],
          },
          providerLimitMachineTargets: [
            {
              environmentId: "minis" as never,
              label: "Minis",
              modelSelection: { instanceId: codexId, model: gpt },
            },
          ],
        } as ServerSettings,
        // Claude's read still shows room; only its stop says otherwise.
        [codexAt(stoppedAt - 60_000, 100), claudeAt(stoppedAt - 60_000, 30)],
      );
      // t1 is out on Codex; t2's stop holds Claude whatever its read says.
      const r1 = run("r1", 1, codexId, gpt, "m1", stoppedAt);
      const r2 = {
        ...run("r2", 1, claudeId, opus, "m2", stoppedAt),
        threadId: ThreadId.make("t2"),
      };
      state.runs = [r1, r2];
      state.threads = [stoppedShell(r1), stoppedShell(r2, "usage_limit", "t2")];
      // A Claude usage read after the stop shows room before Minis answers.
      state.whileAsked = () => {
        state.providers = [codexAt(stoppedAt - 60_000, 100), claudeAt(stoppedAt + 4_000, 20)];
      };
      yield* sweep();
      expect(state.admitted).toContain("limit-handoff:t1:r1=false");
    }),
  );
});
