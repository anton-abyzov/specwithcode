/**
 * A routine's run is recorded as succeeded once its message is dispatched, but
 * the turn can still fail afterwards (a disabled provider, a sign-out, a
 * deleted worktree). Copies that failure onto the routine so its card and
 * lastRunError show it instead of a plain "Last ran".
 */
import type { OrchestrationV2DomainEvent, OrchestrationV2Run } from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { ScheduledTaskService } from "./ScheduledTaskService.ts";

export const TURN_FAILED_FALLBACK = "The routine's turn failed.";

class DispatchNotRecorded extends Data.TaggedError("DispatchNotRecorded") {}

// The turn can fail before the run path records its dispatch (a launch can
// prepare a worktree first); wait up to two minutes for it.
const dispatchRecordRetry = Schedule.spaced(Duration.seconds(1));

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const scheduledTasks = yield* ScheduledTaskService;

  const observeFailedRun = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const records = yield* orchestrator.getThreadRecords(
        run.threadId,
        ["messages", "turnItems"],
        {
          messageIds: [run.userMessageId],
          turnItemRunId: run.id,
          turnItemTypes: ["error"],
        },
      );
      const taskId = records.messages.find(
        (message) => message.id === run.userMessageId,
      )?.scheduledTaskId;
      if (taskId === undefined) return;
      const failure = records.turnItems
        .filter((item) => item.runId === run.id && item.type === "error")
        .at(-1);
      const error =
        failure?.type === "error" && failure.failure.message.trim() !== ""
          ? failure.failure.message
          : TURN_FAILED_FALLBACK;
      yield* scheduledTasks
        .recordTurnFailure({ id: taskId, requestedAt: run.requestedAt, error })
        .pipe(
          Effect.flatMap((outcome) =>
            outcome === "running" ? Effect.fail(new DispatchNotRecorded()) : Effect.void,
          ),
          Effect.retry({
            schedule: dispatchRecordRetry,
            times: 120,
            while: (cause) => cause._tag === "DispatchNotRecorded",
          }),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record a routine's failed turn", {
          runId: run.id,
          cause,
        }),
      ),
    );

  return {
    observeEvent: (event: OrchestrationV2DomainEvent) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? observeFailedRun(event.payload)
        : Effect.void,
  };
});

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const reactor = yield* make;
  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "run.updated" && event.payload.status === "failed"),
      // A failure waiting for its dispatch record must not hold up the others.
      Stream.mapEffect(reactor.observeEvent, { concurrency: 8, unordered: true }),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logWarning("Routine turn failure event stream failed", { cause }),
      ),
    ),
  );
});
