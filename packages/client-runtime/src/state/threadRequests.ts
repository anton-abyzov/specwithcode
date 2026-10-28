import { answeredRuntimeRequestCopy } from "@specweave-studio/shared/projectAttention";
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

type RequestProjection = Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> & {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "id">;
};
type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];
type ApprovalItem = Extract<TurnItem, { type: "approval_request" }>;
type FileChangeItem = Extract<TurnItem, { type: "file_change" }>;

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  /** Display-only association; never changes the request identity or response capability. */
  readonly fileChange?: Pick<FileChangeItem, "fileName" | "diffStr" | "changes">;
  /** App requesting access for mcp-elicitation approvals (#8058). */
  readonly appName?: string;
  /** Approval choices advertised by the provider (#8058); defaults apply when absent. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

function fileApprovalAnchor(projection: RequestProjection, request: OrchestrationV2RuntimeRequest) {
  if (request.kind !== "file-change" || request.providerTurnId === null) return undefined;
  const anchors = projection.turnItems.filter(
    (item): item is ApprovalItem =>
      item.type === "approval_request" &&
      item.requestId === request.id &&
      item.threadId === projection.thread.id,
  );
  const anchor = anchors.length === 1 ? anchors[0] : undefined;
  return anchor?.requestKind === "file-change" &&
    anchor.providerTurnId === request.providerTurnId &&
    anchor.providerThreadId !== null &&
    anchor.runId !== null &&
    anchor.nativeItemRef !== null &&
    typeof anchor.nativeItemRef.nativeId === "string" &&
    anchor.nativeItemRef.nativeId.length > 0
    ? anchor
    : undefined;
}

function isFileForApproval(item: TurnItem, anchor: ApprovalItem): item is FileChangeItem {
  return (
    item.type === "file_change" &&
    item.threadId === anchor.threadId &&
    item.runId === anchor.runId &&
    item.providerThreadId === anchor.providerThreadId &&
    item.providerTurnId === anchor.providerTurnId &&
    item.nativeItemRef !== null &&
    item.nativeItemRef.driver === anchor.nativeItemRef?.driver &&
    item.nativeItemRef.nativeId === anchor.nativeItemRef.nativeId
  );
}

/** Keep all matching file candidates so ambiguity or delayed details invalidate the cache. */
export function pendingRequestTurnItems(
  projection: RequestProjection,
): RequestProjection["turnItems"] {
  const requests = projection.runtimeRequests.filter((request) => request.status === "pending");
  const ids = new Set(requests.map((request) => request.id));
  const anchors = requests.flatMap((request) => {
    const anchor = fileApprovalAnchor(projection, request);
    return anchor ? [anchor] : [];
  });
  return projection.turnItems.filter(
    (item) =>
      item.threadId === projection.thread.id &&
      (item.type === "approval_request" || item.type === "user_input_request"
        ? ids.has(item.requestId)
        : anchors.some((anchor) => isFileForApproval(item, anchor))),
  );
}

function pendingFileChange(
  projection: RequestProjection,
  request: OrchestrationV2RuntimeRequest,
): ThreadPendingApproval["fileChange"] {
  const anchor = fileApprovalAnchor(projection, request);
  if (!anchor) return undefined;
  const files = projection.turnItems.filter((item) => isFileForApproval(item, anchor));
  const file = files.length === 1 ? files[0] : undefined;
  if (!file) return undefined;
  return {
    fileName: file.fileName,
    ...(file.diffStr !== undefined ? { diffStr: file.diffStr } : {}),
    ...(file.changes !== undefined ? { changes: file.changes } : {}),
  };
}

/** A legacy bounded cache may have kept the pending entity but lost its card. */
export function pendingQuestionsNeedHydration(projection: RequestProjection): boolean {
  return projection.runtimeRequests.some(
    (request) =>
      request.kind === "user_input" &&
      request.status === "pending" &&
      !answeredRuntimeRequestCopy(request, projection.runtimeRequests) &&
      !projection.turnItems.some(
        (item) =>
          item.type === "user_input_request" &&
          item.threadId === projection.thread.id &&
          item.requestId === request.id,
      ),
  );
}

/** Joins pending request entities to the request items that carry display data. */
export function derivePendingThreadRequests(projection: RequestProjection): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (
      request.status !== "pending" ||
      answeredRuntimeRequestCopy(request, projection.runtimeRequests)
    )
      continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" &&
          candidate.requestId === request.id &&
          candidate.threadId === projection.thread.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) =>
        candidate.type === "approval_request" &&
        candidate.requestId === request.id &&
        candidate.threadId === projection.thread.id,
    );
    const fileChange = pendingFileChange(projection, request);
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      ...(fileChange ? { fileChange } : {}),
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
    });
  }

  return { approvals, userInputs };
}

/** Older V2 answers were saved on requests without updating their timeline items. */
export function createQuestionHistoryProjector() {
  type Rows = OrchestrationV2ThreadProjection["visibleTurnItems"];
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  const cache = new WeakMap<Rows[number], { request: Requests[number]; row: Rows[number] }>();
  return (
    projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runtimeRequests">,
  ): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    if (rows === previousRows && requests === previousRequests && previousResult)
      return previousResult;
    const byId = new Map(requests.map((request) => [request.id, request]));
    let result: Rows[number][] | undefined;
    for (const [index, row] of rows.entries()) {
      const item = row.item;
      const request =
        item.type === "user_input_request" && !item.questionAnswer
          ? byId.get(item.requestId)
          : undefined;
      let next = row;
      if (
        item.type === "user_input_request" &&
        request?.status === "resolved" &&
        request.answers !== undefined
      ) {
        const cached = cache.get(row);
        next =
          cached?.request === request
            ? cached.row
            : {
                ...row,
                item: {
                  ...item,
                  questionAnswer: {
                    requestId: request.id,
                    answers: request.answers,
                    attachmentsByQuestionId: {},
                    questionTextById: Object.fromEntries(
                      item.questions.map((question) => [question.id, question.question]),
                    ),
                  },
                },
              };
        cache.set(row, { request, row: next });
      }
      if (next !== row) result ??= rows.slice(0, index);
      result?.push(next);
    }
    previousRows = rows;
    previousRequests = requests;
    previousResult = result ?? rows;
    return previousResult;
  };
}
