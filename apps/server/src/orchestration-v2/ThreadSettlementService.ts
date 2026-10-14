import { backgroundWorkHoldsCompletion } from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import { sourceControlRepositorySelector } from "@specweave-studio/shared/sourceControl";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { visibleThreadPullRequests } from "@specweave-studio/shared/threadPullRequests";
import {
  CommandId,
  type ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import { makeDrainableWorker } from "@specweave-studio/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";

import { resolutionMergeAt, type ResolutionPullRequest } from "./ThreadResolutionPolicy.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";

export type SettlementPullRequest = ResolutionPullRequest;

export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function latestMillis(values: ReadonlyArray<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: {
    readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
  },
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    canonicalRepositoryKey(pullRequest.repositoryKey) ===
      canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

/**
 * A recent user message stays queued until a run adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. A failed run start
 * clears the block immediately (mirrors the v1 session "error" rule).
 */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(
  thread: Omit<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  // Blocked-on-you work must never park behind a settled override.
  if (thread.pendingRuntimeRequest !== null) return false;
  // A live run, or background work that will wake the agent, is not
  // staleness. A dev server left running is: the agent is done.
  if (thread.activityRunStatus != null) return false;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return true;
  // A snoozed thread that woke early (error or completed work) can settle;
  // one still parked on its wake time keeps its stronger statement.
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  const wokeOnCompletion =
    snoozedAtMs !== null && completedAtMs !== null && completedAtMs > snoozedAtMs;
  return wokeOnError || wokeOnCompletion;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: ProjectionStore.ProjectionSettlementCandidate;
  readonly pullRequest: SettlementPullRequest | null;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): DateTime.Utc | null {
  const { thread } = input;
  const links = visibleThreadPullRequests(thread.pullRequests ?? []);
  const pullRequests =
    links.length > 0
      ? links.map((link) => link.snapshot)
      : input.pullRequest === null
        ? []
        : [input.pullRequest];
  const userAnchorMs = latestMillis([
    toMillis(thread.createdAt),
    toMillis(thread.latestUserAuthoredMessageAt),
  ]);
  if (
    !input.autoSettleOnMerge ||
    userAnchorMs === null ||
    resolutionMergeAt(pullRequests, userAnchorMs, input.nowMs) === null
  )
    return null;
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  const activityAtMs = latestMillis([
    toMillis(thread.latestUserMessageAt),
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ]);
  // Retain the stored threshold for wire compatibility; inactivity is not completion.
  return activityAtMs === null ? thread.createdAt : DateTime.makeUnsafe(activityAtMs);
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

function autoSettlementConfigured(
  settings: import("@specweave-studio/contracts").ServerSettings,
): boolean {
  if (settings.sidebarAutoSettleOnMerge) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) => entry.sidebarAutoSettleOnMerge === true,
  );
}

/** Identity of every settlement input, so unrelated settings edits do not trigger a sweep. */
/** @internal Exported for tests. */
export function autoSettlementSettingsKey(
  settings: import("@specweave-studio/contracts").ServerSettings,
): string {
  return JSON.stringify([
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    // Only entries that touch settlement, in a stable order, so a project
    // override on an unrelated key does not queue a sweep. JSON drops
    // undefined, so inherit (absent) and never (null) need distinct marks.
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
      ]),
  ]);
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const updateHold = yield* ServiceUpdateHold.optional;

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) {
    const settings = yield* settingsService.getSettings;
    if (!autoSettlementConfigured(settings)) {
      return;
    }
    // A sweep for one thread reads only that thread's candidate row.
    // Events and projections commit atomically. Any candidate whose per-thread
    // sequence crosses this earlier watermark changed during/after the read.
    const beforeReadSequence = yield* eventSink.latestSequence();
    const threads = yield* projections.getSettlementCandidates(threadId);
    if (threads.length === 0) return;
    const projectShells = yield* projectStore.listShells();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    // A merge event re-sweeps every candidate, not just the threads linked to
    // the merged pull request: most threads carry no link and settle from
    // their branch lookup, which would otherwise wait for the next minute's
    // sweep on a possibly stale cached answer.
    const snapshotSequences = new Map<ThreadId, number>();
    const candidates = (yield* Effect.forEach(
      threads.filter((thread) => isAutoSettlementCandidate(thread, nowMs)),
      (thread) =>
        Effect.gen(function* () {
          const sequence = yield* orchestrator.getThreadEventSequence(thread.id);
          if (sequence > beforeReadSequence) return null;
          snapshotSequences.set(thread.id, sequence);
          return thread;
        }),
      { concurrency: 8 },
    )).filter((thread) => thread !== null);

    const settleThread = Effect.fn("ThreadSettlementServiceV2.settleThread")(
      function* (thread: (typeof candidates)[number], pullRequest: SettlementPullRequest | null) {
        const currentSettings = resolveProjectSettings(
          yield* settingsService.getSettings,
          thread.projectId,
        ).settings;
        const decisionNow = yield* DateTime.now;
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest,
          nowMs: DateTime.toEpochMillis(decisionNow),
          autoSettleAfterDays: currentSettings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: currentSettings.sidebarAutoSettleOnMerge,
        });
        if (settledAt === null) return thread;
        // The candidate query omits queued runs, including held queues older than
        // the optimistic start grace. Read durable runs before declaring completion.
        const { runs } = yield* projections.getThreadRecords(thread.id, ["runs"]);
        if (
          runs.some((run) =>
            ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
          )
        ) {
          return thread;
        }
        // Every representation (including visible multi-PR links) must pass
        // the current branch guard. A prior merge can leave the branch reused
        // for new work that has not appeared in the thread's links yet.
        if (thread.branch !== null) {
          const project = projects.get(thread.projectId);
          if (project === undefined) return thread;
          const worktreeExists =
            thread.worktreePath !== null &&
            (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false)));
          const cwd =
            worktreeExists && thread.worktreePath !== null
              ? thread.worktreePath
              : project.workspaceRoot;
          const current = yield* git.branchPullRequest(
            { cwd, branch: thread.branch },
            { refresh: true },
          );
          if (
            current !== null &&
            current.state !== "merged" &&
            (current.repositoryKey === null ||
              project.repositoryIdentity == null ||
              pullRequestMatchesProject(current, project))
          ) {
            return thread;
          }
          const links = visibleThreadPullRequests(thread.pullRequests ?? []);
          if (
            current !== null &&
            links.length > 0 &&
            (current.repositoryKey === null ||
              project.repositoryIdentity == null ||
              pullRequestMatchesProject(current, project)) &&
            !links.some(
              (link) =>
                link.number === current.number &&
                canonicalRepositoryKey(`${link.host}/${link.repository}`) ===
                  canonicalRepositoryKey(current.repositoryKey ?? ""),
            )
          ) {
            // A newer merged PR without a verified link still has unknown readiness.
            return thread;
          }
        }
        // The provider lookup may have awaited a preference change. The
        // orchestrator repeats this check after taking the dispatch lock.
        if (
          !resolveProjectSettings(yield* settingsService.getSettings, thread.projectId).settings
            .sidebarAutoSettleOnMerge
        )
          return thread;
        const uuid = yield* crypto.randomUUIDv4;
        yield* orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotAt: thread.updatedAt,
          snapshotSequence: snapshotSequences.get(thread.id)!,
          settledAt,
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
    );

    // Linked snapshots already carry provider readiness. Threads without links
    // need a provider lookup; age must never bypass that evidence.
    const lookupCandidates = (yield* Effect.forEach(
      candidates,
      (thread) => settleThread(thread, null),
      { concurrency: 8 },
    ))
      .filter((thread) => thread !== null)
      .filter((thread) => visibleThreadPullRequests(thread.pullRequests ?? []).length === 0);
    // Use the same cwd as the sidebar so both paths share GitManager's PR cache.
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      lookupCandidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.branch === null) return;
          const worktreeExists =
            thread.worktreePath !== null &&
            (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false)));
          lookupCwdByThreadId.set(
            thread.id,
            worktreeExists && thread.worktreePath !== null
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    if (mergedPullRequest !== null) {
      // The merge just confirmed a terminal state the lookup caches can still
      // call open (branch answers live two minutes, the sweep runs every
      // minute). Drop cached branch answers; the provider summary still has to
      // confirm passing checks and review readiness after this merge.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const lookupKey = (thread: (typeof lookupCandidates)[number]) => {
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        return JSON.stringify([
          "linked",
          reference.projectId,
          reference.repository,
          reference.number,
          lookupCwdByThreadId.get(thread.id),
          thread.branch,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(lookupCandidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementServiceV2.pullRequestFor")(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
    ) {
      const thread = group[0]!;
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        if (!projects.has(reference.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        // A merge event is a refresh signal, never fabricated readiness evidence.
        const matchesMerge =
          mergedPullRequest !== null &&
          reference.projectId === mergedPullRequest.projectId &&
          reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
          reference.number === mergedPullRequest.number;
        if (matchesMerge) yield* pullRequests.invalidate({ reference });
        const summary = yield* pullRequests.summary(reference, { recoverTransientFailure: false });
        const terminal: SettlementPullRequest = summary;
        return terminal;
      }
      if (thread.branch === null) return null;
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      const current = yield* git.branchPullRequest({ cwd, branch: thread.branch });
      if (current?.state !== "merged") return current;
      const project = projects.get(thread.projectId);
      if (project === undefined || !pullRequestMatchesProject(current, project)) return null;
      const repository = sourceControlRepositorySelector(project.repositoryIdentity);
      if (repository === null) return null;
      return yield* pullRequests.summary(
        { projectId: thread.projectId, repository, number: current.number },
        { recoverTransientFailure: false },
      );
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group);
          if (pullRequest === undefined) return;
          yield* Effect.forEach(group, (thread) => settleThread(thread, pullRequest), {
            discard: true,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) =>
    // A sweep runs git as child processes and dispatches settlements: it waits while an
    // update is held or its install gate is live, so the helper finds the service idle.
    updateHold.awaitReleased.pipe(
      Effect.andThen(sweep(mergedPullRequest, threadId)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    runSweep(null, threadId),
  );

  // Settling closes the thread's shells that sit at an idle prompt, so they stop
  // holding the worktree. A terminal running a command (a dev server, an
  // editor) stays for the user to close.
  const closeIdleTerminals = Effect.fn("ThreadSettlementServiceV2.closeIdleTerminals")(
    function* (threadId: ThreadId) {
      // A thread re-engaged before this event ran keeps its shells.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      yield* terminals.closeIdle({ threadId });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("closing idle terminals after settlement failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  // An archived thread's idle shells go too; a deleted thread loses all of
  // its shells, so none outlives the thread under the service.
  const closeEndedThreadTerminals = (threadId: ThreadId, deleted: boolean) =>
    deleted
      ? terminals.close({ threadId, deleteHistory: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("closing terminals of a deleted thread failed", {
              threadId,
              error: error.message,
            }),
          ),
        )
      : terminals.closeIdle({ threadId }).pipe(Effect.asVoid);

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.settled":
        return closeIdleTerminals(event.threadId);
      case "thread.archived":
        return closeEndedThreadTerminals(event.threadId, false);
      case "thread.deleted":
        return closeEndedThreadTerminals(event.threadId, true);
      case "thread.pull-request-synced":
      case "provider-session.detached":
        return worker.enqueue(event.threadId);
      case "provider-session.updated":
        return event.payload.status !== "starting" && event.payload.status !== "running"
          ? worker.enqueue(event.threadId)
          : Effect.void;
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? worker.enqueue(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const events = orchestrator.streamDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, (event) => runSweep(event)));
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);
