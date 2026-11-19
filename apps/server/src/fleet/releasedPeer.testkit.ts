/**
 * Another machine's thread tools as the release a peer may still run answers
 * them: v1.0.380, commit 2bd4cef142db11b50cb52a529f421241630a7dd4. A source on
 * newer code must get a handed-off worker's result from exactly these answers.
 *
 * The rules below are that release's, each with where it lives there:
 *  - studio_thread_read lists runs newest first and at most `runLimit`, 10
 *    when none is given (mcp/OrchestratorMcpService.ts, readThread); a
 *    `runLimit` above 50 is refused by the input schema (contracts
 *    orchestratorMcp.ts, OrchestratorMcpThreadReadInput). The thread's
 *    `runCount` counts every run. A run is never deleted: a cancelled queued
 *    message stays as a "cancelled" run.
 *  - Its items are a page of the thread: after `afterPosition` the oldest
 *    `limit`, otherwise the newest `limit` (50 when none is given).
 *  - studio_thread_wait answers "idle" with no run for a thread that has none,
 *    the latest run when no run is named, and fails with `run_not_found` for
 *    a run the thread does not have (orchestration-v2/ThreadManagementService.ts,
 *    waitForThread; "Run <id> does not belong to thread <id>.").
 *  - A thread it does not have fails with `thread_not_found`.
 *  - A thread handed on reads `executionState: "fenced"`, the machine that runs
 *    it now, and the epoch of that move in `executionHistory`
 *    (handoff/HandoffMoves.ts, the source's execution record).
 *
 * Every answer is decoded with the tools' own contract schemas, so a fixture
 * that drifts from the wire shape fails the test that uses it.
 */
import {
  EnvironmentId,
  MessageId,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { FakeToolAnswer, FakeToolHandler } from "./fakeStudioMcp.testkit.ts";

export const RELEASED_PEER = {
  tag: "v1.0.380",
  commit: "2bd4cef142db11b50cb52a529f421241630a7dd4",
} as const;

const OPEN = ["preparing", "queued", "starting", "running", "waiting"];

export interface PeerRun {
  readonly id: string;
  readonly ordinal: number;
  status: string;
  readonly requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** The message that started it: who sent it, and under which id. */
  readonly message: { readonly id: string; readonly creationSource: "mcp" | "server" | "web" };
}

export interface PeerThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly runs: Array<PeerRun>;
  /** Set once the thread was handed on to another machine. */
  movedTo?: { readonly environmentId: string; readonly label: string; readonly epoch: number };
}

const decodeReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeReadResult = Schema.decodeUnknownSync(OrchestratorMcpThreadReadResult);
const decodeWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);
const decodeWaitResult = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitResult);

const failure = (code: string, message: string): FakeToolAnswer => ({
  failure: JSON.stringify({ code, message }),
});

export function releasedPeer(environmentId: string) {
  const threads = new Map<string, PeerThread>();
  const calls: Array<{ readonly tool: string; readonly args: Record<string, unknown> }> = [];
  /** A clock of its own: every event there is a second after the one before. */
  let seconds = 0;
  const start = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-20T14:00:00.000Z"));
  const at = () => DateTime.formatIso(DateTime.makeUnsafe(start + 1000 * seconds++));

  const threadOf = (threadId: string) => {
    const thread = threads.get(threadId);
    if (thread === undefined) throw new Error(`The peer has no thread ${threadId}.`);
    return thread;
  };

  const peer = {
    environmentId,
    threads,
    calls,
    /** The machine does not answer at all. */
    unreachable: false,
    /** Held before a tool answers, so a test decides what the caller sees first. */
    hold: undefined as ((tool: string, args: Record<string, unknown>) => Promise<void>) | undefined,
    /** Calls about one thread, for a test that waits until it was asked again. */
    asked: (threadId: string, tool?: string) =>
      calls.filter(
        (call) => call.args.threadId === threadId && (tool === undefined || call.tool === tool),
      ).length,
    create: (threadId: string, projectId = "remote-project") => {
      const thread: PeerThread = { threadId, projectId, runs: [] };
      threads.set(threadId, thread);
      return thread;
    },
    /** A message there starts a run, or queues one behind the run that is going. */
    start: (
      threadId: string,
      input: {
        readonly id?: string;
        readonly status?: string;
        readonly messageId?: string;
        readonly creationSource?: "mcp" | "server" | "web";
      } = {},
    ) => {
      const thread = threadOf(threadId);
      const ordinal = thread.runs.length + 1;
      const id = input.id ?? `${threadId}:run-${ordinal}`;
      const status = input.status ?? "running";
      const requestedAt = at();
      const run: PeerRun = {
        id,
        ordinal,
        status,
        requestedAt,
        startedAt: status === "queued" ? null : requestedAt,
        completedAt: OPEN.includes(status) ? null : at(),
        message: {
          id: input.messageId ?? `message:${id}`,
          creationSource: input.creationSource ?? "mcp",
        },
      };
      thread.runs.push(run);
      return run;
    },
    /** Moves a run on: it starts, or ends as `status`. */
    set: (threadId: string, runId: string, status: string) => {
      const run = threadOf(threadId).runs.find((candidate) => candidate.id === runId);
      if (run === undefined) throw new Error(`The peer has no run ${runId}.`);
      if (run.startedAt === null && status !== "queued" && status !== "cancelled")
        run.startedAt = at();
      run.status = status;
      run.completedAt = OPEN.includes(status) ? null : at();
    },
    /** The thread was handed on: its copy here is fenced and says who runs it now. */
    handOn: (
      threadId: string,
      to: { readonly environmentId: string; readonly label: string; readonly epoch: number },
    ) => {
      const thread = threadOf(threadId);
      for (const run of thread.runs) {
        if (OPEN.includes(run.status)) peer.set(threadId, run.id, "interrupted");
      }
      thread.movedTo = to;
    },
    tools: {} as Record<"studio_thread_read" | "studio_thread_wait", FakeToolHandler>,
  };

  const answer =
    (tool: string, handler: (args: Record<string, unknown>) => FakeToolAnswer): FakeToolHandler =>
    async (args) => {
      calls.push({ tool, args });
      await peer.hold?.(tool, args);
      if (peer.unreachable) return { raw: new Response("down", { status: 503 }) };
      return handler(args);
    };

  const detail = (thread: PeerThread) => {
    const newest = thread.runs.toSorted((left, right) => right.ordinal - left.ordinal);
    const active = newest.find((run) => OPEN.includes(run.status));
    const created = "2026-10-20T13:00:00.000Z";
    return {
      threadId: ThreadId.make(thread.threadId),
      projectId: ProjectId.make(thread.projectId),
      title: "Fix the build",
      createdBy: "system",
      creationSource: "server",
      status: active?.status ?? newest[0]?.status ?? "idle",
      latestRunId: newest[0] === undefined ? null : RunId.make(newest[0].id),
      activeRunId: active === undefined ? null : RunId.make(active.id),
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      titleRegeneration: null,
      branch: null,
      worktreePath: null,
      parentThreadId: null,
      relationshipToParent: null,
      runCount: thread.runs.length,
      itemCount: thread.runs.length,
      pendingRequestCount: 0,
      archived: false,
      settled: false,
      settledAt: null,
      ...(thread.movedTo === undefined
        ? {}
        : {
            ownerMachineId: EnvironmentId.make(environmentId),
            executionMachineId: EnvironmentId.make(thread.movedTo.environmentId),
            executionMachineLabel: thread.movedTo.label,
            executionState: "fenced",
            executionLastSeenAt: null,
            executionHistory: [
              {
                machine: EnvironmentId.make(environmentId),
                from: created,
                to: created,
                reason: "created",
                epoch: thread.movedTo.epoch - 1,
              },
              {
                machine: EnvironmentId.make(thread.movedTo.environmentId),
                machineLabel: thread.movedTo.label,
                from: created,
                to: null,
                reason: "handoff",
                epoch: thread.movedTo.epoch,
              },
            ],
          }),
      createdAt: created,
      updatedAt: created,
    };
  };

  peer.tools.studio_thread_read = answer("studio_thread_read", (args) => {
    const input = decodeReadInput(args);
    const thread = threads.get(input.threadId);
    if (thread === undefined)
      return failure("thread_not_found", `Thread ${input.threadId} was not found.`);
    const items = thread.runs.map((run, position) => ({
      position,
      visibility: "local",
      sourceThreadId: ThreadId.make(thread.threadId),
      itemId: TurnItemId.make(`item:${run.id}`),
      runId: RunId.make(run.id),
      messageId: MessageId.make(run.message.id),
      createdBy: run.message.creationSource === "mcp" ? "agent" : "user",
      creationSource: run.message.creationSource,
      type: "user_message",
      status: "completed",
      title: null,
      text: "Continue.",
      textTruncated: false,
      nextTextOffset: null,
      updatedAt: run.requestedAt,
    }));
    const limit = input.limit ?? 50;
    const forward = input.afterPosition !== undefined;
    const matching = items.filter(
      (item) =>
        item.position > (input.afterPosition ?? -1) &&
        (input.beforePosition === undefined || item.position < input.beforePosition),
    );
    const page = forward
      ? matching.slice(0, limit)
      : matching.slice(Math.max(0, matching.length - limit));
    const result = {
      thread: detail(thread),
      recentRuns: thread.runs
        .toSorted((left, right) => right.ordinal - left.ordinal)
        .slice(0, input.runLimit ?? 10)
        .map((run) => ({
          runId: RunId.make(run.id),
          ordinal: run.ordinal,
          status: run.status,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
          requestedAt: run.requestedAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        })),
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: forward && matching.length > page.length,
    };
    decodeReadResult(result);
    return { result };
  });

  peer.tools.studio_thread_wait = answer("studio_thread_wait", (args) => {
    const input = decodeWaitInput(args);
    const thread = threads.get(input.threadId);
    if (thread === undefined)
      return failure("thread_not_found", `Thread ${input.threadId} was not found.`);
    const run =
      input.runId === undefined
        ? thread.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]
        : thread.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && run === undefined)
      return failure(
        "run_not_found",
        `Run ${input.runId} does not belong to thread ${input.threadId}.`,
      );
    const result = {
      threadId: ThreadId.make(thread.threadId),
      runId: run === undefined ? null : RunId.make(run.id),
      status: run?.status ?? "idle",
      // An open run is still open when the wait gives up.
      timedOut: run !== undefined && OPEN.includes(run.status),
    };
    decodeWaitResult(result);
    return { result };
  });

  return peer;
}

export type ReleasedPeer = ReturnType<typeof releasedPeer>;
