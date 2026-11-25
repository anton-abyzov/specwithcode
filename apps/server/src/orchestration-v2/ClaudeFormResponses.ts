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

const handedOff = new Map<string, ProviderUserInputAnswers>();

/** Holds a person's validated answers for the adapter that is waiting for them. */
export function handOffClaudeFormAnswers(
  requestId: RuntimeRequestId,
  answers: ProviderUserInputAnswers | undefined,
): void {
  if (answers !== undefined) handedOff.set(requestId, answers);
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
}

/** Which fields were answered, never what was entered. */
export function redactClaudeFormAnswers(
  answers: ProviderUserInputAnswers,
): ProviderUserInputAnswers {
  return Object.fromEntries(Object.keys(answers).map((key) => [key, REDACTED_FORM_ANSWER]));
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
  item: OrchestrationV2TurnItem | undefined,
  status: string,
  command: {
    readonly decision?: ProviderApprovalDecision | undefined;
    readonly answers?: ProviderUserInputAnswers | undefined;
    readonly answeredByThreadId?: ThreadId | undefined;
  },
): ClaudeFormResponseCheck | undefined {
  const form = claudeFormOf(item);
  if (form === undefined) return undefined;
  if (status === "resolved") return { refusal: FORM_ALREADY_ANSWERED };
  if (status !== "pending") return { refusal: FORM_CLOSED };
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
