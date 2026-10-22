import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

/**
 * A pending request as a thread shell summarizes it. The shell carries only
 * id, kind and creation time; a caller that read the request itself may add
 * its response capability and the run it belongs to (see
 * `withPendingRequestDetail`), which is what tells a real blocker apart.
 */
export interface PendingRequestSummary {
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  readonly responseCapability?: OrchestrationV2RuntimeRequest["responseCapability"] | undefined;
  /** The run the request belongs to; null when it belongs to none. */
  readonly runId?: OrchestrationV2Run["id"] | null | undefined;
}

/** A thread shell, or what it is built from: the thread's requests and nodes. */
export type ShellOrThread =
  | { readonly pendingRuntimeRequest: PendingRequestSummary | null }
  | {
      readonly runtimeRequests: ReadonlyArray<
        Pick<OrchestrationV2RuntimeRequest, "status" | "kind" | "responseCapability" | "nodeId">
      >;
      readonly nodes?: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "runId">>;
      readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "rootNodeId">>;
    };

/**
 * A question the provider asked through a message: the next turn answers it,
 * so the orchestrator starts new turns while it is pending.
 */
const answeredByMessage = (request: PendingRequestSummary): boolean =>
  request.kind === "user_input" && request.responseCapability?.type === "message";

function blocks(
  request: PendingRequestSummary,
  latestRunId: OrchestrationV2Run["id"] | string | null,
): boolean {
  if (answeredByMessage(request)) return false;
  // A request left behind by an earlier run waits on nothing the thread does
  // now. One that belongs to no run counts as the latest run's, as the
  // candidate read in ProjectionStore takes it, so it holds.
  if (request.runId != null && latestRunId !== null && request.runId !== latestRunId) return false;
  return true;
}

/**
 * Whether a pending runtime request really holds the thread: an approval, a
 * live question, or anything not yet known to be otherwise. A `user_input`
 * answered by a message (which the orchestrator already treats as
 * non-blocking) and a request whose run is no longer the thread's latest
 * never hold it. A shell summary without the request's detail, and a request
 * that belongs to no run, count as blocking, so an unread request is never
 * skipped.
 */
export function isBlockingRuntimeRequest(
  shellOrThread: ShellOrThread,
  latestRunId: OrchestrationV2Run["id"] | string | null,
): boolean {
  if ("pendingRuntimeRequest" in shellOrThread) {
    const request = shellOrThread.pendingRuntimeRequest;
    return request !== null && blocks(request, latestRunId);
  }
  return shellOrThread.runtimeRequests.some(
    (request) =>
      request.status === "pending" &&
      blocks(
        {
          kind: request.kind,
          responseCapability: request.responseCapability,
          runId: requestRunId(shellOrThread, request.nodeId),
        },
        latestRunId,
      ),
  );
}

/**
 * The run a request's node belongs to: the node's own run, else the run it is
 * the root of (as the candidate read coalesces them). Null when the node
 * names no run and none owns it; undefined when the records do not say.
 */
function requestRunId(
  thread: Extract<ShellOrThread, { readonly runtimeRequests: unknown }>,
  nodeId: OrchestrationV2RuntimeRequest["nodeId"],
): OrchestrationV2Run["id"] | null | undefined {
  const node = thread.nodes?.find((candidate) => candidate.id === nodeId);
  const owner = thread.runs?.find((run) => run.rootNodeId === nodeId)?.id;
  return node?.runId ?? owner ?? (node === undefined ? undefined : null);
}

/**
 * The shell's pending request with the detail its summary leaves out, read
 * from the thread's own requests and nodes. Unchanged when the summary's
 * request is not among them (a secret request, which lives on a turn item).
 */
export function withPendingRequestDetail<
  T extends {
    readonly pendingRuntimeRequest: (PendingRequestSummary & { readonly id: string }) | null;
  },
>(
  shell: T,
  records: {
    readonly runtimeRequests: ReadonlyArray<
      Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "responseCapability" | "nodeId">
    >;
    readonly nodes?: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "runId">>;
    readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "rootNodeId">>;
  },
): T {
  const summary = shell.pendingRuntimeRequest;
  if (summary === null) return shell;
  const request = records.runtimeRequests.find((candidate) => candidate.id === summary.id);
  if (request === undefined) return shell;
  const runId = requestRunId({ ...records, runtimeRequests: [] }, request.nodeId);
  return {
    ...shell,
    pendingRuntimeRequest: {
      ...summary,
      responseCapability: request.responseCapability,
      ...(runId === undefined ? {} : { runId }),
    },
  };
}

/**
 * The detail last read for each thread's pending request, kept while nothing
 * that could change it has: the newest pending request, the latest run and
 * the thread's last change (any event on the thread, such as another request
 * answered or raised, moves `updatedAt`). One entry per thread; `retain`
 * drops the threads a sweep no longer lists.
 */
export function pendingRequestDetailMemo<D>() {
  type Thread = {
    readonly id: string;
    readonly latestRunId: string | null;
    readonly updatedAt?: DateTime.Utc | undefined;
    readonly pendingRuntimeRequest: { readonly id: string } | null;
  };
  const entries = new Map<string, { readonly key: string; readonly detail: D }>();
  const keyOf = (thread: Thread) =>
    [
      thread.pendingRuntimeRequest?.id ?? "",
      thread.latestRunId ?? "",
      thread.updatedAt === undefined ? "" : DateTime.formatIso(thread.updatedAt),
    ].join("|");
  return {
    get: (thread: Thread): D | undefined => {
      const entry = entries.get(thread.id);
      return entry?.key === keyOf(thread) ? entry.detail : undefined;
    },
    set: (thread: Thread, detail: D): void => {
      entries.set(thread.id, { key: keyOf(thread), detail });
    },
    retain: (threadIds: Iterable<string>): void => {
      const listed = new Set(threadIds);
      for (const threadId of entries.keys()) if (!listed.has(threadId)) entries.delete(threadId);
    },
    get size(): number {
      return entries.size;
    },
  };
}

/**
 * Pending questions the provider asked through a message on `runId`. They do
 * not hold the thread, so a server continuation may resume it while one is
 * open; the continuation then repeats the question (`openQuestionReminder`).
 */
export function openMessageQuestionIds(
  thread: {
    readonly runtimeRequests: ReadonlyArray<
      Pick<
        OrchestrationV2RuntimeRequest,
        "id" | "status" | "kind" | "responseCapability" | "nodeId"
      >
    >;
    readonly nodes?: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "runId">>;
    readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "rootNodeId">>;
  },
  runId: OrchestrationV2Run["id"],
): ReadonlyArray<OrchestrationV2RuntimeRequest["id"]> {
  return thread.runtimeRequests
    .filter(
      (request) =>
        request.status === "pending" &&
        answeredByMessage(request) &&
        requestRunId(thread, request.nodeId) === runId,
    )
    .map((request) => request.id);
}

/**
 * Appended to a server continuation of a run whose question to the person is
 * still open, so the provider neither drops it nor takes the continuation as
 * the answer.
 */
export function openQuestionReminder(
  questions: ReadonlyArray<Pick<OrchestrationV2UserInputQuestion, "question">>,
): string {
  if (questions.length === 0) return "";
  return [
    "",
    "",
    questions.length === 1
      ? "Before the stop you asked the person this, and it is still unanswered:"
      : "Before the stop you asked the person these, and they are still unanswered:",
    ...questions.map((question) => `- ${question.question}`),
    "This message is not their answer. Carry on with what does not depend on it, and ask again in your reply if you still need it.",
  ].join("\n");
}
