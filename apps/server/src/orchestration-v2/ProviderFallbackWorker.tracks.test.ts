import { it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { fallbackSelectionKey } from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { LimitSourceHoldsShared } from "./UnopenableHolds.ts";

const now = Date.parse("2026-11-24T08:00:00Z");
const reset = "2026-11-27T08:00:00Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("track-test");
const fable = { instanceId: claudeId, model: "claude-fable-5-2" };
const astra = { instanceId: codexId, model: "gpt-6-astra" };

const models = (...slugs: string[]) =>
  slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null }));

it.effect.each(["recovers", "still fails", "wait"] as const)(
  "rechecks usage for a fallback on the built-in Complex track (%s)",
  (outcome) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const completedAt = DateTime.makeUnsafe(now - 1_000);
      const thread = {
        id: ThreadId.make("track-thread"),
        projectId,
        providerInstanceId: claudeId,
        modelSelection: fable,
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: reset,
        latestRunId: RunId.make("fable-stopped"),
        latestRunCompletedAt: completedAt,
        activeRunId: null,
        pendingRuntimeRequest: null,
        settledOverride: null,
        snoozedUntil: null,
      } as OrchestrationV2ThreadShell;
      const claude = {
        ...provider(claudeId, "claudeAgent", now - 2_000),
        models: models(fable.model),
      };
      const installed = provider(codexId, "codex", now);
      const codex = {
        ...installed,
        models: models(astra.model),
        usageLimits: {
          ...installed.usageLimits!,
          windows: [
            {
              id: "five_hour",
              kind: "session" as const,
              label: "Session",
              usedPercent: 20,
              resetsAt: reset,
            },
          ],
        },
      };
      const refreshed: string[] = [];
      const dispatched: OrchestrationV2ServerCommand[] = [];
      const published = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      let next = {
        ...codex,
        usageLimits: {
          ...codex.usageLimits!,
          windows: [],
          unavailable: { reason: "probeFailed" as const },
        } as typeof codex.usageLimits,
      };
      const deps = Layer.mergeAll(
        fallbackPolicyTestLayer({
          ...DEFAULT_SERVER_SETTINGS,
          providerLimitAction: outcome === "wait" ? "wait" : "switch",
          threadModelMode: "tracks",
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                title: "Track recovery",
                workspaceRoot: "/track-test",
                defaultModelSelection: null,
                workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                scripts: [],
                createdAt: "2026-11-24T08:00:00Z",
                updatedAt: "2026-11-24T08:00:00Z",
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(Providers.ProviderRegistry)({
          getProviders: Effect.sync(() => [claude, next]),
          refreshInstance: (id) =>
            Effect.sync(() => {
              refreshed.push(id);
              if (outcome === "recovers" && id === codexId) next = codex;
              return [claude, next];
            }),
        }),
        Layer.mock(Instances.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () => Effect.succeed({ threads: [thread] } as never),
          getThreadShell: () => Effect.succeed(thread),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [
                {
                  id: thread.latestRunId,
                  providerInstanceId: claudeId,
                  modelSelection: fable,
                  status: "failed",
                  startedAt: DateTime.makeUnsafe(now - 60_000),
                  completedAt,
                  userMessageId: "fable-request",
                  ordinal: 1,
                },
              ],
              turnItems: [],
              runtimeRequests: [],
              nodes: [],
              messages: [],
              providerThreads: [],
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
      const sweep = yield* makeSweep.pipe(
        Effect.provide(deps),
        Effect.provideService(ProviderFallbackEnv, {}),
      );
      const sweepWithHolds = sweep().pipe(
        Effect.provideService(LimitSourceHoldsShared, {
          get: Ref.get(published),
          set: (holds) => Ref.set(published, holds),
        }),
      );
      yield* sweepWithHolds;
      expect((yield* Ref.get(published)).has(fallbackSelectionKey(fable))).toBe(true);
      expect(refreshed).toEqual(outcome === "wait" ? [] : [codexId]);
      expect(dispatched).toEqual(
        outcome === "recovers"
          ? [expect.objectContaining({ type: "message.dispatch", modelSelection: astra })]
          : [],
      );
      if (outcome === "still fails") {
        yield* TestClock.adjust("31 seconds");
        yield* sweepWithHolds;
        expect(refreshed).toEqual([codexId]);
      }
    }),
);
