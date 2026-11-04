import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
  type ThreadIncrementProgress,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AdversarialReviewReactor from "./AdversarialReviewReactor.ts";
import * as AdversarialReviewService from "./AdversarialReviewService.ts";

const projectId = ProjectId.make("project-review");
const task = (status: ThreadIncrementProgress["tasks"][number]["status"]) =>
  ({ id: `T-${status}`, title: status, status, criteria: [], note: null }) as never;

const personThread = {
  title: "Sign in with passkeys",
  lineage: { relationshipToParent: null },
  origin: undefined,
  archivedAt: null,
  deletedAt: null,
} as const;

describe("featureCompleteForReview", () => {
  it("needs every task done or skipped", () => {
    expect(
      AdversarialReviewReactor.featureCompleteForReview({
        readable: true,
        tasks: [task("done"), task("skipped")],
      }),
    ).toBe(true);
    expect(
      AdversarialReviewReactor.featureCompleteForReview({
        readable: true,
        tasks: [task("done"), task("claimed")],
      }),
    ).toBe(false);
    expect(
      AdversarialReviewReactor.featureCompleteForReview({
        readable: true,
        tasks: [task("done"), task("blocked")],
      }),
    ).toBe(false);
  });

  it("never fires without a readable increment with tasks", () => {
    expect(AdversarialReviewReactor.featureCompleteForReview(null)).toBe(false);
    expect(AdversarialReviewReactor.featureCompleteForReview(undefined)).toBe(false);
    expect(AdversarialReviewReactor.featureCompleteForReview({ readable: true, tasks: [] })).toBe(
      false,
    );
    expect(
      AdversarialReviewReactor.featureCompleteForReview({ readable: false, tasks: [task("done")] }),
    ).toBe(false);
  });
});

describe("threadTakesAutoReview", () => {
  it("skips review threads, subagents, outside clients and archived threads", () => {
    expect(AdversarialReviewReactor.threadTakesAutoReview(personThread as never)).toBe(true);
    expect(
      AdversarialReviewReactor.threadTakesAutoReview({
        ...personThread,
        title: AdversarialReviewService.adversarialReviewTitle(personThread.title),
      } as never),
    ).toBe(false);
    expect(
      AdversarialReviewReactor.threadTakesAutoReview({
        ...personThread,
        lineage: { relationshipToParent: "subagent" },
      } as never),
    ).toBe(false);
    expect(
      AdversarialReviewReactor.threadTakesAutoReview({
        ...personThread,
        archivedAt: "2026-11-04T08:00:00.000Z",
      } as never),
    ).toBe(false);
  });

  it("keys one review per increment", () => {
    expect(AdversarialReviewReactor.autoReviewCommandId(projectId, "0042-passkeys")).toBe(
      "adversarial-review:project-review:0042-passkeys",
    );
  });
});

const sourceId = ThreadId.make("thread:source");
const reviewThreadId = ThreadId.make("thread:review");
const completed = (threadId: ThreadId, runId: string) =>
  ({
    type: "run.updated",
    payload: {
      id: runId,
      threadId,
      status: "completed",
      userMessageId: MessageId.make(`message-${runId}`),
    },
  }) as never;

const runReactor = (input: {
  readonly auto: boolean;
  readonly tasks: ReadonlyArray<never>;
  /** Tasks from the second read on, as a cached first read would lag them. */
  readonly laterTasks?: ReadonlyArray<never>;
  readonly binding?: ThreadIncrementProgress["binding"];
  readonly events: ReadonlyArray<never>;
  /** Time to let pass after the events, for the recheck. */
  readonly wait?: string;
}) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const starts: Array<AdversarialReviewService.AdversarialReviewStartInput> = [];
    let reads = 0;
    const settings: ServerSettingsValue = {
      ...DEFAULT_SERVER_SETTINGS,
      adversarialReview: {
        ...DEFAULT_SERVER_SETTINGS.adversarialReview,
        autoOnFeatureComplete: input.auto,
      },
    };
    const services = Layer.mergeAll(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        streamDomainEvents: Stream.concat(
          Stream.fromIterable(input.events),
          Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(
            Stream.drain,
            // The domain event stream never ends; ending it would stop the reactor's fibers.
            Stream.concat(Stream.never),
          ),
        ),
        getThreadRecords: (threadId: ThreadId) =>
          Effect.succeed({
            thread: {
              ...personThread,
              id: threadId,
              projectId,
              title:
                threadId === reviewThreadId
                  ? AdversarialReviewService.adversarialReviewTitle(personThread.title)
                  : personThread.title,
            },
            messages: [],
          }),
      } as never),
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.succeed(Option.some({ id: projectId, title: "App", workspaceRoot: "/repo" })),
      } as never),
      Layer.succeed(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed(settings),
      } as never),
      Layer.succeed(ThreadIncrementProgressService.ThreadIncrementProgressService, {
        read: (request: { readonly threadIds: ReadonlyArray<ThreadId> }) =>
          Effect.succeed({
            projectId,
            threads: request.threadIds.map((threadId) => ({
              threadId,
              incrementId: "0042-passkeys",
              binding: input.binding ?? "claim",
              readable: true,
              tasks: reads++ === 0 ? input.tasks : (input.laterTasks ?? input.tasks),
            })),
          }),
      } as never),
      Layer.succeed(AdversarialReviewService.AdversarialReviewService, {
        start: (request: AdversarialReviewService.AdversarialReviewStartInput) =>
          Effect.sync(() => {
            starts.push(request);
            return {
              status: "started" as const,
              threadId: reviewThreadId,
              reviewer: { instanceId: "codex", model: "gpt-6.1-sol" } as never,
              skipped: [],
            };
          }),
      }),
    );
    yield* AdversarialReviewReactor.start.pipe(Effect.provide(services));
    yield* Deferred.await(done);
    if (input.wait !== undefined) {
      yield* TestClock.adjust(input.wait as never);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
    }
    return starts;
  }).pipe(Effect.scoped);

describe("AdversarialReviewReactor", () => {
  it.effect("starts one review when the increment's last task finishes", () =>
    Effect.gen(function* () {
      const starts = yield* runReactor({
        auto: true,
        tasks: [task("done"), task("skipped")],
        events: [
          completed(sourceId, "run-1"),
          completed(sourceId, "run-2"),
          completed(reviewThreadId, "run-3"),
        ],
      });
      expect(starts).toEqual([
        {
          threadId: sourceId,
          commandId: "adversarial-review:project-review:0042-passkeys",
          trigger: "feature-complete",
        },
      ]);
    }),
  );

  it.effect("starts nothing with the setting off or a task still open", () =>
    Effect.gen(function* () {
      const off = yield* runReactor({
        auto: false,
        tasks: [task("done")],
        events: [completed(sourceId, "run-1")],
      });
      const open = yield* runReactor({
        auto: true,
        tasks: [task("done"), task("claimed")],
        events: [completed(sourceId, "run-1")],
      });
      expect(off).toEqual([]);
      expect(open).toEqual([]);
    }),
  );

  it.effect("never reviews an increment a thread only names", () =>
    Effect.gen(function* () {
      const starts = yield* runReactor({
        auto: true,
        binding: "name",
        tasks: [task("done")],
        events: [completed(sourceId, "run-1")],
      });
      expect(starts).toEqual([]);
    }),
  );

  it.effect("looks again once the cached progress has expired", () =>
    Effect.gen(function* () {
      const early = yield* runReactor({
        auto: true,
        tasks: [task("done"), task("claimed")],
        laterTasks: [task("done"), task("done")],
        events: [completed(sourceId, "run-1")],
        wait: "5 seconds",
      });
      expect(early).toEqual([]);
      const later = yield* runReactor({
        auto: true,
        tasks: [task("done"), task("claimed")],
        laterTasks: [task("done"), task("done")],
        events: [completed(sourceId, "run-1")],
        wait: "6 seconds",
      });
      expect(later.map((start) => start.commandId)).toEqual([
        "adversarial-review:project-review:0042-passkeys",
      ]);
    }),
  );
});
