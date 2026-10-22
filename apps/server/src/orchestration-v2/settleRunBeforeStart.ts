import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@specweave-studio/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EventSink from "./EventSink.ts";
import type * as IdAllocator from "./IdAllocator.ts";

// Settles a run that never reached the provider: one signal turn item plus
// terminal run, attempt and root node, written only while the run is still
// the current starting attempt. Returns whether it was written.
export const makeSettleRunBeforeStart =
  (deps: {
    readonly eventSink: EventSink.EventSinkV2Shape;
    readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  }) =>
  (context: {
    readonly projection: {
      readonly thread: { readonly id: ThreadId };
      readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    };
    readonly run: OrchestrationV2Run;
    readonly rootNode: OrchestrationV2ExecutionNode;
    readonly attempt: OrchestrationV2RunAttempt;
  }) => {
    const { eventSink, idAllocator } = deps;
    const { projection, run, rootNode, attempt } = context;
    const runId = run.id;
    return Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(function* (input: {
      readonly signal: string;
      readonly status: "completed" | "failed";
      readonly now: DateTime.Utc;
      /** Omitted when the run never started, so `startedAt` stays as projected. */
      readonly startedAt?: DateTime.Utc;
      readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
      readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
      readonly item:
        | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
        | Pick<
            Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
            "type" | "title" | "input" | "output" | "exitCode"
          >;
      /** Emitted after the run events when the provider thread should go idle. */
      readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
    }) {
      const { now, status } = input;
      const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
      const item: OrchestrationV2TurnItem = {
        id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
        threadId: projection.thread.id,
        runId,
        nodeId: rootNode.id,
        providerThreadId: input.itemProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal:
          Math.max(
            0,
            ...projection.turnItems
              .filter((item) => item.runId === runId)
              .map((item) => item.ordinal),
          ) + 1,
        status,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        ...input.item,
      };
      const eventPayloads = [
        { type: "turn-item.updated", payload: item },
        { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
        {
          type: "run-attempt.updated",
          payload: { ...attempt, status, ...started, completedAt: now },
        },
        {
          type: "node.updated",
          payload: { ...rootNode, status, ...started, completedAt: now },
        },
        ...(input.providerThreadUpdate === undefined
          ? []
          : [
              {
                type: "provider-thread.updated" as const,
                payload: input.providerThreadUpdate,
              },
            ]),
      ] as const;
      const events = yield* Effect.forEach(eventPayloads, (event) =>
        Effect.gen(function* () {
          return {
            ...event,
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerInstanceId: input.providerInstanceId,
            occurredAt: now,
          } satisfies OrchestrationV2DomainEvent;
        }),
      );
      const written = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      return written.committed;
    });
  };
