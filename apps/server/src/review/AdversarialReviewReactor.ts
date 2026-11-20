/**
 * Automatic adversarial review when a feature completes: a thread's run
 * completes and the increment the thread is linked to has every task done or
 * skipped. The thread's own choice (`reviewMode`) decides first, the way the
 * advisor's does; a thread that follows the project reviews only when the
 * project's `adversarialReview.autoOnFeatureComplete` is on. One review per
 * increment: the launch's command id is derived from the project and
 * increment, so a repeat resumes the first review thread
 * (ThreadLaunchService's receipt) instead of starting another.
 *
 * Review threads never trigger a review: they launch with no increment link,
 * and since their branch or title can still bind them to the increment, they
 * are also skipped by their title (`isAdversarialReviewThread`).
 */
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ProjectId,
  type ThreadIncrementProgress,
  type ThreadId,
} from "@specweave-studio/contracts";
import { threadReviewState } from "@specweave-studio/shared/adversarialReview";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  completedRunCandidate,
  runStartedByPerson,
  threadTakesPromptSuggestions,
} from "../orchestration-v2/PromptSuggestionReactor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as AdversarialReviewService from "./AdversarialReviewService.ts";

const MAX_STARTED_INCREMENTS = 2_000;
/**
 * Increment progress reads are cached for 5s, so the read right after a run
 * can predate the run's last `task done`. A thread whose increment is not
 * finished yet is read once more after this.
 */
const RECHECK_AFTER = Duration.seconds(6);

/**
 * Whether a binding is strong enough to review the increment on: the thread
 * claimed its tasks, was linked by hand, works on its branch or is named by a
 * checkpoint. A number in the title (`name`) is not: a thread that only
 * mentions an increment never starts a review of it.
 */
export function bindingTakesAutoReview(binding: ThreadIncrementProgress["binding"]): boolean {
  return binding !== "name";
}

/**
 * Whether an increment's work is finished for review: readable, with tasks,
 * and every task done or skipped.
 */
export function featureCompleteForReview(
  progress: Pick<ThreadIncrementProgress, "readable" | "tasks"> | null | undefined,
): boolean {
  return (
    progress !== null &&
    progress !== undefined &&
    progress.readable &&
    progress.tasks.length > 0 &&
    progress.tasks.every((task) => task.status === "done" || task.status === "skipped")
  );
}

/** Whether a finished thread may get an automatic review: a person's thread, not a review. */
export function threadTakesAutoReview(
  thread: Pick<
    OrchestrationV2AppThread,
    "title" | "lineage" | "origin" | "archivedAt" | "deletedAt"
  >,
): boolean {
  return (
    threadTakesPromptSuggestions(thread) &&
    !AdversarialReviewService.isAdversarialReviewThread(thread)
  );
}

/**
 * Whether this finished run may start a review before the project setting is
 * read. A thread's own "On" holds wherever the thread is still open and is
 * neither a review nor an advisor child, like the advisor's On on any thread:
 * also a delegated thread and a run a person did not type. "Off" never
 * reviews. A thread that follows the project keeps the person-only rules.
 */
export function runMayTakeAutoReview(
  thread: Pick<
    OrchestrationV2AppThread,
    "title" | "lineage" | "origin" | "archivedAt" | "deletedAt" | "reviewMode" | "purpose"
  >,
  userMessage:
    | Pick<OrchestrationV2ConversationMessage, "scheduledTaskId" | "senderThreadId">
    | undefined,
): boolean {
  if (thread.reviewMode === "off") return false;
  if (thread.reviewMode === "on")
    return (
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.purpose !== "advisor" &&
      !AdversarialReviewService.isAdversarialReviewThread(thread)
    );
  return (
    threadTakesAutoReview(thread) && (userMessage === undefined || runStartedByPerson(userMessage))
  );
}

/** One review per increment, whichever of its threads finishes it. */
export function autoReviewCommandId(projectId: ProjectId, incrementId: string): CommandId {
  return CommandId.make(`adversarial-review:${projectId}:${incrementId}`);
}

export const start = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const increments = yield* ThreadIncrementProgressService.ThreadIncrementProgressService;
  const reviews = yield* AdversarialReviewService.AdversarialReviewService;
  // The launch receipt already dedupes; this also skips re-reading the
  // reviewer chain for every later run of a finished increment's threads.
  const started = new Set<string>();

  const startReview = Effect.fn("AdversarialReviewReactor.startReview")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
    progress: ThreadIncrementProgress,
  ) {
    const commandId = autoReviewCommandId(projectId, progress.incrementId);
    if (started.has(commandId)) return;
    started.add(commandId);
    if (started.size > MAX_STARTED_INCREMENTS) started.delete(started.values().next().value!);
    const result = yield* reviews
      .start({ threadId, commandId, trigger: "feature-complete" })
      .pipe(Effect.tapError(() => Effect.sync(() => started.delete(commandId))));
    if (result.status === "no-reviewer") {
      // Nothing could review yet: a later run of the increment tries again.
      started.delete(commandId);
      yield* Effect.logInfo("review.adversarial.auto-skipped", {
        threadId,
        incrementId: progress.incrementId,
        skipped: result.skipped.map((skip) => `${skip.selection.instanceId}:${skip.reason}`),
      });
    }
  });

  /**
   * The thread and its project when this run may start a review, from fresh
   * reads of the thread, its project and the settings. The recheck asks again:
   * the thread may have been set to Off or archived in the meantime.
   */
  const admit = Effect.fn("AdversarialReviewReactor.admit")(function* (
    threadId: ThreadId,
    userMessageId: OrchestrationV2Run["userMessageId"],
  ) {
    const records = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [userMessageId],
    });
    const thread = records.thread;
    const userMessage = records.messages.find((message) => message.id === userMessageId);
    if (!runMayTakeAutoReview(thread, userMessage)) return undefined;
    const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
    if (project === undefined) return undefined;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      project.id,
      project,
    ).settings;
    if (!threadReviewState(thread.reviewMode, settings.adversarialReview).enabled) return undefined;
    return { thread, project };
  });

  const review = Effect.fn("AdversarialReviewReactor.review")(function* (
    threadId: ThreadId,
    userMessageId: OrchestrationV2Run["userMessageId"],
  ) {
    const admitted = yield* admit(threadId, userMessageId);
    if (admitted === undefined) return;
    const { thread, project } = admitted;
    // Suspended, so the recheck below reads again instead of reusing the first answer.
    const progressOf = Effect.suspend(() =>
      increments.read({ projectId: project.id, threadIds: [thread.id] }),
    ).pipe(
      Effect.map((snapshot) => snapshot.threads.find((entry) => entry.threadId === thread.id)),
    );
    const progress = yield* progressOf;
    if (progress === undefined || !bindingTakesAutoReview(progress.binding)) return;
    if (featureCompleteForReview(progress))
      return yield* startReview(thread.id, project.id, progress);
    // Possibly a cached read from before the run's last task: look once more, without
    // holding up the events behind this one.
    yield* progressOf.pipe(
      Effect.delay(RECHECK_AFTER),
      Effect.flatMap((later) =>
        later !== undefined &&
        bindingTakesAutoReview(later.binding) &&
        featureCompleteForReview(later)
          ? admit(threadId, userMessageId).pipe(
              // A thread moved to another project meanwhile is left to its next run there.
              Effect.flatMap((still) =>
                still === undefined || still.project.id !== project.id
                  ? Effect.void
                  : startReview(thread.id, project.id, later),
              ),
            )
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("Automatic adversarial review recheck failed", { threadId, cause }),
      ),
      Effect.forkChild,
    );
  });

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      const candidate = completedRunCandidate(event);
      if (candidate === null) return Effect.void;
      return review(candidate.threadId, candidate.run.userMessageId).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Automatic adversarial review failed", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Adversarial review event stream failed", { cause }),
      ),
    ),
  );
});
