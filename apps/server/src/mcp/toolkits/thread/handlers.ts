import {
  assertPersonalChatBoundary,
  assertPersonalReadBoundary,
  personalReadAllowed,
} from "../../personalChatBoundary.ts";
import {
  CommandId,
  MessageId,
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
import { findSquashedText, squashedTextMessage } from "@specweave-studio/shared/threadReport";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertTargetWithinLimits,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import type { ProjectionRecordField } from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { isProjectActionRequestId } from "../../../project/projectActionRequestId.ts";
import { isGmailSendRequestId } from "../google/sendApproval.ts";
import {
  assertAccountInGrant,
  assertProjectReadable,
  projectReachable,
  refuseGrantRoutineChange,
  workGrantOf,
} from "../../workGrantAccess.ts";
import { refuseOthersRoutine } from "../../routineOwnership.ts";
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

/** `readThread` for content reads: another project's agent never reads the assistant's chats. */
const readThreadContent = Effect.fn("mcp.readThreadContent")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  yield* assertPersonalReadBoundary(context.caller?.projectId, context.projection.thread.projectId);
  return context;
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThreadContent(input.threadId, ["runtimeRequests", "turnItems"]);
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

/** Thread ids fit the receipt's identity limit; an outside client is named by its label. */
function deliveryReporter(scope: McpInvocationContext.McpInvocationScope): string {
  const reporter =
    scope.thread !== undefined
      ? `thread:${scope.thread.threadId}`
      : `client:${scope.client?.label ?? "unknown"}`;
  return reporter.length <= 500 ? reporter : reporter.slice(0, 500);
}

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      // Another machine's work runs this machine's routines only when its grant allows routines,
      // and then only in a project the grant covers.
      yield* refuseGrantRoutineChange(yield* readCaller(), undefined);
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      const task = tasks.find((task) => task.id === input.taskId);
      if (task === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const context = yield* readCaller();
      const work = yield* refuseGrantRoutineChange(context, task.projectId);
      // Under a grant, only a routine that grant made: the owner's routines here stay the owner's.
      yield* refuseOthersRoutine(scheduler.readGrant, work, task, "run");
      // Under a grant a run starts no broader than the caller may work: the
      // routine's modes, and a bound thread's modes as they are now, as for an
      // update. writesEnvironment already asks for a full-access caller; this
      // keeps the bar if that ever loosens.
      if (work !== undefined) {
        yield* assertTargetWithinLimits(context.limits, task);
        if (task.threadId !== null) {
          const bound = yield* context.threads
            .getThreadShell(ThreadId.make(task.threadId))
            .pipe(Effect.mapError(unavailable));
          if (bound !== null && bound.deletedAt === null)
            yield* assertTargetWithinLimits(context.limits, bound);
        }
      }
      const { caller } = context;
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
      const own = context.caller?.projectId;
      if (projectId !== undefined) yield* assertPersonalReadBoundary(own, projectId);
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(query).pipe(Effect.mapError(unavailable));
      const matches =
        projectId === undefined
          ? result.matches
          : result.matches.filter((match) => match.projectId === projectId);
      // Another machine's work sees only the projects its grant covers, and an
      // agent in another project never the personal assistant's chats.
      const reachable = new Set<string>();
      for (const id of new Set(matches.map((match) => match.projectId))) {
        if (work !== undefined && !(yield* projectReachable(work, id))) continue;
        if (yield* personalReadAllowed(own, id)) reachable.add(id);
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
      const { projection } = yield* readThreadContent(input.threadId, ["contextTransfers"]);
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
      } = yield* readThreadContent(input.threadId);
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
        caller,
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      // Another machine's work moves a thread only onto a sign-in its grant allows.
      yield* assertAccountInGrant(
        yield* workGrantOf(yield* readCaller()),
        input.modelSelection.instanceId,
      );
      // The thread stays one thread: the message queues on the new model, so this
      // turn ends as it was going to and the next runs there with the context.
      if (input.continueWith !== undefined) {
        // Another thread takes its work through studio_thread_send and its checks.
        if (caller?.id !== thread.id)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "continueWith is for this thread's own next turn. Use studio_thread_send.",
          });
        const squashed = findSquashedText(input.continueWith);
        if (squashed !== null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: squashedTextMessage(squashed),
          });
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const key = `${scope.requestNamespace}:${input.clientRequestId ?? (yield* newCommandId())}`;
        const sent = yield* threads
          .sendToThread({
            projectId: thread.projectId,
            commandId: CommandId.make(`mcp:model-switch:${thread.id}:${key}`),
            threadId: thread.id,
            senderThreadId: caller.id,
            messageId: MessageId.make(`message:model-switch:${thread.id}:${key}`),
            text: input.continueWith,
            attachments: [],
            mode: "queue",
            modelSelection: input.modelSelection,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: `Unable to queue the next turn: ${error.message}`,
                }),
            ),
          );
        return { sequence: sent.dispatch.sequence };
      }
      // Moving the running turn's own session to another provider would stop the
      // agent that asked, with nothing left to carry the work on.
      if (caller?.id === thread.id && thread.providerInstanceId !== input.modelSelection.instanceId)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "This would stop your own turn. Pass continueWith with what the next turn should do, then end your turn: it runs on the new model in this thread.",
        });
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
      const { projection } = yield* readThreadContent(input.threadId, ["runtimeRequests"]);
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
      // Approval cards for project changes, and reply cards whose Send sends
      // mail, are the user's alone to answer.
      if (isProjectActionRequestId(input.requestId) || isGmailSendRequestId(input.requestId))
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
      const { projection } = yield* readThreadContent(input.threadId, ["runs", "messages"]);
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
      const { projection } = yield* readThreadContent(input.threadId, ["runs", "messages"]);
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
  studio_thread_record_delivery: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, scope, caller } = yield* readThread(input.threadId);
      // Nor can the subagents and forks it started, at any depth, vouch for it.
      let ancestor = caller?.lineage.parentThreadId ?? null;
      for (let hop = 0; ancestor !== null && ancestor !== projection.thread.id && hop < 64; hop++) {
        const shell = yield* threads.getThreadShell(ancestor).pipe(Effect.mapError(unavailable));
        ancestor = shell?.lineage.parentThreadId ?? null;
      }
      if (
        scope.thread?.threadId === projection.thread.id ||
        ancestor === projection.thread.id ||
        caller?.lineage.rootThreadId === projection.thread.id
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "A thread cannot vouch for its own delivery, nor can its subagents or forks. Another thread, such as the completion owner, verifies and records it.",
        });
      }
      const { threadId: _threadId, expectedRunId, ...report } = input;
      const result = yield* threads
        .dispatch({
          type: "thread.lifecycle-receipt.record",
          commandId: yield* newCommandId(),
          threadId: projection.thread.id,
          runId: expectedRunId,
          reportedBy: deliveryReporter(scope),
          report,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
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
          if (!self && (input.expectedRunId !== undefined || input.userRequested === true)) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "expectedRunId and userRequested are only for resolving your own running thread.",
            });
          }
          command = {
            ...common,
            ...(currentRun === undefined
              ? { type: "thread.settle" as const }
              : {
                  type: "thread.deferred-resolution.request" as const,
                  runId: currentRun.id,
                  ...(input.userRequested === true ? { userRequested: true as const } : {}),
                }),
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
