import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  GITHUB_COPILOT_AGENT_ID,
  officialAcpRegistryIconUrlForAgentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
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
import { usageLimitReplyFailure } from "./Adapters/acpLimitReply.ts";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  makeSweep,
  ProviderFallbackEnv,
  unreportedLimitStops,
} from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { usageLimitHeldInstances } from "./UnopenableHolds.ts";
import { resolveProviderFallback } from "@specweave-studio/shared/providerFallback";

/**
 * The 2026-10-21 incident: the specweave coordinator stopped on Codex's
 * weekly limit, the fallback moved it to Copilot, and Copilot answered with
 * its monthly quota notice. That reply now fails the run as a usage limit
 * (see acpLimitReply), and the sweep has to carry the thread on to a third
 * provider with no manual step, and keep other threads off Copilot.
 */
const now = Date.parse("2026-10-21T21:54:00.000Z");
const weeklyReset = "2026-10-27T06:40:59.000Z";
const codexId = ProviderInstanceId.make("codex");
const copilotId = ProviderInstanceId.make("acpRegistry_copilot");
const claudeId = ProviderInstanceId.make("claudeAgent");
const model = "gpt-6.1-sol";
const coordinatorId = ThreadId.make("project-coordinator:specweave");
const workerId = ThreadId.make("thread:delegated-task:disk-audit");
const COPILOT_QUOTA_REPLY =
  "Error: You have exceeded your monthly quota (Request ID: E1F2:3A4B:5C6D:7E8F:9A0B1C2D)";

function withWindow(base: ServerProvider, slug: string, usedPercent: number): ServerProvider {
  return {
    ...base,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent, resetsAt: weeklyReset },
      ],
    },
  };
}

const codexSpent = withWindow(provider(codexId, "codex", now), model, 100);
const claudeReady = withWindow(provider(claudeId, "claudeAgent", now), "claude-opus-5.5", 20);
// Copilot behind the ACP registry reports no usage at all.
const { usageLimits: _none, ...copilotBase } = provider(copilotId, "acpRegistry", now);
const copilot: ServerProvider = {
  ...copilotBase,
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
  models: [{ slug: model, name: "GPT-6.1 Sol", isCustom: true, capabilities: null }],
};

const project = {
  id: ProjectId.make("specweave"),
  title: "specweave",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, coordinatorThreadId: coordinatorId },
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  deletedAt: null,
};

/** A thread whose latest run stopped on a usage limit on `instanceId`. */
function stopped(
  id: ThreadId,
  instanceId: ProviderInstanceId,
  runId: string,
  resetAt: string | null,
  lastError: string,
) {
  return {
    id,
    projectId: project.id,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model },
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    lastError,
    usageLimitResetAt: resetAt,
    latestRunId: RunId.make(runId),
    latestRunCompletedAt: DateTime.makeUnsafe(now - 5_000),
    activeRunId: null,
    pendingRuntimeRequest: null,
    settledOverride: null,
  };
}

type Thread = Omit<ReturnType<typeof stopped>, "status" | "lastErrorClass"> & {
  readonly status: "failed" | "completed";
  readonly lastErrorClass: "usage_limit" | null;
};

function harness(
  providers: ReadonlyArray<ServerProvider> = [codexSpent, copilot, claudeReady],
  records?: (
    filter: { readonly turnItemRunIds?: ReadonlyArray<string | null> | undefined } | undefined,
  ) => unknown,
) {
  let threads: ReadonlyArray<Thread> = [];
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
    fallbackPolicyTestLayer({ ...DEFAULT_SERVER_SETTINGS, providerLimitAction: "switch" }),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed([]),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.sync(() => ({ threads }) as never),
      getThreadShell: (threadId) =>
        Effect.sync(() => (threads.find((thread) => thread.id === threadId) ?? null) as never),
      getThreadRecords: (threadId, _fields, filter) =>
        records === undefined
          ? Effect.sync(
              () =>
                ({
                  runs: threads
                    .filter((thread) => thread.id === threadId)
                    .map((thread) => ({
                      id: thread.latestRunId,
                      userMessageId: "message:hold",
                      ordinal: 1,
                      providerInstanceId: thread.providerInstanceId,
                      modelSelection: thread.modelSelection,
                      status: thread.status,
                      startedAt: DateTime.makeUnsafe(now - 60_000),
                      completedAt: thread.latestRunCompletedAt,
                    })),
                  turnItems: [],
                  runtimeRequests: [],
                  nodes: [],
                  messages: [],
                  providerThreads: [],
                }) as never,
            )
          : Effect.sync(() => records(filter) as never),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => (dispatched.push(command), { sequence: 1, storedEvents: [] })),
    }),
  );
  return Effect.gen(function* () {
    const sweep = yield* makeSweep;
    return {
      dispatched,
      sweep,
      setThreads: (next: ReadonlyArray<Thread>) => {
        threads = next;
      },
    };
  }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
}

describe("a Copilot quota reply in the fallback chain", () => {
  it.effect("moves on from Copilot to a third provider and keeps others off it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const { dispatched, sweep, setThreads } = yield* harness();

      // Codex stops on its weekly limit. Copilot has the same model but no
      // usage to read; Claude has a fresh read with room, so Claude wins.
      setThreads([
        stopped(coordinatorId, codexId, "run:565", weeklyReset, "Codex weekly limit reached."),
      ]);
      yield* sweep();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "message.dispatch",
        threadId: coordinatorId,
        manualContinuationOfRunId: "run:565",
        modelSelection: { instanceId: claudeId },
      });
      // A thread that was on Copilot anyway (a person picked it) stops on its quota.
      dispatched.length = 0;

      // Copilot answers with its quota notice, which now fails the run as a usage limit.
      const failure = usageLimitReplyFailure(COPILOT_QUOTA_REPLY);
      expect(failure).toMatchObject({ class: "usage_limit", code: null });
      yield* TestClock.adjust("1 minute");
      setThreads([
        stopped(coordinatorId, copilotId, "run:566", null, failure!.message),
        // Another thread stops on Codex meanwhile: Copilot would still read as ready.
        stopped(workerId, codexId, "run:16", weeklyReset, "Codex weekly limit reached."),
      ]);
      yield* sweep();
      expect(dispatched).toHaveLength(2);
      expect(dispatched).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message.dispatch",
            threadId: coordinatorId,
            manualContinuationOfRunId: "run:566",
            modelSelection: expect.objectContaining({ instanceId: claudeId }),
          }),
          expect.objectContaining({
            type: "message.dispatch",
            threadId: workerId,
            manualContinuationOfRunId: "run:16",
            modelSelection: expect.objectContaining({ instanceId: claudeId }),
          }),
        ]),
      );
      // The hold is shared, so the coordinator's next turn and new workers keep off Copilot too.
      const held = yield* usageLimitHeldInstances(DateTime.toEpochMillis(yield* DateTime.now));
      expect([...held]).toEqual([copilotId]);
    }),
  );

  it.effect("holds the stopped run's instance after the thread selected another provider", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const original = stopped(workerId, copilotId, "run:changed-selection", weeklyReset, "quota");
      const { sweep, setThreads } = yield* harness([codexSpent, copilot, claudeReady], () => ({
        runs: [
          {
            id: original.latestRunId,
            providerInstanceId: copilotId,
            modelSelection: original.modelSelection,
            status: "failed",
            startedAt: DateTime.makeUnsafe(now - 60_000),
            completedAt: original.latestRunCompletedAt,
          },
        ],
        turnItems: [],
        runtimeRequests: [],
        nodes: [],
        messages: [],
        providerThreads: [],
      }));
      setThreads([
        {
          ...original,
          providerInstanceId: claudeId,
          modelSelection: { instanceId: claudeId, model: "claude-opus-5.5" },
        },
      ]);
      yield* sweep();
      expect([...(yield* usageLimitHeldInstances(now))]).toEqual([copilotId]);
    }),
  );

  it.effect("keeps a recovered account clear on every sweep while an older stop remains", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const failed = stopped(workerId, copilotId, "run:old-stop", weeklyReset, "quota");
      const recovered = {
        ...stopped(coordinatorId, claudeId, "run:recovered", null, ""),
        status: "completed" as const,
        lastErrorClass: null,
      };
      const runs = [
        {
          id: failed.latestRunId,
          providerInstanceId: copilotId,
          modelSelection: failed.modelSelection,
          status: "failed",
          startedAt: DateTime.makeUnsafe(now - 60_000),
          completedAt: failed.latestRunCompletedAt,
          userMessageId: "message:failed",
          ordinal: 1,
        },
        {
          id: recovered.latestRunId,
          providerInstanceId: copilotId,
          modelSelection: failed.modelSelection,
          status: "completed",
          startedAt: DateTime.makeUnsafe(now - 4_000),
          completedAt: DateTime.makeUnsafe(now - 1_000),
          userMessageId: "message:recovered",
          ordinal: 2,
        },
      ];
      const { sweep, setThreads } = yield* harness([codexSpent, copilot, claudeReady], () => ({
        runs,
        turnItems: [],
        runtimeRequests: [],
        nodes: [],
        messages: [],
        providerThreads: [],
      }));
      setThreads([failed, recovered]);
      for (let i = 0; i < 3; i++) {
        yield* sweep();
        expect([...(yield* usageLimitHeldInstances(now + i * 60_000))]).toEqual([]);
        yield* TestClock.adjust("1 minute");
      }
    }),
  );

  it.effect("keeps API billing recovery tied to the run after a manual instance selection", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const api: ServerProvider = {
        ...provider(claudeId, "claudeAgent", now),
        auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
        usageLimits: undefined,
      };
      const selected = { ...api, instanceId: ProviderInstanceId.make("claude-api-selected") };
      for (const actual of [api, copilot]) {
        const message =
          actual.instanceId === api.instanceId
            ? "You've hit your session limit · resets 5pm (America/New_York)"
            : COPILOT_QUOTA_REPLY;
        const original = stopped(
          workerId,
          actual.instanceId,
          "run:manual-api-selection",
          weeklyReset,
          message,
        );
        const run = {
          id: original.latestRunId,
          providerInstanceId: actual.instanceId,
          modelSelection: original.modelSelection,
          status: "failed",
          startedAt: DateTime.makeUnsafe(now - 60_000),
          completedAt: original.latestRunCompletedAt,
          userMessageId: "message:original",
          ordinal: 1,
        };
        const { sweep, setThreads, dispatched } = yield* harness([api, selected, copilot], () => ({
          runs: [run],
          turnItems: [
            {
              type: "error",
              runId: run.id,
              failure: { class: "usage_limit", message, code: null, retryable: null },
            },
          ],
          runtimeRequests: [],
          nodes: [],
          messages: [],
          providerThreads: [],
        }));
        setThreads([
          {
            ...original,
            providerInstanceId: selected.instanceId,
            modelSelection: { instanceId: selected.instanceId, model },
          },
        ]);
        yield* sweep();
        expect([...(yield* usageLimitHeldInstances(now))]).toEqual(
          actual.instanceId === api.instanceId ? [] : [copilotId],
        );
        expect(
          dispatched.some((command) => String(command.commandId).startsWith("limit-billing:")),
        ).toBe(false);
      }
    }),
  );

  it.effect("goes home past Copilot once the provider it first stopped on has room", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now + 60 * 60_000);
      // Codex stopped (565), Copilot stopped on its quota (566), Claude finished (567).
      const run = (
        id: string,
        ordinal: number,
        instanceId: ProviderInstanceId,
        status: "failed" | "completed",
        message: string,
      ) => ({
        id: RunId.make(id),
        threadId: workerId,
        ordinal,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model },
        userMessageId: message,
        status,
        queueHeld: false,
        completedAt: DateTime.makeUnsafe(now + ordinal * 1_000),
      });
      const runs = [
        run("run:565", 565, codexId, "failed", "pr-watch:1"),
        run(
          "run:566",
          566,
          copilotId,
          "failed",
          `${LIMIT_FALLBACK_MESSAGE_PREFIX}${workerId}:run:565`,
        ),
        run(
          "run:567",
          567,
          claudeId,
          "completed",
          `${LIMIT_FALLBACK_MESSAGE_PREFIX}${workerId}:run:566`,
        ),
      ];
      const limitItem = (runId: string, resetAt: string | null) => ({
        type: "error",
        runId: RunId.make(runId),
        failure: {
          class: "usage_limit",
          message: "limit",
          code: null,
          retryable: null,
          ...(resetAt === null ? {} : { resetAt }),
        },
      });
      const turnItems = [limitItem("run:565", weeklyReset), limitItem("run:566", null)];
      const codexRoom = withWindow(provider(codexId, "codex", now + 60 * 60_000), model, 10);
      const { dispatched, sweep, setThreads } = yield* harness(
        [codexRoom, copilot, claudeReady],
        (filter) => ({
          runs,
          turnItems: turnItems.filter(
            (item) =>
              filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(item.runId),
          ),
          runtimeRequests: [],
          nodes: [],
          messages: [],
          providerThreads: [],
        }),
      );
      setThreads([
        {
          ...stopped(workerId, claudeId, "run:567", null, ""),
          status: "completed",
          lastErrorClass: null,
        },
      ]);
      yield* sweep();
      expect(dispatched).toEqual([
        expect.objectContaining({
          type: "thread.model-selection.set",
          threadId: workerId,
          modelSelection: { instanceId: codexId, model },
        }),
      ]);
    }),
  );

  it.effect("moves a Copilot quota stop to verified Codex before an unchecked sibling", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const siblingId = ProviderInstanceId.make("copilot-second-instance");
      const independentId = ProviderInstanceId.make("copilot-independent");
      const iconUrl = officialAcpRegistryIconUrlForAgentId(GITHUB_COPILOT_AGENT_ID)!;
      const managed: ServerProvider = {
        ...copilot,
        iconUrl,
        models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
      };
      const sibling: ServerProvider = { ...managed, instanceId: siblingId };
      const independent: ServerProvider = {
        ...managed,
        instanceId: independentId,
        models: [
          { slug: "independent-model", name: "Independent", isCustom: false, capabilities: null },
        ],
      };
      const codexReady = withWindow(provider(codexId, "codex", now), model, 20);
      const claudeSpent = withWindow(
        provider(claudeId, "claudeAgent", now),
        "claude-opus-5.5",
        100,
      );
      const { dispatched, sweep, setThreads } = yield* harness([
        claudeSpent,
        managed,
        sibling,
        independent,
        codexReady,
      ]);
      const coordinator: Thread = {
        ...stopped(coordinatorId, codexId, "run:coordinator", null, ""),
        status: "completed",
        lastErrorClass: null,
      };
      const failure = usageLimitReplyFailure(COPILOT_QUOTA_REPLY, now)!;
      setThreads([
        coordinator,
        stopped(workerId, copilotId, "run:first-copilot-quota", null, failure.message),
      ]);
      yield* sweep();
      // The sibling shares the model but reports no usage: Codex's verified room wins.
      expect(dispatched).toEqual([
        expect.objectContaining({
          type: "message.dispatch",
          threadId: workerId,
          manualContinuationOfRunId: "run:first-copilot-quota",
          modelSelection: { instanceId: codexId, model },
        }),
      ]);
      const held = yield* usageLimitHeldInstances(now);
      expect([...held]).toEqual([copilotId]);
      // With nothing verified, a sibling is still tried before giving up.
      expect(
        resolveProviderFallback({
          providers: [managed, sibling, independent],
          currentInstanceId: copilotId,
          currentModel: model,
          rule: DEFAULT_SERVER_SETTINGS,
          nowMs: now,
          anyReady: true,
          limitedInstanceIds: held,
        }),
      ).toEqual({ instanceId: siblingId, model });
      yield* sweep();
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(dispatched).toHaveLength(1);
    }),
  );

  // October 23, 2026, EasyChamp coordinator: Claude (credits too low), then
  // two Copilot quota replies, then Codex. Each try failed within seconds,
  // yet each next one started 26 s later, on the sweep's half-minute clock.
  it.effect("tries the next provider seconds after each failed run, not a sweep interval", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const siblingId = ProviderInstanceId.make("copilot-0889");
      const sibling: ServerProvider = { ...copilot, instanceId: siblingId };
      const codexReady = withWindow(provider(codexId, "codex", now), model, 20);
      const providers = [copilot, sibling];
      const { dispatched, sweep, setThreads } = yield* harness(providers);
      const failure = usageLimitReplyFailure(COPILOT_QUOTA_REPLY)!;
      const failOn = (instanceId: ProviderInstanceId, runId: string) =>
        Effect.gen(function* () {
          const completedAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
          setThreads([
            {
              ...stopped(coordinatorId, instanceId, runId, null, failure.message),
              latestRunCompletedAt: completedAt,
            },
          ]);
        });

      yield* failOn(copilotId, "run:copilot-quota");
      yield* sweep();
      expect(dispatched).toEqual([
        expect.objectContaining({ modelSelection: { instanceId: siblingId, model } }),
      ]);

      // Codex becomes ready as the sibling fails; a wake must bypass the interval.
      providers.push(codexReady);
      // The sibling fails five seconds later: without a wake the sweep waits.
      yield* TestClock.adjust("5 seconds");
      yield* failOn(siblingId, "run:sibling-quota");
      yield* sweep();
      expect(dispatched).toHaveLength(1);
      // The failed run woke it: the next tick moves the thread on.
      yield* sweep.wake;
      yield* sweep();
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]).toMatchObject({
        commandId: `limit-fallback:${coordinatorId}:run:sibling-quota`,
        modelSelection: { instanceId: codexId, model },
      });
    }),
  );

  it("never infers sibling quota from matching icons, absent paths, or matching homes", () => {
    const iconUrl = officialAcpRegistryIconUrlForAgentId(GITHUB_COPILOT_AGENT_ID)!;
    const siblingId = ProviderInstanceId.make("copilot-unproven-sibling");
    for (const runtimePaths of [
      undefined,
      { homePath: "/synthetic/shared-home", shadowHomePath: null },
    ]) {
      const managed = { ...copilot, iconUrl, ...(runtimePaths ? { runtimePaths } : {}) };
      const sibling = { ...managed, instanceId: siblingId };
      const held = unreportedLimitStops(
        new Map(),
        [stopped(workerId, copilotId, "run:quota", null, COPILOT_QUOTA_REPLY)],
        [managed, sibling],
        now,
      );
      expect([...held.keys()]).toEqual([copilotId]);
    }
  });

  it("does not spread or retain sibling holds after account configuration changes", () => {
    const iconUrl = officialAcpRegistryIconUrlForAgentId(GITHUB_COPILOT_AGENT_ID)!;
    const siblingId = ProviderInstanceId.make("copilot-sibling");
    const independentId = ProviderInstanceId.make("copilot-account-b");
    const accountA = { homePath: "/synthetic/account-a", shadowHomePath: null };
    const accountB = { homePath: "/synthetic/account-b", shadowHomePath: null };
    const mainA = { ...copilot, iconUrl, runtimePaths: accountA };
    const independentB = { ...copilot, iconUrl, instanceId: independentId, runtimePaths: accountB };
    const failure = stopped(workerId, copilotId, "run:failed-on-a", null, COPILOT_QUOTA_REPLY);
    const before = unreportedLimitStops(new Map(), [failure], [mainA, independentB], now);
    const mainNowB = { ...mainA, runtimePaths: accountB };
    for (const prior of [before, new Map<string, number>()]) {
      const after = unreportedLimitStops(prior, [failure], [mainNowB, independentB], now + 1_000);
      expect(after.has(independentId)).toBe(false);
    }
    const siblingA = { ...mainA, instanceId: siblingId };
    const first = unreportedLimitStops(new Map(), [failure], [mainA, siblingA], now);
    const siblingNowB = { ...siblingA, runtimePaths: accountB };
    const retained = unreportedLimitStops(first, [], [mainA, siblingNowB], now + 1_000);
    expect(retained.has(siblingId)).toBe(false);
  });
});
