/**
 * The rules for answering an MCP server's form in a Claude thread (1481),
 * applied where every answer passes: the orchestrator's `runtime-request.respond`.
 *
 * - Only the person answers one: an agent (`answeredByThreadId`) is refused, and
 *   an accept without the card's own answers (Full access, any automatic
 *   responder) is refused, even for a form without fields.
 * - Answers are checked against the form's bounded schema before the request
 *   resolves; a bad answer leaves the card open with the reason.
 * - Raw answers stay out of durable records: the resolved request and the
 *   effect carry a redacted summary, and the raw answers reach the Claude
 *   adapter through an in-process hand-off. A restart loses the hand-off, but
 *   it also ends the Claude process that was waiting for it.
 */
import type {
  OrchestrationV2McpElicitation,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  parseMcpElicitationSchema,
  validateMcpElicitationContent,
} from "@specweave-studio/shared/mcpElicitationForm";

/** What a redacted answer reads as in the thread's records. */
export const REDACTED_FORM_ANSWER = "[redacted]";

export const FORM_AGENT_REFUSAL = "Only the user can answer this form. Wait for their answer.";
export const FORM_NEEDS_CARD = "Submit this form from its card in the thread.";
export const FORM_ALREADY_ANSWERED = "This form was already answered.";
export const FORM_CLOSED = "This form was closed.";
export const FORM_OPENING = "This form is still opening. Try again in a moment.";

/** The prefix of the native id the Claude adapter gives an MCP form's request. */
export const CLAUDE_FORM_NATIVE_PREFIX = "mcp-elicitation:";

const handedOff = new Map<string, ProviderUserInputAnswers>();
// Forms whose answer the app has recorded and is delivering to the adapter.
const answered = new Set<string>();
// Forms the adapter is closing after a Stop or the timer (1493). Kept after
// the call ends, until the cancelled card has surely landed; bounded like the
// adapter's own closed set.
const closing = new Set<string>();
const CLOSING_KEPT = 200;
// Answered forms whose commit finished; one not here is still committing.
const committed = new Set<string>();
// A call waiting, after Stop or the timer, for its answer's commit (1493).
const outcomeWaiters = new Map<string, (outcome: ClaudeFormCommitOutcome) => void>();

/** Where the answer the app recorded for a form stands. */
export type ClaudeFormCommitOutcome = "committed" | "failed" | "pending";

function markClosing(requestId: string): void {
  closing.add(requestId);
  if (closing.size > CLOSING_KEPT) closing.delete(closing.values().next().value as string);
}

/**
 * Notes that the app recorded an answer to a Claude form, and holds the
 * person's validated content for the adapter that is waiting for it. Called
 * as the answer is recorded, before its delivery is queued, so a Stop or the
 * unattended timer that fires in between knows an answer is on its way.
 * Returns false, recording nothing, when the adapter already began closing
 * the form: the answer is then refused, never recorded as resolved.
 */
export function handOffClaudeFormAnswers(
  requestId: RuntimeRequestId,
  check: ClaudeFormResponseCheck | undefined,
): boolean {
  if (check === undefined) return true;
  if (closing.has(requestId)) return false;
  answered.add(requestId);
  if (check.handOff !== undefined) handedOff.set(requestId, check.handOff);
  return true;
}

/**
 * The adapter's side of the same choice: after a Stop or the timer, marks the
 * form as closing unless the app already recorded an answer to it. Returns
 * true when the adapter should close the card. This and the hand-off above
 * each run without yielding, so exactly one of them wins.
 */
export function beginClosingClaudeForm(requestId: RuntimeRequestId): boolean {
  if (answered.has(requestId)) return false;
  markClosing(requestId);
  return true;
}

/**
 * Whether the answer handed off for this form committed, failed (or was never
 * handed off), or is still committing. A call whose answer never arrived
 * waits for "pending" to settle before it ends, so it closes the card itself
 * while its events still reach the thread (1493).
 */
export function claudeFormCommitOutcome(requestId: RuntimeRequestId): ClaudeFormCommitOutcome {
  if (!answered.has(requestId)) return "failed";
  return committed.has(requestId) ? "committed" : "pending";
}

/** Calls `notify` once the commit settles; returns the unsubscribe. */
export function onClaudeFormCommitOutcome(
  requestId: RuntimeRequestId,
  notify: (outcome: ClaudeFormCommitOutcome) => void,
): () => void {
  outcomeWaiters.set(requestId, notify);
  return () => {
    if (outcomeWaiters.get(requestId) === notify) outcomeWaiters.delete(requestId);
  };
}

/** Notes that a `runtime-request.respond` committed; its answer is recorded. */
export function markClaudeFormAnswerCommitted(command: {
  readonly type: string;
  readonly requestId?: string;
}): void {
  if (command.type !== "runtime-request.respond" || command.requestId === undefined) return;
  if (!answered.has(command.requestId)) return;
  committed.add(command.requestId);
  outcomeWaiters.get(command.requestId)?.("committed");
}

/**
 * Forgets the answer a `runtime-request.respond` handed off when its commit
 * failed or was rejected: nothing is on its way, so a later Stop or the timer
 * closes the card instead of waiting for it (1493).
 */
export function forgetUncommittedFormAnswer(command: {
  readonly type: string;
  readonly requestId?: string;
}): void {
  if (command.type !== "runtime-request.respond" || command.requestId === undefined) return;
  handedOff.delete(command.requestId);
  answered.delete(command.requestId);
  committed.delete(command.requestId);
  const waiter = outcomeWaiters.get(command.requestId);
  if (waiter === undefined) return;
  // A call is waiting to close the card: refuse a Submit queued behind this
  // commit at once, before the call wakes.
  markClosing(command.requestId);
  waiter("failed");
}

/** The app has recorded an answer to this form that may not have arrived yet. */
export function isClaudeFormAnswered(requestId: RuntimeRequestId): boolean {
  return answered.has(requestId);
}

/** The raw answers for a request, once; later calls get nothing. */
export function takeClaudeFormAnswers(
  requestId: RuntimeRequestId,
): ProviderUserInputAnswers | undefined {
  const answers = handedOff.get(requestId);
  handedOff.delete(requestId);
  return answers;
}

/** Forgets a closed card's answers that nothing took. */
export function dropClaudeFormAnswers(requestId: RuntimeRequestId): void {
  handedOff.delete(requestId);
  answered.delete(requestId);
  committed.delete(requestId);
  outcomeWaiters.delete(requestId);
}

/** Which fields were answered, never what was entered. */
export function redactClaudeFormAnswers(
  answers: ProviderUserInputAnswers,
): ProviderUserInputAnswers {
  return Object.fromEntries(Object.keys(answers).map((key) => [key, REDACTED_FORM_ANSWER]));
}

/** A request the Claude adapter raised for an MCP server's form. */
export function isClaudeFormRequest(request: OrchestrationV2RuntimeRequest): boolean {
  return (
    request.kind === "mcp-elicitation" &&
    request.nativeRequestRef?.driver === "claudeAgent" &&
    (request.nativeRequestRef.nativeId ?? "").startsWith(CLAUDE_FORM_NATIVE_PREFIX)
  );
}

/** The form a Claude MCP card shows; Codex elicitations carry none. */
export function claudeFormOf(
  item: OrchestrationV2TurnItem | undefined,
): OrchestrationV2McpElicitation | undefined {
  return item?.type === "approval_request" &&
    item.requestKind === "mcp-elicitation" &&
    item.elicitation?.mode === "form"
    ? item.elicitation
    : undefined;
}

export interface ClaudeFormResponseCheck {
  /** Set when the answer is refused; the card stays open. */
  readonly refusal?: string;
  /** What the request records: a redacted summary, or nothing. */
  readonly storedAnswers?: ProviderUserInputAnswers;
  /** The validated content for the adapter, handed off in process. */
  readonly handOff?: ProviderUserInputAnswers;
}

/**
 * The rules above for one `runtime-request.respond` to a request in `status`;
 * undefined for any other card. A second answer, from another machine or a
 * second click, finds the request resolved and is told so.
 */
export function checkFormResponse(
  context: {
    readonly request: OrchestrationV2RuntimeRequest;
    readonly item?: OrchestrationV2TurnItem | undefined;
  },
  command: {
    readonly decision?: ProviderApprovalDecision | undefined;
    readonly answers?: ProviderUserInputAnswers | undefined;
    readonly answeredByThreadId?: ThreadId | undefined;
  },
): ClaudeFormResponseCheck | undefined {
  const { request, item } = context;
  const form = claudeFormOf(item);
  // The Claude adapter records the request before its card: until the card
  // lands, the request is still a form, and only Decline or Cancel go through.
  if (form === undefined) {
    if (!isClaudeFormRequest(request)) return undefined;
    if (request.status !== "pending")
      return { refusal: request.status === "resolved" ? FORM_ALREADY_ANSWERED : FORM_CLOSED };
    return command.decision === "decline" || command.decision === "cancel"
      ? {}
      : { refusal: FORM_OPENING };
  }
  const status = request.status;
  if (status === "resolved") return { refusal: FORM_ALREADY_ANSWERED };
  if (status !== "pending" || closing.has(request.id)) return { refusal: FORM_CLOSED };
  if (command.answeredByThreadId !== undefined) return { refusal: FORM_AGENT_REFUSAL };
  if (command.decision === "decline" || command.decision === "cancel") return {};
  if (command.answers === undefined) return { refusal: FORM_NEEDS_CARD };
  const parsed = parseMcpElicitationSchema(form.requestedSchema);
  if (!parsed.ok) return { refusal: FORM_CLOSED };
  const checked = validateMcpElicitationContent(parsed.fields, command.answers);
  if (!checked.ok) {
    const [key, error] = Object.entries(checked.errors)[0] ?? ["", "Check the form."];
    const title = parsed.fields.find((field) => field.key === key)?.title ?? key;
    return { refusal: `${title}: ${error}` };
  }
  const content = checked.content as ProviderUserInputAnswers;
  return { storedAnswers: redactClaudeFormAnswers(content), handOff: content };
}
