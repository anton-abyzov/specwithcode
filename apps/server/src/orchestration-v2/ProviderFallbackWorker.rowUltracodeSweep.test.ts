import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { provider } from "../studio/fixtures.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

// 1506 D-04: a stopped run that began as a routine's message never takes the
// row's Ultracode, even after the routine was moved or deleted (no binding).
const at = Date.parse("2026-11-27T12:00:00.000Z");
const resetsAt = "2026-11-27T14:00:00.000Z";
const OPUS = "claude-opus-5-5";
const home = ProviderInstanceId.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const projectId = ProjectId.make("row-ultracode-sweep");
const medium = { id: "effort", value: "medium" };
const on = { id: "ultracode", value: true };
const claude = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
  ...provider(instanceId, "claudeAgent", at),
  models: [
    {
      slug: OPUS,
      name: "Claude Opus 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      },
    },
  ],
  usageLimits: {
    checkedAt: new Date(at).toISOString(),
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
  },
});
const providers = [claude(home, 100), claude(work, 10)];
const selection = { instanceId: home, model: OPUS, options: [medium] };
const thread = {
  id: ThreadId.make("bound-thread"),
  projectId,
  providerInstanceId: home,
  modelSelection: selection,
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  lastError: "You've hit your usage limit.",
  usageLimitResetAt: resetsAt,
  latestRunId: RunId.make("r1"),
  latestRunCompletedAt: DateTime.makeUnsafe(at),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
};
const run = {
  id: RunId.make("r1"),
  threadId: thread.id,
  ordinal: 1,
  providerInstanceId: home,
  modelSelection: selection,
  providerThreadId: null,
  userMessageId: MessageId.make("m1"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: DateTime.makeUnsafe(at - 60_000),
  startedAt: DateTime.makeUnsafe(at - 60_000),
  completedAt: DateTime.makeUnsafe(at),
  checkpointId: null,
  contextHandoffId: null,
};
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  threadModelMode: "tracks" as const,
  providerLimitAction: "switch" as const,
  providerLimitWaitUnderMinutes: 0,
  modelLanes: { routine: [{ instanceId: home, model: OPUS, options: [medium, on] }], complex: [] },
};

// The first hop's run, started by the fallback's own message (no routine id).
const origin = { ...run, id: RunId.make("r0"), userMessageId: MessageId.make("m0") };
const hopped = {
  ...run,
  userMessageId: MessageId.make(`limit-fallback:${thread.id}:${origin.id}`),
};

const continuation = (scheduledTaskId: string | undefined, secondHop = false, database = true) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at + 1_000);
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const first = secondHop ? origin : run;
    const runs = secondHop ? [hopped, origin] : [run];
    const messages = [
      { id: first.userMessageId, ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }) },
      ...(secondHop ? [{ id: hopped.userMessageId }] : []),
    ];
    const deps = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Fixture",
              workspaceRoot: "/fixture",
              defaultModelSelection: null,
              workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              scripts: [],
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              deletedAt: null,
            }),
          ),
      }),
      fallbackPolicyTestLayer(settings),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed(providers),
        refreshInstance: () => Effect.succeed(providers),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () => Effect.succeed({ threads: [thread] } as never),
        getThreadShell: () => Effect.succeed(thread as never),
        getThreadRecords: (_id, _fields, filter) =>
          Effect.succeed({
            thread,
            runs:
              filter?.runIds === undefined
                ? runs
                : runs.filter((entry) => filter.runIds!.includes(entry.id)),
            providerThreads: [
              { appThreadId: thread.id, nativeThreadRef: { nativeId: "existing-session" } },
            ],
            turnItems: [],
            messages: messages.filter((message) => filter?.messageIds?.includes(message.id)),
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
    yield* Effect.gen(function* () {
      const sweep = yield* makeSweep;
      yield* sweep();
    }).pipe(
      Effect.provide(database ? Layer.merge(deps, Sqlite.layerMemory) : deps),
      Effect.provideService(ProviderFallbackEnv, {}),
    );
    const sent = dispatched.find((command) => command.type === "message.dispatch");
    if (sent?.type !== "message.dispatch") throw new Error("expected a continuation");
    expect(sent.modelSelection?.instanceId).toBe(work);
    return sent.modelSelection?.options ?? [];
  });

describe("a stopped run's origin in the sweep (1506 D-04)", () => {
  it.effect("gives a person's stopped turn the row's Ultracode on the same model elsewhere", () =>
    Effect.gen(function* () {
      expect(yield* continuation(undefined)).toContainEqual(on);
    }),
  );

  it.effect("keeps a routine's stopped turn off, with no binding left to go by", () =>
    Effect.gen(function* () {
      expect(yield* continuation("routine-1")).not.toContainEqual(on);
    }),
  );

  it.effect("gives nothing when the routines cannot be read", () =>
    Effect.gen(function* () {
      expect(yield* continuation(undefined, false, false)).not.toContainEqual(on);
    }),
  );

  it.effect("keeps it off on a second hop, following the continuation back to the routine", () =>
    Effect.gen(function* () {
      expect(yield* continuation("routine-1", true)).not.toContainEqual(on);
      expect(yield* continuation(undefined, true)).toContainEqual(on);
    }),
  );
});
