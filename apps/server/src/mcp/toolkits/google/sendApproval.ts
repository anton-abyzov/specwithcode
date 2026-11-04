// @effect-diagnostics-next-line nodeBuiltinImport:off - a pure, synchronous id hash; Effect Crypto would make the id builder effectful.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2UserInputQuestion,
  type ProjectId,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as Google from "../../../integrations/google/GoogleAccountService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * The reply card: one question per saved Gmail draft, Send or Don't send. It
 * is a question card like ask_user's, so the thread waits on the person and
 * they are alerted. A draft is sent only when this card, in the same thread,
 * was answered Send for it; the agent's word is never enough.
 */

export const SEND_LABEL = "Send";
export const SKIP_LABEL = "Don't send";
export const MAX_DRAFTS_PER_CARD = 5;
const REOPEN_PREFIX = "update-reopen:";

const part = (value: string) => encodeURIComponent(value);

/** One card per thread and set of drafts, so a retry finds the card it made. */
export function sendRequestId(threadId: string, draftIds: ReadonlyArray<string>): RuntimeRequestId {
  const digest = NodeCrypto.createHash("sha256")
    .update([...draftIds].toSorted().join(","))
    .digest("hex")
    .slice(0, 16);
  return RuntimeRequestId.make(`gmail-send:v2:${part(threadId)}:${digest}`);
}

export const draftQuestionId = (draftId: string, snapshotId: string) =>
  `draft:${draftId}:snapshot:${snapshotId}`;

export interface CardDraft {
  readonly draftId: string;
  readonly snapshotId: string;
  readonly headers: string;
  /** The address it is sent from; named on the card so the person sees which mailbox. */
  readonly from?: string | null | undefined;
  readonly to: string | null;
  readonly subject: string | null;
  readonly body: string;
}

const HEADER_LIMIT = 120;

/** "Reply to X from Y", shortening the recipient so the sending mailbox always shows. */
function sendHeader(draft: CardDraft): string {
  const from = draft.from ? ` from ${draft.from}` : "";
  const room = Math.max(HEADER_LIMIT - "Reply to ".length - from.length, 12);
  const to = draft.to ?? "unknown recipient";
  return `Reply to ${to.length > room ? `${to.slice(0, room - 1)}…` : to}${from}`;
}

export function sendQuestions(
  drafts: ReadonlyArray<CardDraft>,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  return drafts.map((draft) => {
    const fence = "`".repeat(
      Math.max(
        3,
        ...[...draft.body.matchAll(/`+/gu), ...draft.headers.matchAll(/`+/gu)].map(
          (match) => match[0].length + 1,
        ),
      ),
    );
    return {
      id: draftQuestionId(draft.draftId, draft.snapshotId),
      header: sendHeader(draft),
      question: `Send this exact copy from ${draft.from}? The original draft will remain in Gmail after sending.\n\n${fence}text\n${draft.headers}\n\n${draft.body}\n${fence}`,
      options: [
        {
          label: SEND_LABEL,
          description: draft.from
            ? `Send this exact copy from ${draft.from}; keep the original draft.`
            : "Send this reply from your Gmail now.",
        },
        {
          label: SKIP_LABEL,
          description: "Keep it as a draft in Gmail. To change it, reply in chat instead.",
        },
      ],
      allowCustomAnswer: true,
    };
  });
}

/** The card's id without the prefixes an update adds when it reopens a card. */
const baseRequestId = (id: string) => {
  let base = id;
  while (base.startsWith(REOPEN_PREFIX)) base = base.slice(REOPEN_PREFIX.length);
  return base;
};

/**
 * A reply card, also as an update reopened it. Only the person answers one:
 * studio_pending_request_respond refuses it, so no agent can approve its own send.
 */
export const isGmailSendRequestId = (id: string) => baseRequestId(id).startsWith("gmail-send:");

const answeredSend = (answer: unknown) =>
  answer === SEND_LABEL ||
  (Array.isArray(answer) && answer.length === 1 && answer[0] === SEND_LABEL);

/**
 * Whether the person answered Send for this draft on this thread's card.
 * Returns null when they did, else why the draft may not be sent.
 */
export function sendRefusal(input: {
  readonly threadId: string;
  readonly approvalRequestId: string;
  readonly draftId: string;
  readonly snapshotId: string;
  readonly requests: ReadonlyArray<
    Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "status" | "answers">
  >;
}): string | null {
  const base = baseRequestId(input.approvalRequestId);
  if (!base.startsWith(`gmail-send:v2:${part(input.threadId)}:`)) {
    return "That is not a reply card from this thread. Show the draft with studio_google_gmail_propose_send first.";
  }
  const cards = input.requests.filter(
    (request) => request.kind === "user_input" && baseRequestId(request.id) === base,
  );
  if (cards.length === 0) return "That reply card was not found in this thread.";
  const questionId = draftQuestionId(input.draftId, input.snapshotId);
  const answered = cards.filter(
    (card) => card.status === "resolved" && card.answers?.[questionId] !== undefined,
  );
  if (answered.length === 0) {
    return cards.some((card) => card.status === "pending")
      ? "The person has not answered the reply card yet. End your turn; their answer arrives as a message."
      : "The reply card has no answer for that draft. Nothing was sent.";
  }
  // A card family holds at most one answer: an update reopens only a card left unanswered.
  return answered.some((card) => answeredSend(card.answers?.[questionId]))
    ? null
    : "The person did not choose Send for that draft. Nothing was sent; it stays in Gmail as a draft.";
}

const failure = (
  message: string,
  code: "invalid_request" | "capability_denied" = "invalid_request",
) => new OrchestratorMcpFailure({ code, message });

const callerRecords = Effect.fn("mcp.google.sendCallerRecords")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = scope.thread;
  if (thread === undefined) {
    return yield* failure(
      `${operation} needs an agent running inside a SpecWithCode thread.`,
      "capability_denied",
    );
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads
    .getThreadRecords(thread.threadId, ["runs", "runtimeRequests"], {
      turnItemTypes: [],
      messageRoles: [],
    })
    .pipe(Effect.mapError(() => failure("The calling thread could not be read.")));
  return { scope, thread, threads, records };
});

/** Reads each draft from Gmail and shows the card in the calling thread. */
export const proposeSend = Effect.fn("mcp.google.proposeSend")(function* (
  service: Google.GoogleAccountService["Service"],
  projectId: ProjectId,
  draftIds: ReadonlyArray<string>,
) {
  const unique = [...new Set(draftIds)];
  if (unique.length === 0) return yield* failure("Name at least one draft to propose.");
  if (unique.length > MAX_DRAFTS_PER_CARD) {
    return yield* failure(`One card holds at most ${MAX_DRAFTS_PER_CARD} drafts.`);
  }
  const { scope, thread, threads, records } = yield* callerRecords("Proposing a reply");
  const threadId: ThreadId = thread.threadId;
  const drafts = yield* Effect.forEach(unique, (draftId) =>
    service
      .gmailPrepareSend(projectId, threadId, draftId)
      .pipe(Effect.mapError((error) => failure(`Draft ${draftId}: ${error.detail}`))),
  );
  const requestId = sendRequestId(
    threadId,
    drafts.map((draft) => draft.snapshotId),
  );
  // A card an update reopened is the one still waiting; prefer it to the closed original.
  const family = records.runtimeRequests.filter(
    (request) => baseRequestId(request.id) === requestId,
  );
  const existing =
    family.find((request) => request.status === "pending") ??
    family.find((request) => request.status === "resolved") ??
    family.at(-1);
  if (existing !== undefined) {
    return {
      approvalRequestId: existing.id,
      status:
        existing.status === "pending"
          ? ("asked" as const)
          : existing.status === "resolved"
            ? ("answered" as const)
            : ("dismissed" as const),
    };
  }
  const run = ThreadManagement.latestActiveRun(records);
  if (
    run === undefined ||
    run.rootNodeId === null ||
    run.providerInstanceId !== thread.providerInstanceId
  ) {
    return yield* failure(
      "Showing the reply card needs a live turn of this thread. List the drafts in your reply instead.",
    );
  }
  const suffix = requestId.slice("gmail-send:".length);
  yield* threads
    .dispatch({
      type: "user_input_request.record",
      commandId: CommandId.make(
        `command:mcp:${part(scope.requestNamespace)}:gmail-propose-send:${part(suffix)}`,
      ),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      requestNodeId: NodeId.make(`node:gmail-send:${suffix}`),
      requestId,
      turnItemId: TurnItemId.make(`turn-item:gmail-send:${suffix}`),
      questions: sendQuestions(drafts),
    })
    .pipe(Effect.mapError(() => failure("Could not show the reply card.")));
  return {
    approvalRequestId: requestId,
    status: "asked" as const,
    drafts: drafts.map((draft) => ({
      draftId: draft.draftId,
      from: draft.from,
      to: draft.to,
      subject: draft.subject,
    })),
  };
});

/** Sends one draft the person answered Send for on this thread's card. */
export const sendApproved = Effect.fn("mcp.google.sendApproved")(function* (
  service: Google.GoogleAccountService["Service"],
  projectId: ProjectId,
  input: { readonly draftId: string; readonly approvalRequestId: string },
) {
  const { thread, records } = yield* callerRecords("Sending a reply");
  const base = baseRequestId(input.approvalRequestId);
  const prefix = `draft:${input.draftId}:snapshot:`;
  const snapshotIds = [
    ...new Set(
      records.runtimeRequests
        .filter((request) => baseRequestId(request.id) === base)
        .flatMap((request) => Object.keys(request.answers ?? {}))
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length)),
    ),
  ];
  const snapshotId = snapshotIds[0];
  if (snapshotIds.length !== 1 || !snapshotId || !/^[a-f0-9]{64}$/u.test(snapshotId))
    return yield* failure(
      "Show a new reply card; this card has no immutable message snapshot.",
      "capability_denied",
    );
  const refused = sendRefusal({
    threadId: thread.threadId,
    approvalRequestId: input.approvalRequestId,
    draftId: input.draftId,
    snapshotId,
    requests: records.runtimeRequests,
  });
  if (refused !== null) return yield* failure(refused, "capability_denied");
  return yield* service
    .gmailSendDraft(projectId, input.draftId, thread.threadId, snapshotId)
    .pipe(Effect.mapError((error) => failure(error.detail)));
});
