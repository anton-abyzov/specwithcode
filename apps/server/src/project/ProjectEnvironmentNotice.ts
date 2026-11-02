import type { ProviderInstanceId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2TurnInput } from "../orchestration-v2/ProviderAdapter.ts";
import {
  describeProjectEnvironmentProblem,
  type ProjectEnvironmentProblem,
} from "./ProjectEnvironmentPaths.ts";

/**
 * Records, on the run itself, which saved folders a turn skipped and how to fix them,
 * so a stale entry is visible instead of silently missing. Best effort: a failed write
 * is logged and never fails the turn.
 */
export const makeEnvironmentSkipNotice = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  return (providerInstanceId: ProviderInstanceId) =>
    (turn: ProviderAdapterV2TurnInput, problems: ReadonlyArray<ProjectEnvironmentProblem>) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: turn.threadId }),
              type: "turn-item.updated",
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              providerInstanceId,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.runSignalTurnItem({
                  runId: turn.runId,
                  signal: "environment-skipped",
                }),
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId: turn.rootNodeId,
                providerThreadId: turn.providerThread.id,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                // Just before imported context (runOrdinal * 100 - 1) and the run's user message.
                ordinal: turn.runOrdinal * 100 - 2,
                status: "completed",
                title:
                  problems.length === 1 ? "Skipped a project folder" : "Skipped project folders",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "system_notice",
                message: problems.map(describeProjectEnvironmentProblem).join("\n"),
              },
            },
          ],
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record skipped project folders", cause),
        ),
      );
});
