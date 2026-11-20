/**
 * A handed-off thread that came back to the machine it was launched from.
 *
 * The continuation is then a thread on this machine. It is known by the row
 * that follows the handoff, not by who created it (the takeover creates it as
 * the system), and it is read here in the shape the other machine's
 * `studio_thread_wait` and `studio_thread_read` answer in, so one set of rules
 * decides its result wherever it runs.
 */
import { RunId, threadExecutionSummary, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";

type Threads = Pick<
  ThreadManagementService.ThreadManagementService["Service"],
  "getThreadShell" | "getThreadRecords" | "waitForThread"
>;

const refused = (remoteCode: string, remoteMessage: string) =>
  new RemoteStudioMcpClient.RemoteMcpError({ reason: "tool_failure", remoteCode, remoteMessage });

const unavailable = (cause: unknown) =>
  new RemoteStudioMcpClient.RemoteMcpError({ reason: "unreachable", cause });

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

export const make = (threads: Threads) => {
  const shellOf = (threadId: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(refused("thread_not_found", `Thread ${threadId} was not found.`))
          : Effect.succeed(shell),
      ),
    );

  const wait = (input: Record<string, unknown>) =>
    Effect.gen(function* () {
      const threadId = String(input.threadId);
      const shell = yield* shellOf(threadId);
      const waited = yield* threads
        .waitForThread({
          projectId: shell.projectId,
          threadId: shell.id,
          ...(typeof input.runId === "string" ? { runId: RunId.make(input.runId) } : {}),
          timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : 1,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementRunNotFoundError"
              ? refused("run_not_found", error.message)
              : error._tag === "ThreadManagementThreadNotFoundError"
                ? refused("thread_not_found", error.message)
                : unavailable(error),
          ),
        );
      return {
        threadId,
        runId: waited.run?.id ?? null,
        status: waited.run?.status ?? "idle",
        timedOut: waited.timedOut,
      };
    });

  const read = (input: Record<string, unknown>) =>
    Effect.gen(function* () {
      const threadId = String(input.threadId);
      yield* shellOf(threadId);
      const records = yield* threads
        .getThreadRecords(ThreadId.make(threadId), ["runs", "messages", "runtimeRequests"], {
          messageRoles: ["user"],
        })
        .pipe(Effect.mapError(unavailable));
      const execution = records.thread.execution ?? null;
      return {
        thread: {
          runCount: records.runs.length,
          pendingRequestCount: records.runtimeRequests.filter(
            (request) => request.status === "pending",
          ).length,
          ...threadExecutionSummary(records.thread),
          ...(execution === null ? {} : { executionHistory: execution.history }),
        },
        // Every run and every message that started one: nothing is off a page here.
        recentRuns: records.runs.map((run) => ({
          runId: run.id,
          ordinal: run.ordinal,
          status: run.status,
          startedAt: iso(run.startedAt),
          completedAt: iso(run.completedAt),
        })),
        items: records.messages.flatMap((message, position) =>
          message.runId === null
            ? []
            : [
                {
                  type: "user_message",
                  runId: message.runId,
                  messageId: message.id,
                  creationSource: message.creationSource,
                  position,
                },
              ],
        ),
        hasMore: false,
        nextPosition: null,
      };
    });

  return {
    call: (input: {
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
    }): Effect.Effect<unknown, RemoteStudioMcpClient.RemoteMcpError> =>
      input.tool === "studio_thread_wait" ? wait(input.arguments) : read(input.arguments),
  };
};
