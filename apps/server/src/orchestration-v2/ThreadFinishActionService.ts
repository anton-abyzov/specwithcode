/**
 * What happens to a thread's branch when its work finishes (#thread-finish).
 *
 * A thread with its own worktree that finishes a turn with nothing queued gets
 * its project's `threadFinishAction`: nothing, a pull request into the
 * repository's default branch (detected from the host, then git), or that pull
 * request merged. A merge goes through the host: when it is ready now it merges,
 * otherwise the host's auto-merge waits for the required checks and branch
 * protection. Nothing is ever force-pushed. Each outcome is a notice on the
 * thread, and the pull request is linked to it.
 *
 * @module ThreadFinishActionService
 */
import { runRanAfter } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadFinishAction,
  type ThreadId,
  type VcsStatusResult,
} from "@specweave-studio/contracts";
import { makeDrainableWorker } from "@specweave-studio/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as HandoffMode from "../handoff/HandoffMode.ts";
import { createdPullRequestKey } from "../git/linkCreatedPullRequest.ts";
import { scrubLogSecrets } from "../pullRequest/gitHubCheckFailureLog.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const UNFINISHED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** One notice per kind and run: a later outcome of the same kind replaces it. */
export type FinishNoticeKind = "opened" | "auto-merge" | "merged" | "blocked";

const NOTICE_ORDINAL: Record<FinishNoticeKind, number> = {
  opened: 90,
  "auto-merge": 91,
  merged: 92,
  blocked: 93,
};

const NOTICE_TITLE: Record<FinishNoticeKind, string> = {
  opened: "Pull request opened",
  "auto-merge": "Auto-merge on",
  merged: "Merged",
  blocked: "Not merged",
};

/** The latest run that actually started: the turn that just finished, when nothing follows it. */
export function latestStartedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  return runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

/** A finished thread: its last turn completed and no other turn is queued or under way. */
export function threadFinished(runs: ReadonlyArray<OrchestrationV2Run>): boolean {
  if (runs.some((run) => UNFINISHED_RUN_STATUSES.has(run.status))) return false;
  return latestStartedRun(runs)?.status === "completed";
}

/**
 * Whether the branch has something to propose: a clean worktree on the thread's
 * own branch, not the default branch, with commits the default branch lacks
 * (or a pull request already open for it).
 */
export function branchReadyForPullRequest(
  status: Pick<
    VcsStatusResult,
    | "isRepo"
    | "hasPrimaryRemote"
    | "isDefaultRef"
    | "refName"
    | "hasWorkingTreeChanges"
    | "aheadOfDefaultCount"
    | "pr"
  >,
  branch: string,
): boolean {
  if (!status.isRepo || !status.hasPrimaryRemote || status.isDefaultRef) return false;
  if (status.refName !== branch || status.hasWorkingTreeChanges) return false;
  if (status.pr?.state === "merged" || status.pr?.state === "closed") return false;
  return status.pr?.state === "open" || (status.aheadOfDefaultCount ?? 1) > 0;
}

export type MergeStep =
  | { readonly type: "done"; readonly notice: FinishNoticeKind; readonly message: string }
  | { readonly type: "merge" }
  | { readonly type: "auto-merge" };

/** What to do with an open pull request the finish action should merge. */
export function mergeStep(
  summary: Pick<
    PullRequestSummary,
    "number" | "state" | "baseBranch" | "checksState" | "mergeability"
  >,
): MergeStep {
  const name = `#${summary.number}`;
  if (summary.state === "merged")
    return { type: "done", notice: "merged", message: `Merged ${name} into ${summary.baseBranch}` };
  if (summary.state !== "open")
    return {
      type: "done",
      notice: "blocked",
      message: `${name} is ${summary.state}; not merging into ${summary.baseBranch}`,
    };
  if (summary.checksState === "failing")
    return {
      type: "done",
      notice: "blocked",
      message: `Checks failed on ${name}; not merging into ${summary.baseBranch}`,
    };
  if (summary.mergeability === "conflicting")
    return {
      type: "done",
      notice: "blocked",
      message: `${name} conflicts with ${summary.baseBranch}; not merging`,
    };
  return summary.checksState !== "pending" && summary.mergeability === "mergeable"
    ? { type: "merge" }
    : { type: "auto-merge" };
}

function errorDetail(error: unknown): string {
  // Redact complete credential shapes before truncation can remove their delimiters.
  const message = scrubLogSecrets(
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error),
  );
  const line = message.split("\n").find((part) => part.trim() !== "") ?? message;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * A blocked notice: a one-line summary the timeline row shows, then the full
 * error and its Git context for the inspector and its copy action, scrubbed of
 * credential shapes.
 */
export function failureNotice(
  summary: string,
  error: unknown,
  context: { readonly branch: string; readonly worktree: string },
): string {
  const fields =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const message = fields.message === undefined ? String(error) : String(fields.message);
  const lines = [
    `${summary}: ${errorDetail(error)}`,
    "",
    `Branch: ${context.branch}`,
    `Worktree: ${context.worktree}`,
  ];
  for (const [label, key] of [
    ["Operation", "operation"],
    ["Command", "command"],
    ["Exit code", "exitCode"],
    ["Reason", "reason"],
  ] as const) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") lines.push(`${label}: ${value}`);
  }
  const full = message.trim();
  if (full !== errorDetail(error)) lines.push("", full);
  return scrubLogSecrets(lines.join("\n"));
}

interface PendingMerge {
  readonly ref: PullRequestRef;
  readonly baseBranch: string;
}

export class ThreadFinishActionService extends Context.Service<
  ThreadFinishActionService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/ThreadFinishActionService") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const updateHold = yield* ServiceUpdateHold.optional;
  const handoff = yield* Effect.serviceOption(HandoffMode.HandoffMode);

  // Merges handed to the host, retried until they land or are refused.
  const pending = new Map<ThreadId, PendingMerge>();

  const projectAction = (projectId: Parameters<typeof resolveProjectSettings>[1]) =>
    settingsService.getSettings.pipe(
      Effect.map((settings) => resolveProjectSettings(settings, projectId).settings),
    );

  const notice = Effect.fn("ThreadFinishActionService.notice")(function* (
    threadId: ThreadId,
    kind: FinishNoticeKind,
    message: string,
  ) {
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const run = latestStartedRun(runs);
    if (run === undefined) return;
    const now = yield* DateTime.now;
    const commandId = CommandId.make(
      `command:thread-finish:${kind}:${run.id}:${DateTime.toEpochMillis(now)}`,
    );
    const event: OrchestrationV2DomainEvent = {
      id: yield* ids.allocate.event({ threadId, commandId }),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      payload: {
        id: ids.derive.runSignalTurnItem({ runId: run.id, signal: `finish-${kind}` }),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: run.ordinal * 100 + NOTICE_ORDINAL[kind],
        status: "completed",
        title: NOTICE_TITLE[kind],
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "system_notice",
        message,
      },
    };
    yield* eventSink.commitCommand({
      commandId,
      threadId,
      commandType: "thread.finish-action.notice",
      acceptedAt: now,
      events: [event],
      effects: [],
    });
  });

  /**
   * Handoff mode: a copy fenced by another machine opens and merges nothing,
   * and a side effect this turn (or the turn it continues) already did is
   * reused, not repeated. Without handoff mode every action proceeds.
   */
  const sideEffect = (input: HandoffMode.SideEffectInput) =>
    Option.match(handoff, {
      onNone: () => Effect.succeed({ kind: "proceed" as const }),
      onSome: (service) => service.guardSideEffect(input),
    });

  const journal = (input: HandoffMode.SideEffectInput, result: string | null) =>
    Option.match(handoff, {
      onNone: () => Effect.void,
      onSome: (service) => service.recordSideEffect({ ...input, result }),
    });

  const latestRunId = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.map(({ runs }) => latestStartedRun(runs)?.id ?? null));

  const merge = Effect.fn("ThreadFinishActionService.merge")(function* (
    threadId: ThreadId,
    target: PendingMerge,
  ) {
    const settings = yield* projectAction(target.ref.projectId);
    if (settings.threadFinishAction !== "auto_merge") {
      pending.delete(threadId);
      return;
    }
    yield* pullRequests.invalidate({ reference: target.ref });
    const summary = yield* pullRequests.summary(target.ref, { recoverTransientFailure: false });
    const step = mergeStep(summary);
    const name = `#${summary.number}`;
    const mergeMethod =
      settings.pullRequestMergeMethod === null
        ? {}
        : { mergeMethod: settings.pullRequestMergeMethod };
    if (step.type === "done") {
      pending.delete(threadId);
      yield* notice(threadId, step.notice, step.message);
      return;
    }
    const runId = yield* latestRunId(threadId);
    const effect = (suffix: string): HandoffMode.SideEffectInput | null =>
      runId === null
        ? null
        : {
            threadId,
            runId,
            kind: "pr-merge",
            target: `${target.ref.repository}#${summary.number}${suffix}`,
          };
    const mergeEffect = effect("");
    if (mergeEffect !== null) {
      const verdict = yield* sideEffect(mergeEffect);
      if (verdict.kind !== "proceed") {
        pending.delete(threadId);
        if (verdict.kind === "refuse")
          yield* notice(threadId, "blocked", `Did not merge ${name}: ${verdict.message}`);
        return;
      }
    }
    if (step.type === "merge") {
      const merged = yield* pullRequests
        .runAction({ ...target.ref, action: "merge", ...mergeMethod })
        .pipe(Effect.result);
      if (merged._tag === "Success") {
        pending.delete(threadId);
        if (mergeEffect !== null) yield* journal(mergeEffect, "merged");
        yield* notice(threadId, "merged", `Merged ${name} into ${summary.baseBranch}`);
        return;
      }
      // Branch protection can still ask for a review or a check the summary does not show.
      yield* Effect.logInfo("thread finish merge refused; handing it to auto-merge", {
        threadId,
        detail: errorDetail(merged.failure),
      });
    }
    if (pending.has(threadId)) return;
    const armed = yield* pullRequests
      .runAction({ ...target.ref, action: "enable-auto-merge", ...mergeMethod })
      .pipe(Effect.result);
    pending.set(threadId, target);
    const autoMergeEffect = effect("/auto-merge");
    if (armed._tag === "Success" && autoMergeEffect !== null)
      yield* journal(autoMergeEffect, "auto-merge");
    yield* notice(
      threadId,
      "auto-merge",
      armed._tag === "Success"
        ? `Auto-merge on for ${name}; it merges into ${summary.baseBranch} when checks pass`
        : `Waiting for checks on ${name} before merging into ${summary.baseBranch}`,
    );
  });

  const finish = Effect.fn("ThreadFinishActionService.finish")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThread(threadId);
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    // A native subagent works in its parent's checkout; the parent's finish covers it.
    if (thread.forkedFrom?.type === "node") return;
    if (thread.branch === null || thread.worktreePath === null) return;
    const action: ThreadFinishAction = (yield* projectAction(thread.projectId)).threadFinishAction;
    if (action === "leave") return;
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (!threadFinished(runs)) return;
    const cwd = thread.worktreePath;
    if (!(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) return;
    yield* git.invalidateStatus(cwd);
    const status = yield* git.status({ cwd });
    if (!branchReadyForPullRequest(status, thread.branch)) return;
    const project = Option.getOrUndefined(yield* projectStore.getShell(thread.projectId));
    const runId = latestStartedRun(runs)?.id ?? null;
    const createEffect: HandoffMode.SideEffectInput | null =
      runId === null
        ? null
        : { threadId, runId, kind: "pr-create", target: `branch:${thread.branch}` };
    if (createEffect !== null) {
      const verdict = yield* sideEffect(createEffect);
      if (verdict.kind === "refuse") {
        yield* notice(threadId, "blocked", `Did not open a pull request: ${verdict.message}`);
        return;
      }
    }
    const uuid = yield* crypto.randomUUIDv4;
    const result = yield* git
      .runStackedAction({
        actionId: `thread-finish:${uuid}`,
        cwd,
        action: "create_pr",
        threadId,
        projectId: thread.projectId,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* notice(
        threadId,
        "blocked",
        failureNotice("Could not open a pull request", result.failure, {
          branch: thread.branch,
          worktree: cwd,
        }),
      );
      return;
    }
    const key = createdPullRequestKey(result.success, project);
    if (key === null) return;
    if (createEffect !== null)
      yield* journal(createEffect, `${key.host}/${key.repository}#${key.number}`);
    yield* orchestrator
      .dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`server:thread-finish:link:${threadId}:${uuid}`),
        threadId,
        ...key,
        source: "created",
      })
      .pipe(Effect.ignore);
    const baseBranch = result.success.pr.baseBranch ?? "the default branch";
    if (result.success.pr.status === "created")
      yield* notice(threadId, "opened", `Opened #${key.number} into ${baseBranch}`);
    if (action !== "auto_merge") return;
    yield* merge(threadId, {
      ref: {
        projectId: thread.projectId,
        host: key.host,
        repository: key.repository,
        number: key.number,
      },
      baseBranch,
    });
  });

  const guarded = <E>(label: string, threadId: ThreadId, effect: Effect.Effect<void, E>) =>
    // Git and host calls wait while an update is held, so its helper finds the service idle.
    updateHold.awaitReleased.pipe(
      Effect.andThen(effect),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning(label, { threadId, cause: Cause.pretty(cause) }),
      ),
    );

  const worker = yield* makeDrainableWorker((item: { threadId: ThreadId; retry: boolean }) => {
    if (!item.retry)
      return guarded("thread finish action failed", item.threadId, finish(item.threadId));
    const target = pending.get(item.threadId);
    return target === undefined
      ? Effect.void
      : guarded("thread finish merge retry failed", item.threadId, merge(item.threadId, target));
  });

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type === "run.updated" && event.payload.status === "completed")
      return worker.enqueue({ threadId: event.threadId, retry: false });
    if (event.type === "thread.pull-request-synced" && pending.has(event.threadId))
      return worker.enqueue({ threadId: event.threadId, retry: true });
    return Effect.void;
  };

  const start: ThreadFinishActionService["Service"]["start"] = Effect.fn(
    "ThreadFinishActionService.start",
  )(function* () {
    const merges = yield* pullRequests.subscribeMerges;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread finish action event stream failed", { cause }),
        ),
      ),
    );
    // The host merges on its own schedule; a merge event or the next check closes the loop.
    yield* forkParked(
      Stream.runForEach(merges, (merged) =>
        Effect.forEach(
          [...pending].filter(
            ([, target]) =>
              target.ref.projectId === merged.projectId &&
              target.ref.number === merged.number &&
              target.ref.repository.toLowerCase() === merged.repository.toLowerCase(),
          ),
          ([threadId]) => worker.enqueue({ threadId, retry: true }),
          { discard: true },
        ),
      ),
    );
    yield* forkParked(
      Effect.forEach([...pending.keys()], (threadId) => worker.enqueue({ threadId, retry: true }), {
        discard: true,
      }).pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadFinishActionService["Service"];
});

export const layer = Layer.effect(ThreadFinishActionService, make);
