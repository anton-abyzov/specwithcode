/**
 * Cross-model adversarial review: starts a thread on a different model family
 * than the one that did a thread's work, on the same checkout, with the
 * reviewer prompt. The reviewer comes from the project's reviewer order,
 * walked by the fallback system (`@specweave-studio/shared/adversarialReview`).
 * Started by hand (RPC) or by AdversarialReviewReactor when a feature completes.
 *
 * @module AdversarialReviewService
 */
import {
  type AdversarialReviewSkip,
  type CommandId,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderModelTier,
  type ServerProvider,
  type StartAdversarialReviewResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveReviewer, selectionFamily } from "@specweave-studio/shared/adversarialReview";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { simulatedUsageLimitInstances } from "../orchestration-v2/ProviderFailure.ts";
import { ProviderFallbackEnv } from "../orchestration-v2/ProviderFallbackWorker.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { usageLimitHeldInstances } from "../orchestration-v2/UnopenableHolds.ts";
import { projectCompatibleProviders } from "../project/ProjectProviderCompatibility.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { adversarialReviewPrompt } from "./adversarialReviewPrompt.ts";

/**
 * Every review thread's title starts with this. It is how a review thread is
 * told apart later (the thread record has no kind): the reactor never reviews
 * a review, even when the review's branch or title binds it to an increment.
 */
export const ADVERSARIAL_REVIEW_TITLE_PREFIX = "Adversarial review:";
const MAX_SOURCE_TITLE_CHARS = 80;

/** Whether a thread is an adversarial review thread, by its title. */
export function isAdversarialReviewThread(thread: Pick<OrchestrationV2AppThread, "title">) {
  return thread.title.startsWith(ADVERSARIAL_REVIEW_TITLE_PREFIX);
}

export function adversarialReviewTitle(sourceTitle: string): string {
  const title = sourceTitle.trim();
  const short =
    title.length <= MAX_SOURCE_TITLE_CHARS
      ? title
      : `${title.slice(0, MAX_SOURCE_TITLE_CHARS - 1).trimEnd()}…`;
  return `${ADVERSARIAL_REVIEW_TITLE_PREFIX} ${short}`;
}

/** The model that did the work, as a person reads it: "Claude · Opus 5.5". */
export function authorLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  return `${provider?.displayName ?? selection.instanceId} · ${model?.name ?? selection.model}`;
}

export class AdversarialReviewStartError extends Schema.TaggedError<AdversarialReviewStartError>()(
  "AdversarialReviewStartError",
  {
    operation: Schema.Literals(["read-thread", "read-project", "launch"]),
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "read-thread":
        return "Could not read the thread to review.";
      case "read-project":
        return "Could not read the project of the thread to review.";
      case "launch":
        return "Could not start the review thread.";
    }
  }
}

export interface AdversarialReviewStartInput {
  readonly threadId: ThreadId;
  /** A reviewer a person picked; refused when it is the author's model family. */
  readonly reviewer?: ModelSelection | undefined;
  /** Overrides the project's review depth. */
  readonly tier?: ProviderModelTier | undefined;
  /** The launch's idempotency key: the same id starts at most one review thread. */
  readonly commandId: CommandId;
  readonly trigger: "manual" | "feature-complete";
}

export class AdversarialReviewService extends Context.Service<
  AdversarialReviewService,
  {
    readonly start: (
      input: AdversarialReviewStartInput,
    ) => Effect.Effect<StartAdversarialReviewResult, AdversarialReviewStartError>;
  }
>()("specweave-studio/review/AdversarialReviewService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const increments = yield* ThreadIncrementProgressService.ThreadIncrementProgressService;
  const projects = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  /** Instances that should not take new work now, read the way WorkerLaunchRoom reads them. */
  const limitedInstances = Effect.fn("AdversarialReviewService.limitedInstances")(function* (
    nowMs: number,
  ) {
    const limited = new Set<string>(simulatedUsageLimitInstances(yield* ProviderFallbackEnv));
    for (const instanceId of yield* usageLimitHeldInstances(nowMs)) limited.add(instanceId);
    return limited;
  });

  /** The source thread's increment, best effort: a review runs without one. */
  const sourceIncrement = (thread: OrchestrationV2AppThread) =>
    increments.read({ projectId: thread.projectId, threadIds: [thread.id] }).pipe(
      Effect.map(
        (snapshot) => snapshot.threads.find((entry) => entry.threadId === thread.id) ?? null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const start = Effect.fn("AdversarialReviewService.start")(function* (
    input: AdversarialReviewStartInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "adversarial_review.thread_id": input.threadId });
    const fail = (operation: AdversarialReviewStartError["operation"]) => (cause?: unknown) =>
      new AdversarialReviewStartError({
        operation,
        threadId: input.threadId,
        ...(cause === undefined ? {} : { cause }),
      });
    const source = (yield* threads
      .getThreadRecords(input.threadId, [])
      .pipe(Effect.mapError(fail("read-thread")))).thread;
    const project = yield* projects.getById(source.projectId).pipe(
      Effect.mapError(fail("read-project")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("read-project")()),
          onSome: Effect.succeed,
        }),
      ),
    );
    const preferences = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    );
    const settings = resolveProjectSettings(preferences, project.id, project).settings;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const allProviders = yield* providerRegistry.getProviders;
    const providers = projectCompatibleProviders({
      project,
      providers: allProviders,
      cwd: source.worktreePath ?? project.workspaceRoot,
      runtimePolicy: { runtimeMode: source.runtimeMode, interactionMode: source.interactionMode },
    });
    const author = source.modelSelection;
    const authorFamily = selectionFamily(allProviders, author);
    // A picked reviewer of the author's family is refused outright, so the
    // chain never quietly moves the review to some other model.
    if (
      input.reviewer !== undefined &&
      authorFamily !== "other" &&
      selectionFamily(allProviders, input.reviewer) === authorFamily
    ) {
      const skipped: ReadonlyArray<AdversarialReviewSkip> = [
        { selection: input.reviewer, reason: "same-family" },
      ];
      return { status: "no-reviewer", skipped } satisfies StartAdversarialReviewResult;
    }
    const resolution = resolveReviewer({
      providers,
      author,
      reviewers:
        input.reviewer === undefined ? settings.adversarialReview.reviewers : [input.reviewer],
      tier: input.tier ?? settings.adversarialReview.tier,
      tiers: settings.modelTiers,
      excludedModels: settings.providerLimitExcludedModels,
      nowMs,
      limitedInstanceIds: yield* limitedInstances(nowMs),
    });
    const skipped: ReadonlyArray<AdversarialReviewSkip> = resolution.skipped;
    if (resolution.reviewer === null) {
      yield* Effect.logInfo("review.adversarial.no-reviewer", {
        threadId: source.id,
        trigger: input.trigger,
        skipped: skipped.length,
      });
      return { status: "no-reviewer", skipped } satisfies StartAdversarialReviewResult;
    }
    const reviewer = resolution.reviewer;
    const increment = yield* sourceIncrement(source);
    const pullRequestUrl = source.linkedPullRequest?.url ?? source.branchPullRequest?.url ?? null;
    const launched = yield* launches
      .launch({
        commandId: input.commandId,
        projectId: source.projectId,
        title: adversarialReviewTitle(source.title),
        modelSelection: reviewer,
        launchFallbackFrom: null,
        runtimeMode: source.runtimeMode,
        interactionMode: "default",
        // The same checkout as the work; the prompt keeps the reviewer read-only.
        // A project root is never switched to the work's branch (other threads
        // may share it): the prompt names the branch and diffs it from there.
        workspaceStrategy:
          source.worktreePath === null
            ? { type: "root" }
            : {
                type: "existing_worktree",
                worktreePath: source.worktreePath,
                ...(source.branch === null ? {} : { branch: source.branch }),
              },
        initialMessage: {
          text: adversarialReviewPrompt({
            sourceTitle: source.title,
            authorLabel: authorLabel(allProviders, author),
            authorFamily: resolution.authorFamily,
            branch: source.branch,
            incrementId: increment?.incrementId ?? null,
            specPath: increment?.specPath ?? null,
            pullRequestUrl,
            trigger: input.trigger,
          }),
          attachments: [],
        },
        // No increment link: a review thread must never count as the feature's work.
        createdBy: input.trigger === "manual" ? "user" : "system",
        creationSource: input.trigger === "manual" ? "web" : "server",
      })
      .pipe(Effect.mapError(fail("launch")));
    yield* Effect.logInfo("review.adversarial.started", {
      threadId: source.id,
      reviewThreadId: launched.threadId,
      trigger: input.trigger,
      reviewer: reviewer.instanceId,
      model: reviewer.model,
    });
    return {
      status: "started",
      threadId: launched.threadId,
      reviewer,
      skipped,
    } satisfies StartAdversarialReviewResult;
  });

  return AdversarialReviewService.of({ start });
});

export const layer = Layer.effect(AdversarialReviewService, make);
