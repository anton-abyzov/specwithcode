import { assertPersonalChatBoundary } from "../../personalChatBoundary.ts";
import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@specweave-studio/shared/model";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { isProjectActionRequestId } from "../../../project/projectActionRequestId.ts";
import {
  assertAccountInGrant,
  assertProjectReadable,
  projectReachable,
  refuseGrantRoutineChange,
  workGrantOf,
} from "../../workGrantAccess.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
    ...(run.queueHeld === true ? { held: true } : {}),
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) =>
      request.id === input.requestId &&
      request.kind === "user_input" &&
      request.status === "pending",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  return { ...context, request, item };
});
/** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  McpToolAccess.writesThreads(
    (params: P) => [params.threadId],
    (params) =>
      Effect.gen(function* () {
        const { caller, projection } = yield* readThread(params.threadId);
        yield* assertPersonalChatBoundary(caller?.projectId, projection.thread.projectId);
        return yield* handle(params);
      }),
  );

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      // Another machine's work does not run this machine's routines.
      yield* refuseGrantRoutineChange(yield* readCaller());
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      const task = tasks.find((task) => task.id === input.taskId);
      if (task === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { caller } = yield* readCaller();
      yield* assertPersonalChatBoundary(caller?.projectId, task.projectId);
      const { task: started } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: started.id,
        threadId: started.threadId,
        lastRunStatus: started.lastRunStatus,
        runCount: started.runCount,
        nextRunAt: started.nextRunAt,
      };
    }),
  ),
  studio_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const { projectId: requested, ...query } = input;
      // Like the other project tools, an omitted project means the caller's own; a client
      // outside a thread searches every project.
      const projectId = requested ?? context.caller?.projectId;
      const work =
        projectId === undefined
          ? yield* workGrantOf(context)
          : yield* assertProjectReadable(context, projectId);
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(query).pipe(Effect.mapError(unavailable));
      const matches =
        projectId === undefined
          ? result.matches
          : result.matches.filter((match) => match.projectId === projectId);
      // Another machine's work sees only the projects its grant covers, never a
      // personal assistant's.
      if (work === undefined) return { matches };
      const reachable = new Set<string>();
      for (const id of new Set(matches.map((match) => match.projectId))) {
        if (yield* projectReachable(work, id)) reachable.add(id);
      }
      return { matches: matches.filter((match) => reachable.has(match.projectId)) };
    }),
  ),
  studio_thread_fork: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  ),
  studio_thread_merge_back: McpToolAccess.writesThreads(
    (input) => [input.targetThreadId, input.sourceThreadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.targetThreadId);
        const source = yield* readThread(input.sourceThreadId);
        yield* assertPersonalChatBoundary(
          context.caller?.projectId,
          context.projection.thread.projectId,
        );
        yield* assertPersonalChatBoundary(
          context.caller?.projectId,
          source.projection.thread.projectId,
        );
        const result = yield* context.threads
          .dispatch({
            type: "thread.merge_back",
            commandId: yield* newCommandId(),
            sourceThreadId: source.projection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.sourcePoint,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId: input.targetThreadId };
      }),
  ),
  studio_thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  studio_thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  ),
  studio_thread_configure: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      // Another machine's work moves a thread only onto a sign-in its grant allows.
      yield* assertAccountInGrant(
        yield* workGrantOf(yield* readCaller()),
        input.modelSelection.instanceId,
      );
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  studio_pending_request_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  ),
  studio_pending_request_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  ),
  studio_pending_request_respond: writesThread((input) =>
    Effect.gen(function* () {
      // Approval cards for project changes are the user's alone to answer.
      if (isProjectActionRequestId(input.requestId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Only the user can answer an approval card. Wait for their answer.",
        });
      const { threads, projection } = yield* readQuestion(input);
      const caller = (yield* McpInvocationContext.McpInvocationContext).thread;
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
          ...(caller?.threadId === undefined ? {} : { answeredByThreadId: caller.threadId }),
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  studio_queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  studio_queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  studio_queue_edit: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  studio_queue_cancel: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  studio_queue_reorder: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  studio_queue_resume: writesThread((input) =>
    dispatch(input.threadId, (common) => ({ ...common, type: "queue.resume" })),
  ),
  studio_queue_promote_to_steer: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  studio_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, scope } = yield* readThread(input.threadId, ["runs"]);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      let command: OrchestrationV2ServerCommand;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "settle": {
          const self = scope.thread?.threadId === projection.thread.id;
          if (self && input.expectedRunId === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Resolving your own thread requires expectedRunId from studio_thread_read. A delayed call cannot adopt a newer turn.",
            });
          }
          const currentRun = self
            ? projection.runs.find(
                (run) =>
                  run.id === input.expectedRunId &&
                  ["starting", "running", "waiting"].includes(run.status),
              )
            : undefined;
          if (self && currentRun === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "The expected run is not this thread's active turn. This delayed call cannot resolve a newer or finished turn.",
            });
          }
          if (!self && input.expectedRunId !== undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "expectedRunId is only for resolving your own running thread.",
            });
          }
          command = {
            ...common,
            ...(currentRun === undefined
              ? { type: "thread.settle" as const }
              : { type: "thread.deferred-resolution.request" as const, runId: currentRun.id }),
            ...(input.note === undefined ? {} : { note: input.note }),
          };
          break;
        }
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
