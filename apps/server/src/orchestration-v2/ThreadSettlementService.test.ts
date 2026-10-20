import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  EventId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
  type PullRequestSummary,
  type ServerSettings as ContractServerSettings,
  type ServerSettingsPatch,
} from "@specweave-studio/contracts";
import { applyServerSettingsPatch } from "@specweave-studio/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Hold from "../serviceUpdate/ServiceUpdateHold.ts";
import { awaitGateOpen, makeGatedHold } from "../serviceUpdate/UpdateInstallGate.testkit.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  Pick<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">;

// A fixture's user message is one the user wrote unless the test sets
// latestUserAuthoredMessageAt on its own.
function shell(overrides: Partial<SettlementShell> = {}): SettlementShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: overrides.latestUserMessageAt ?? null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("isAutoSettlementCandidate", () => {
  it("excludes overridden, pinned, blocked, and working threads", () => {
    expect(ThreadSettlementService.isAutoSettlementCandidate(shell(), NOW_MS)).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ reportedBlocker: "Ship today or wait for the signer?" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(shell({ archivedAt: at(-1) }), NOW_MS),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ settledOverride: "settled" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ settledOverride: "active" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(shell({ pinnedAt: at(-1) }), NOW_MS),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ autoSettleDisabledAt: at(-1) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ activityRunStatus: "running" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingRuntimeRequest: { kind: "approval" } as never,
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("settles a thread whose only background work is a command left running", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("keeps snoozed threads parked until they wake early on error or completion", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(ThreadSettlementService.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    // Expired snooze is no longer a park.
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, snoozedUntil: at(-1) }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(ThreadSettlementService.threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    // Adoption stamps the run with the message time, clearing the hold.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({
          latestUserMessageAt: at(-1_000),
          latestRunId: "run-1" as never,
          latestRunRequestedAt: at(-500),
        }),
        NOW_MS,
      ),
    ).toBe(false);
    // Outside the grace window the stale message no longer blocks.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-ThreadSettlementService.QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // Client clocks ahead of the server must not extend the hold.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(ThreadSettlementService.QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // A failed start clears the hold immediately.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-1_000), status: "failed" }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("resolveAutoSettlementAt", () => {
  it("never treats elapsed inactivity as completion", () => {
    const idle = shell({
      latestUserMessageAt: at(-4 * DAY_MS),
      latestRunRequestedAt: at(-4 * DAY_MS),
      latestRunStartedAt: at(-4 * DAY_MS),
      latestRunCompletedAt: at(-3 * DAY_MS),
    });
    const input = {
      thread: idle,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: 5 }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, thread: shell() }),
    ).toBeNull();
  });

  it("settles on merge only after the user's last action and preserves the activity time", () => {
    const thread = shell({
      latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunCompletedAt: at(-90 * 60 * 1_000),
    });
    const input = {
      thread,
      pullRequest: {
        state: "merged" as const,
        mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
        updatedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
        observedAt: NOW_MS,
        checksState: "passing" as const,
        reviewDecision: "approved" as const,
      },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-90 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleOnMerge: false }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-3 * 60 * 60 * 1_000)) },
      }),
    ).toBeNull();
    // Closing without merging is not completion, even without any messages.
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell(),
        pullRequest: { state: "closed", closedAt: DateTime.formatIso(at(-1)) },
        autoSettleOnMerge: false,
      }),
    ).toBeNull();
  });

  it("settles on merge after agent-started runs, but not after the user writes again", () => {
    // A background command stopped after the merge and its notification
    // started a run. Only the user's own messages hold a merged thread open.
    const woken = shell({
      latestUserMessageAt: at(-30 * 60 * 1_000),
      latestUserAuthoredMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunRequestedAt: at(-30 * 60 * 1_000),
      latestRunCompletedAt: at(-29 * 60 * 1_000),
    });
    const input = {
      thread: woken,
      pullRequest: {
        state: "merged" as const,
        mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
        updatedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
        observedAt: NOW_MS,
        checksState: "passing" as const,
        reviewDecision: "approved" as const,
      },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-29 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...woken, latestUserAuthoredMessageAt: at(-30 * 60 * 1_000) },
      }),
    ).toBeNull();
  });

  it("keeps inactive unfinished threads active while their pull request remains open", () => {
    const input = {
      thread: shell({ latestUserMessageAt: at(-30 * DAY_MS) }),
      pullRequest: { state: "open" as const },
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell({ latestUserMessageAt: at(-DAY_MS) }),
      }),
    ).toBeNull();
  });
});

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
const LINKED_PROJECT_ID = ProjectId.make("linked-settlement-project");

describe("autoSettlementSettingsKey", () => {
  it("distinguishes a project that inherits the threshold from one that disables it", () => {
    const inherits = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    });
    const never = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
      },
    });
    assert.notStrictEqual(inherits, never);
  });

  it("ignores project overrides that do not touch settlement", () => {
    const base = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: false } },
    });
    const unrelated = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [LINKED_PROJECT_ID]: { defaultThreadEnvMode: "worktree" },
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: false, defaultAutoPull: true },
      },
    });
    assert.strictEqual(base, unrelated);
  });
});

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(id: string, overrides: Partial<SettlementShell> = {}): SettlementShell {
  return shell({
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    ...overrides,
  });
}

type SettlementSnapshot = Omit<OrchestrationV2ShellSnapshot, "threads"> & {
  readonly threads: ReadonlyArray<SettlementShell>;
};

function makeSnapshot(
  threads: ReadonlyArray<SettlementShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): SettlementSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects,
    threads,
    archivedThreads: [],
  };
}

function makePullRequestSummary(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string;
}): PullRequestSummary {
  return {
    provider: "github",
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://example.test/${input.repository}/pull/${input.number}`,
    state: input.state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: input.updatedAt ?? NOW,
    observedAt: Date.parse(NOW),
    mergedAt: input.state === "merged" ? NOW : null,
    checksState: "passing",
    reviewDecision: "approved",
  };
}

function makeBranchPullRequest(state: "open" | "closed" | "merged") {
  return {
    number: 42,
    title: "Pull request",
    url: "https://example.test/owner/repository/pull/42",
    baseRef: "main",
    headRef: "feature",
    state,
    repositoryKey: "example.test/owner/repository",
    updatedAt: NOW,
    closedAt: state === "closed" ? NOW : null,
    mergedAt: state === "merged" ? NOW : null,
  } satisfies GitManager.GitBranchPullRequest;
}

interface HarnessOptions {
  readonly snapshot: SettlementSnapshot;
  readonly settings?: ContractServerSettings;
  readonly branchPullRequest?: GitManager.GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService.PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (command: AutoSettleCommand) => Effect.Effect<void>;
  /** Threads `getThread` returns when a `thread.settled` event is handled. */
  readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly candidateSequence?: number;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const candidateReads = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsReads = yield* Ref.make(0);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const summaryCalls = yield* Ref.make<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>
  >([]);
  const summaryRecovery = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const invalidatedCwds = yield* Ref.make<ReadonlyArray<string>>([]);
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const closedIdle = yield* Queue.unbounded<{ readonly threadId: string }>();
  const closedAll = yield* Queue.unbounded<{
    readonly threadId: string;
    readonly deleteHistory?: boolean | undefined;
  }>();

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"] = (input) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService.PullRequestService["Service"]["summary"] = (
    input,
    readOptions,
  ) =>
    Effect.gen(function* () {
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      yield* Ref.update(summaryRecovery, (values) => [
        ...values,
        readOptions?.recoverTransientFailure,
      ]);
      return yield* (
        options.pullRequestSummary?.(input, readOptions) ??
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
            }),
          )
      );
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const serverSettings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.update(settingsReads, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(settings)),
    ),
    updateSettings,
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Ref.get(snapshots).pipe(Effect.map((snapshot) => snapshot.projects)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (threadId) =>
        Effect.succeed({
          thread: options.snapshot.threads.find((thread) => thread.id === threadId)!,
          runs: options.runs ?? [],
        }) as never,
      getSettlementCandidates: (threadId) =>
        Ref.update(candidateReads, (reads) => [...reads, threadId]).pipe(
          Effect.andThen(Ref.updateAndGet(snapshotReadCount, (count) => count + 1)),
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
          Effect.map((snapshot) =>
            threadId === undefined
              ? snapshot.threads
              : snapshot.threads.filter((thread) => thread.id === threadId),
          ),
        ),
      getThread: (threadId) => {
        const thread = options.currentThreads?.find((candidate) => candidate.id === threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.die(new Error(`Unexpected thread read: ${threadId}`));
      },
    }),
    Layer.mock(EventSink.EventSinkV2)({ latestSequence: () => Effect.succeed(10) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadEventSequence: () => Effect.succeed(options.candidateSequence ?? 10),
      streamDomainEvents: Stream.fromPubSub(domainEvents),
      dispatch,
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeIdle: (input) => Queue.offer(closedIdle, input).pipe(Effect.as([])),
      close: (input) => Queue.offer(closedAll, input).pipe(Effect.asVoid),
    }),
    Layer.mock(GitManager.GitManager)({
      branchPullRequest,
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      summary: pullRequestSummary,
      invalidate: () => Effect.void,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
  );

  return {
    activation,
    snapshots,
    snapshotReadCount,
    snapshotReads,
    candidateReads,
    settingsReads,
    commands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    closedIdle,
    closedAll,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    updateSettings,
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: ThreadSettlementService.layer.pipe(Layer.provide(layerDependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementService.ThreadSettlementServiceV2["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementServiceV2 worker", () => {
  it.effect("settles a merged pull request stored only in the thread links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("merged-link", {
          pullRequests: [
            {
              host: "example.test",
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
              source: "manual",
              linkedAt: "2026-08-20T00:00:00.000Z",
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
                checksState: "passing",
                reviewDecision: "approved",
              },
              stack: null,
            },
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs no sweep, git lookup or settlement while an install's gate is live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        // A one-second poll keeps the two test minutes below to a few file reads.
        const pollMs = 1_000;
        const gated = yield* makeGatedHold({ pollMs }).pipe(Effect.provide(NodeServices.layer));
        const branchThread = makeThread("gated-branch", { branch: "feature" });
        const thread = makeThread("gated-merged-link", {
          pullRequests: [
            {
              host: "example.test",
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
              source: "manual",
              linkedAt: "2026-08-20T00:00:00.000Z",
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
                checksState: "passing",
                reviewDecision: "approved",
              },
              stack: null,
            },
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread, branchThread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("merged")),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          // The activation sweep, two minute sweeps and a merge notification all wait.
          yield* fixture.publishMerge;
          yield* TestClock.adjust("2 minutes");
          yield* TestClock.withLive(Effect.sleep(Duration.millis(20)));
          assert.equal(yield* Ref.get(fixture.snapshotReadCount), 0);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* gated.clear.pipe(Effect.provide(NodeServices.layer));
          assert.isTrue(yield* awaitGateOpen(gated.hold, pollMs));
          yield* TestClock.adjust(Duration.millis(pollMs));
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          assert.isAbove((yield* Ref.get(fixture.branchCalls)).length, 0);
          // The queued sweep and the merge notification's both ran once the gate opened.
          const settled = (yield* Ref.get(fixture.commands)).map((command) => command.threadId);
          assert.isAbove(settled.length, 0);
          assert.deepStrictEqual([...new Set(settled)], [thread.id]);
        }).pipe(
          Effect.provide(fixture.layer),
          Effect.provideService(Hold.ServiceUpdateHold, gated.hold),
        );
      }),
    ),
  );

  it.effect("an old project inactivity preference cannot complete unfinished work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("project-opt-in", {
          latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
        });
        const other = makeThread("environment-off", { projectId: ProjectId.make("other-project") });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread, other]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: {
              [PROJECT_ID]: { sidebarAutoSettleAfterDays: 2, sidebarAutoSettleOnMerge: true },
            },
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands.map((command) => command.threadId)).toEqual([]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("dispatches the last activity time with the v2 snapshot guard", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("verified-merged-pr", {
          linkedPullRequest: {
            projectId: PROJECT_ID,
            repository: "owner/repository",
            number: 42,
            url: "https://example.test/owner/repository/pull/42",
          },
          latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "merged" })),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands).toHaveLength(1);
          expect(commands[0]?.settledAt).toEqual(thread.latestRunCompletedAt);
          expect(commands[0]?.snapshotAt).toEqual(thread.updatedAt);
          expect(commands[0]?.snapshotSequence).toBe(10);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips the branch recheck when a terminal link would settle nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const previous = {
          projectId: PROJECT_ID,
          repository: "owner/repository",
          number: 1,
          url: "https://example.test/owner/repository/pull/1",
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("resumed-manual", {
                branch: "main",
                linkedPullRequest: previous,
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-28T00:00:00.000Z"),
              }),
            ],
            [makeProject()],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("open")),
          pullRequestSummary: (input) =>
            Effect.succeed({
              ...makePullRequestSummary({ ...input, state: "merged" }),
              mergedAt: "2026-08-27T00:00:00.000Z",
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates immediately after a pull request merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const mergedState = yield* Ref.make<"open" | "merged">("open");
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const mergedThreadSettled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "Owner/Repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("slow-periodic-lookup", {
              branch: "another-feature",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          pullRequestSummary: (input) =>
            Ref.get(mergedState).pipe(
              Effect.map((state) => makePullRequestSummary({ ...input, state })),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* Ref.set(mergedState, "merged");
          yield* fixture.publishMerge;
          yield* Deferred.await(mergedThreadSettled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a merge notification refreshes evidence rather than manufacturing completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"open" | "merged">("open");
        const observed = yield* Queue.unbounded<void>();
        const dispatched = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("linked", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("unrelated", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 99,
                url: "https://example.test/owner/repository/pull/99",
              },
            }),
          ]),
          pullRequestSummary: (input) =>
            Ref.get(state).pipe(
              Effect.map((value) =>
                makePullRequestSummary({ ...input, state: input.number === 42 ? value : "open" }),
              ),
              Effect.tap(() => Queue.offer(observed, undefined)),
            ),
          onDispatch: () => Deferred.succeed(dispatched, undefined),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Queue.take(observed);
          yield* Queue.take(observed);
          yield* fixture.publishMerge;
          yield* Queue.take(observed);
          yield* Queue.take(observed);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          yield* Ref.set(state, "merged");
          yield* fixture.publishMerge;
          yield* Deferred.await(dispatched);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            ThreadId.make("linked"),
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("held durable queues older than the start grace prevent resolution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("held", {
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
          ]),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "merged" })),
          runs: [{ status: "queued", queueHeld: true } as OrchestrationV2Run],
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a reused branch with another open PR holds a verified legacy merge active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const project = {
          ...makeProject(),
          repositoryIdentity: {
            canonicalKey: "example.test/owner/repository",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://example.test/owner/repository.git",
            },
            displayName: "owner/repository",
          },
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("reused", {
                branch: "feature",
                linkedPullRequest: {
                  projectId: PROJECT_ID,
                  repository: "owner/repository",
                  number: 41,
                  url: "https://example.test/owner/repository/pull/41",
                },
              }),
            ],
            [project],
          ),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "merged" })),
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("open")),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("branch-only merge requires matching repository and provider readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const project = {
          ...makeProject(),
          repositoryIdentity: {
            canonicalKey: "example.test/owner/repository",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://example.test/owner/repository.git",
            },
            displayName: "owner/repository",
          },
        };
        const state = yield* Ref.make<"open" | "merged">("open");
        const completed = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("branch-only", { branch: "feature" }),
              makeThread("foreign-branch", { branch: "foreign" }),
            ],
            [project],
          ),
          branchPullRequest: ({ branch }) =>
            Ref.get(state).pipe(
              Effect.map((value) => ({
                ...makeBranchPullRequest(value),
                ...(branch === "foreign" ? { repositoryKey: "example.test/other/repository" } : {}),
              })),
            ),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "merged" })),
          onDispatch: () => Deferred.succeed(completed, undefined),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          yield* Ref.set(state, "merged");
          yield* fixture.publishMerge;
          yield* Deferred.await(completed);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            ThreadId.make("branch-only"),
          ]);
          expect(yield* Ref.get(fixture.summaryCalls)).toHaveLength(1);
          expect(yield* Ref.get(fixture.invalidatedCwds)).toEqual(["/workspace/project"]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("looks up the branch pull request from a thread's live worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("live-worktree", {
                branch: "feature/live",
                worktreePath: "/workspace/project-root/.worktrees/live",
              }),
              makeThread("deleted-worktree", {
                branch: "feature/deleted",
                worktreePath: "/workspace/project-root/.worktrees/deleted",
              }),
            ],
            [makeProject(PROJECT_ID, "/workspace/project-root")],
          ),
          existingWorktreePaths: ["/workspace/project-root/.worktrees/live"],
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            new Set(yield* Ref.get(fixture.branchCalls)),
            new Set([
              { cwd: "/workspace/project-root/.worktrees/live", branch: "feature/live" },
              { cwd: "/workspace/project-root", branch: "feature/deleted" },
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("ThreadSettlementServiceV2 terminals", () => {
  const appThread = (
    id: string,
    settledOverride: OrchestrationV2AppThread["settledOverride"],
  ): OrchestrationV2AppThread => {
    const threadId = ThreadId.make(id);
    return {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: PROJECT_ID,
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      archivedAt: null,
      settledOverride,
      settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };
  const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
    type: "thread.settled",
    id: EventId.make(`event:settled:${thread.id}`),
    threadId: thread.id,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload: thread,
  });

  const threadEvent = (
    type: "thread.archived" | "thread.deleted",
    thread: OrchestrationV2AppThread,
  ): OrchestrationV2DomainEvent => ({
    type,
    id: EventId.make(`event:${type}:${thread.id}`),
    threadId: thread.id,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload: thread,
  });

  it.effect("closes the thread's idle terminals when it settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = appThread("settled-thread", "settled");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [thread],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(thread));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: thread.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("closes idle shells of an archived thread and every shell of a deleted one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archived = appThread("archived-thread", "active");
        const deleted = appThread("deleted-thread", "active");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [archived, deleted],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(threadEvent("thread.archived", archived));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: archived.id });
          yield* fixture.publishEvent(threadEvent("thread.deleted", deleted));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedAll), {
            threadId: deleted.id,
            deleteHistory: true,
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps the terminals of a thread re-engaged before the event ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaged-thread", "settled");
        const reengaged = appThread("reengaged-thread", "active");
        const marker = appThread("marker-thread", "settled");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [reengaged, marker],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(settled));
          // Events run in order, so the first close belongs to the later
          // event only if the re-engaged thread was skipped.
          yield* fixture.publishEvent(settledEvent(marker));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("ThreadSettlementServiceV2 single-thread sweeps", () => {
  it.effect("a finished run reads only its own thread's settlement candidate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const finished = makeThread("finished-run");
        const other = makeThread("other-thread");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([finished, other]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(fixture.candidateReads, []);
          yield* fixture.publishEvent({
            type: "provider-session.detached",
            id: EventId.make("event:detached"),
            threadId: finished.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: {
              providerSessionId: ProviderSessionId.make("provider-session:finished"),
              detachedAt: DateTime.makeUnsafe(NOW),
            },
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.candidateReads), [finished.id]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("ThreadSettlementServiceV2 settings reads", () => {
  it.effect("a sweep reads settings once, not per candidate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const threads = Array.from({ length: 12 }, (_, index) =>
          makeThread(`open-branch-${index}`, { branch: `feature-${index}` }),
        );
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("open")),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(threads.length);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          // One read when the service starts, one for the sweep.
          expect(yield* Ref.get(fixture.settingsReads)).toBe(2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("automatic resolution snapshot and branch guards", () => {
  const project = {
    ...makeProject(),
    repositoryIdentity: {
      canonicalKey: "example.test/owner/repository",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://example.test/owner/repository.git",
      },
      displayName: "owner/repository",
    },
  };
  const readyThread = () =>
    makeThread("visible-reused", {
      branch: "feature",
      pullRequests: ["owner/repository", "owner/second-repository"].map((repository) => ({
        host: "example.test",
        repository,
        number: 41,
        url: `https://example.test/${repository}/pull/41`,
        source: "manual" as const,
        linkedAt: "2026-08-20T00:00:00.000Z",
        stack: null,
        snapshot: {
          state: "merged" as const,
          title: "Previous completed PR",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: NOW,
          syncedAt: NOW,
          mergedAt: NOW,
          checksState: "passing" as const,
          reviewDecision: "approved" as const,
        },
      })),
    });

  it.effect.each([
    {
      label: "same repository open",
      repositoryKey: "example.test/owner/repository",
      state: "open",
      settles: false,
    },
    {
      label: "same repository closed",
      repositoryKey: "example.test/owner/repository",
      state: "closed",
      settles: false,
    },
    {
      label: "same repository merged and linked",
      repositoryKey: "example.test/owner/repository",
      state: "merged",
      number: 41,
      settles: true,
    },
    {
      label: "same repository merged but unknown readiness",
      repositoryKey: "example.test/owner/repository",
      state: "merged",
      number: 42,
      settles: false,
    },
    { label: "unknown repository", repositoryKey: null, state: "open", settles: false },
    {
      label: "foreign repository",
      repositoryKey: "example.test/other/repository",
      state: "open",
      settles: true,
    },
  ] as const)("rechecks visible merged links against a reused branch: $label", (testCase) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const { repositoryKey, state, settles } = testCase;
        const thread = readyThread();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread], [project]),
          branchPullRequest: () =>
            Effect.succeed({
              ...makeBranchPullRequest(state),
              repositoryKey,
              number: "number" in testCase ? testCase.number : 42,
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(1);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual(
            settles ? [thread.id] : [],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each([9, 10, 11])(
    "rejects a candidate changed during its read: sequence %s",
    (sequence) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([readyThread()], [project]),
            candidateSequence: sequence,
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            const commands = yield* Ref.get(fixture.commands);
            expect(commands).toHaveLength(sequence > 10 ? 0 : 1);
            if (sequence <= 10) expect(commands[0]?.snapshotSequence).toBe(sequence);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect.each(["global", "project"] as const)(
    "a %s preference disabled during provider lookup wins",
    (scope) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const entered = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([readyThread()], [project]),
            branchPullRequest: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(released)),
                Effect.as(null),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* service.start();
            yield* Deferred.succeed(fixture.activation, undefined);
            yield* Deferred.await(entered);
            yield* fixture.updateSettings(
              scope === "global"
                ? { sidebarAutoSettleOnMerge: false }
                : {
                    projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: false } },
                  },
            );
            yield* Deferred.succeed(released, undefined);
            yield* service.drain;
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );
});
