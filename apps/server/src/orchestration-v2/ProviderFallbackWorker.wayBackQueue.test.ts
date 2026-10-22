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
import { describe, expect, it } from "vite-plus/test";

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
import { queuedRunsPinnedTo } from "./limitFallbackReturn.ts";
import {
  inheritedRunsLeftOnPreviousSelection,
  queuedRunsHoldingWayBack,
} from "./QueueFollowsThread.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

const stoppedAt = Date.parse("2026-10-21T06:44:00.000Z");
const opus = "claude-opus-5.5";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const project = {
  id: ProjectId.make("way-back"),
  title: "Way back project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
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
          resetsAt: "2026-10-21T09:30:00.000Z",
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
  message: string;
  status: "completed" | "failed" | "queued";
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
  queueHeld: false,
  requestedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  startedAt: DateTime.makeUnsafe(input.completedAt - 5_000),
  completedAt: DateTime.makeUnsafe(input.completedAt),
  checkpointId: null,
  contextHandoffId: null,
});
type Run = ReturnType<typeof run>;

// Claude stopped on its limit (r1), the fallback moved the thread to Codex
// (r2, completed), and Claude has room again.
const r1 = run({
  id: "r1",
  ordinal: 1,
  instanceId: claudeId,
  model: opus,
  message: "m1",
  status: "failed",
  completedAt: stoppedAt,
});
const moved = run({
  id: "r2",
  ordinal: 2,
  instanceId: codexId,
  model: "gpt-6",
  message: `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1`,
  status: "completed",
  completedAt: stoppedAt + 25_000,
});
const thread = {
  id: ThreadId.make("t1"),
  projectId: project.id,
  providerInstanceId: codexId,
  modelSelection: { instanceId: codexId, model: "gpt-6" },
  status: "completed" as const,
  lastErrorClass: null,
  usageLimitResetAt: null,
  latestRunId: moved.id,
  latestRunCompletedAt: moved.completedAt,
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
};

function harness(queued: Run, message: Record<string, unknown>) {
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer(settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.succeed([
        withWindow(provider(claudeId, "claudeAgent", stoppedAt + 20_000), opus, 20),
        withWindow(provider(codexId, "codex", stoppedAt), "gpt-6", 30),
      ]),
      refreshInstance: () => Effect.succeed([]),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.succeed({ threads: [thread] } as never),
      getThreadShell: () => Effect.succeed(thread as never),
      getThreadRecords: (_threadId, _fields, filter) =>
        Effect.succeed({
          runs: [r1, moved, queued],
          turnItems: [],
          runtimeRequests: [],
          nodes: [],
          messages: [{ id: queued.userMessageId, ...message }].filter(
            (entry) => filter?.messageIds === undefined || filter.messageIds.includes(entry.id),
          ),
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
    yield* TestClock.setTime(stoppedAt + 30_000);
    const sweep = yield* makeSweep;
    yield* sweep();
    return dispatched.map((command) => command.commandId);
  }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
}

const queuedOn = (instanceId: ProviderInstanceId, model: string) =>
  run({
    id: "r3",
    ordinal: 3,
    instanceId,
    model,
    message: "m3",
    status: "queued",
    completedAt: stoppedAt + 26_000,
  });
const wake = {
  createdBy: "agent",
  creationSource: "server",
  notification: { kind: "background-task" },
};
const send = { createdBy: "user", creationSource: "web", text: "Next.", attachments: [] };

describe("the way back with a queue on the fallback", () => {
  itEffect.effect("goes back past a delivery that follows the thread", () =>
    Effect.gen(function* () {
      expect(yield* harness(queuedOn(codexId, "gpt-6"), wake)).toEqual(["limit-return:t1:r2"]);
    }),
  );

  itEffect.effect("waits for a message a person put on another model of the fallback", () =>
    Effect.gen(function* () {
      expect(yield* harness(queuedOn(codexId, "gpt-6-mini"), send)).toEqual([]);
    }),
  );

  itEffect.effect("goes back past a send that took the fallback's model, held or not", () =>
    Effect.gen(function* () {
      for (const queueHeld of [false, true]) {
        const queued = { ...queuedOn(codexId, "gpt-6"), queueHeld };
        expect(yield* harness(queued, send)).toEqual(["limit-return:t1:r2"]);
      }
    }),
  );

  it("moves the sends that took the fallback's model home, held or not", () => {
    const unheld = queuedOn(codexId, "gpt-6");
    const held = { ...unheld, id: RunId.make("r4"), userMessageId: "m4" as never, queueHeld: true };
    const picked = {
      ...unheld,
      id: RunId.make("r5"),
      userMessageId: "m5" as never,
      modelSelection: { instanceId: codexId, model: "gpt-6-mini" },
    };
    const compact = { ...unheld, id: RunId.make("r6"), userMessageId: "m6" as never };
    const projection = {
      thread,
      runs: [r1, moved, unheld, held, picked, compact],
      messages: [
        { id: "m3", ...send, text: "Next.", attachments: [] },
        { id: "m4", ...send, text: "Later.", attachments: [] },
        { id: "m5", ...send, text: "On mini.", attachments: [] },
        { id: "m6", ...send, text: "/compact", attachments: [] },
      ],
    } as never;
    const home = { instanceId: claudeId, model: opus };
    expect(inheritedRunsLeftOnPreviousSelection(projection, home).map(({ run }) => run.id)).toEqual(
      ["r3", "r4"],
    );
    // A person's own pick, and maintenance of the fallback's session, stay and hold.
    expect(queuedRunsHoldingWayBack(projection, codexId, home).map((entry) => entry.id)).toEqual([
      "r5",
      "r6",
    ]);
  });

  it("counts a run a continuation re-pointed to the fallback, never a held one", () => {
    // Queued on Claude, moved to Codex's model: it would start on Codex.
    const repointed = {
      ...queuedOn(claudeId, opus),
      modelSelection: { instanceId: codexId, model: "gpt-6" },
    };
    const held = { ...queuedOn(codexId, "gpt-6"), id: RunId.make("r4"), queueHeld: true };
    expect(
      queuedRunsPinnedTo([r1, moved, repointed, held] as never, codexId).map((entry) => entry.id),
    ).toEqual(["r3"]);
    expect(queuedRunsPinnedTo([repointed] as never, claudeId)).toHaveLength(1);
  });
});
