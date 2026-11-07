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
import { visibleThreadPullRequests } from "@specweave-studio/shared/threadPullRequests";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadFinishAction,
  type ThreadId,
  type ThreadPullRequestLink,
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
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as HandoffMode from "../handoff/HandoffMode.ts";
import { createdPullRequestKey } from "../git/linkCreatedPullRequest.ts";
import { openWorktreeSetPullRequests } from "../git/worktreeSetPullRequests.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import { readWorktreeSet, worktreeSetMemberPath, type WorktreeSetMember } from "../worktreeSet.ts";
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

/**
 * Whether the thread's own links say `branch` already landed: a merged or
 * closed pull request for it, in any repository (a moved repository keeps its
 * old links), and none still open. Links the user removed do not count.
 */
export function branchLanded(links: ReadonlyArray<ThreadPullRequestLink>, branch: string): boolean {
  const onBranch = visibleThreadPullRequests(links).filter(
    (link) => link.snapshot === null || link.snapshot.headBranch === branch,
  );
  return (
    onBranch.length > 0 &&
    onBranch.every((link) => link.snapshot !== null && link.snapshot.state !== "open")
  );
}

/** A failure with an unchanged checkout is retried this often, for host outages and expired sign-ins. */
export const FAILURE_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * The checkout state a finish step saw. A failure is not retried after every
 * turn: only once it changes (another branch, a push, a new commit) or after
 * FAILURE_RETRY_AFTER_MS, and the same failure is reported once.
 */
export function checkoutSignature(
  cwd: string,
  status: Pick<VcsStatusResult, "refName" | "hasUpstream" | "aheadCount" | "aheadOfDefaultCount">,
): string {
  return [
    cwd,
    status.refName ?? "",
    String(status.hasUpstream),
    String(status.aheadCount),
    String(status.aheadOfDefaultCount ?? ""),
  ].join("\0");
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

const UNRELATED_HISTORY = /^Branch (\S+) shares no commits with (\S+?),/;

/** The error's own words: a Git manager error without its `failed in <operation>` prefix. */
function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const fields = error as { _tag?: unknown; detail?: unknown; message?: unknown };
  if (fields._tag === "GitManagerError" && typeof fields.detail === "string") {
    const unrelated = UNRELATED_HISTORY.exec(fields.detail);
    return unrelated
      ? `${unrelated[1]} has no history in common with ${unrelated[2]}. Rebase it onto ${unrelated[2]}, or link this thread's pull request.`
      : fields.detail;
  }
  return "message" in fields ? String(fields.message) : String(error);
}

function errorDetail(error: unknown): string {
  // Redact complete credential shapes before truncation can remove their delimiters.
  const message = scrubLogSecrets(errorText(error));
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
  const setPath = yield* Effect.serviceOption(Path.Path);
  const increments = yield* Effect.serviceOption(
    ThreadIncrementProgressService.ThreadIncrementProgressService,
  );

  // Merges handed to the host, retried until they land or are refused.
  const pending = new Map<ThreadId, PendingMerge>();
  // The last failure reported per thread, with the checkout state it saw.
  const reported = new Map<
    ThreadId,
    { readonly checkout: string; readonly detail: string; readonly at: number }
  >();

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

  /**
   * A worktree set gets one pull request per repository with commits, each
   * linked to the thread. Every description lists the others, the branch and
   * the increment; where the host can edit descriptions the earlier ones are
   * rewritten once all exist. Each merges on its own checks: auto-merge is
   * not armed for a set.
   */
  const finishSet = Effect.fn("ThreadFinishActionService.finishSet")(function* (input: {
    readonly thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly branch: string;
    };
    readonly folder: string;
    readonly members: ReadonlyArray<WorktreeSetMember>;
    readonly path: Path.Path;
    readonly runId: Parameters<typeof journal>[0]["runId"] | null;
  }) {
    const { thread, path } = input;
    const ready: Array<{ readonly label: string; readonly cwd: string }> = [];
    for (const member of input.members) {
      const cwd = worktreeSetMemberPath(input.folder, member, path);
      if (
        !(yield* fileSystem.exists(path.join(cwd, ".git")).pipe(Effect.orElseSucceed(() => false)))
      )
        continue;
      yield* git.invalidateStatus(cwd);
      const status = yield* git.status({ cwd }).pipe(Effect.option);
      if (Option.isNone(status) || !branchReadyForPullRequest(status.value, thread.branch))
        continue;
      ready.push({
        label: member.id ?? (member.relativePath || path.basename(member.repository)),
        cwd,
      });
    }
    if (ready.length === 0) return;
    const incrementId = Option.isNone(increments)
      ? null
      : yield* increments.value.read({ projectId: thread.projectId, threadIds: [thread.id] }).pipe(
          Effect.map(
            (snapshot) =>
              snapshot.threads.find((entry) => entry.threadId === thread.id)?.incrementId ?? null,
          ),
          Effect.orElseSucceed(() => null),
        );
    const { opened, problems } = yield* openWorktreeSetPullRequests({
      branch: thread.branch,
      incrementId,
      ready,
      open: (entry, note) =>
        Effect.gen(function* (): Effect.fn.Return<
          { readonly number: number; readonly url: string; readonly created: boolean } | null,
          string
        > {
          const createEffect: HandoffMode.SideEffectInput | null =
            input.runId === null
              ? null
              : {
                  threadId: thread.id,
                  runId: input.runId,
                  kind: "pr-create",
                  target: `branch:${thread.branch}:${entry.label}`,
                };
          if (createEffect !== null) {
            const verdict = yield* sideEffect(createEffect);
            if (verdict.kind === "refuse")
              return yield* Effect.fail(`${entry.label}: ${verdict.message}`);
          }
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const result = yield* git
            .runStackedAction(
              {
                actionId: `thread-finish:${uuid}`,
                cwd: entry.cwd,
                action: "create_pr",
                threadId: thread.id,
                projectId: thread.projectId,
              },
              note === undefined ? undefined : { pullRequestNote: note },
            )
            .pipe(
              Effect.mapError((error) =>
                failureNotice(entry.label, error, { branch: thread.branch, worktree: entry.cwd }),
              ),
            );
          // Only the URL names the repository: the project's identity is another one's.
          const key = createdPullRequestKey(result, undefined);
          if (key === null) return null;
          if (createEffect !== null)
            yield* journal(createEffect, `${key.host}/${key.repository}#${key.number}`);
          yield* orchestrator
            .dispatch({
              type: "thread.pull-request.link",
              commandId: CommandId.make(`server:thread-finish:link:${thread.id}:${uuid}`),
              threadId: thread.id,
              ...key,
              source: "created",
            })
            .pipe(Effect.ignore);
          return { number: key.number, url: key.url, created: result.pr.status === "created" };
        }),
      edit: (pr, rewrite) =>
        git.editPullRequestBody({ cwd: pr.cwd, number: pr.number, edit: rewrite }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => errorDetail(error)),
        ),
    });
    if (opened.some((pr) => pr.created))
      yield* notice(
        thread.id,
        "opened",
        `Opened ${opened.map((pr) => `${pr.label} #${pr.number}`).join(", ")}; each merges on its own checks`,
      );
    if (problems.length > 0)
      yield* notice(
        thread.id,
        "blocked",
        `Could not open every pull request: ${problems.join("; ")}`,
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
    if (Option.isSome(setPath)) {
      const set = yield* readWorktreeSet(cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, setPath.value),
      );
      if (set !== null)
        return yield* finishSet({
          thread: { id: threadId, projectId: thread.projectId, branch: thread.branch },
          folder: cwd,
          members: set.members,
          path: setPath.value,
          runId: latestStartedRun(runs)?.id ?? null,
        });
    }
    yield* git.invalidateStatus(cwd);
    const status = yield* git.status({ cwd });
    const branch = thread.branch;
    // A binding left on a branch whose pull request already landed, here or before a repository move.
    if (branchLanded(thread.pullRequests ?? [], branch)) return;
    if (!branchReadyForPullRequest(status, branch)) return;
    const checkout = checkoutSignature(cwd, status);
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const previous = reported.get(threadId);
    if (
      previous !== undefined &&
      previous.checkout === checkout &&
      startedAt - previous.at < FAILURE_RETRY_AFTER_MS
    )
      return;
    const project = Option.getOrUndefined(yield* projectStore.getShell(thread.projectId));
    const runId = latestStartedRun(runs)?.id ?? null;
    const createEffect: HandoffMode.SideEffectInput | null =
      runId === null ? null : { threadId, runId, kind: "pr-create", target: `branch:${branch}` };
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
      const detail = errorDetail(result.failure);
      reported.set(threadId, { checkout, detail, at: startedAt });
      if (previous?.checkout === checkout && previous.detail === detail) return;
      yield* notice(
        threadId,
        "blocked",
        failureNotice("Could not open a pull request", result.failure, {
          branch,
          worktree: cwd,
        }),
      );
      return;
    }
    reported.delete(threadId);
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
