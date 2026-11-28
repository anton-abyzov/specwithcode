/**
 * URL mode in a Claude thread (1498): an MCP server asks the person to open a
 * link, such as a sign-in, an API-key page or a payment confirmation. It asks
 * directly, or through error `-32042` (URL elicitation required), which Claude
 * Code retries up to 3 times.
 *
 * - The link is checked first (`@specweave-studio/shared/mcpElicitationUrl`).
 *   A link that is not `http` or `https`, or that has user info, is declined
 *   with a note and gets no card.
 * - A thread that runs without the person (a delegated worker, a routine)
 *   declines with a note: only a person opens a link (D-02).
 * - Otherwise a card shows the link exactly as the server sent it. Only the
 *   person's Open link opens it, in their own browser; the server never opens,
 *   fetches or changes it, and adds nothing to it.
 * - The card's "I'm done, continue" is the server's `accept` with no content;
 *   Decline and Cancel are the same as a form's. The orchestrator takes only
 *   the person's own press (`ClaudeFormResponses.ts`).
 * - One card per tool call: a retry after the person answered gets that
 *   answer back, and no new card.
 *
 * @module ClaudeMcpUrlElicitation
 */
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2McpElicitation,
  ProviderApprovalDecision,
} from "@specweave-studio/contracts";
import {
  checkMcpElicitationUrl,
  type McpElicitationUrlRefusal,
} from "@specweave-studio/shared/mcpElicitationUrl";

const REFUSAL_REASON: Record<McpElicitationUrlRefusal, string> = {
  scheme: "isn't a web link",
  "user-info": "hides where it goes behind a user name",
  "too-long": "is too long to show",
  unparseable: "can't be read",
};

export const urlRefusedNotice = (serverName: string, reason: McpElicitationUrlRefusal) =>
  `${serverName} asked you to open a link that ${REFUSAL_REASON[reason]}. SpecWithCode doesn't show links like that, so it was declined.`;
export const urlUnattendedNotice = (serverName: string) =>
  `${serverName} asked you to open a link, but this thread runs without you, so it was declined.`;

/** What to do with a URL request: answer it now, or show its card. */
export type ClaudeUrlPlan =
  | { readonly type: "answer"; readonly result: ElicitationResult; readonly notice?: string }
  | { readonly type: "card"; readonly elicitation: OrchestrationV2McpElicitation };

const DECLINE: ElicitationResult = { action: "decline" };

/**
 * The checks above, in order: the link, the thread, then the person's answer
 * to an earlier try of the same tool call.
 */
export function planClaudeUrlElicitation(
  request: ElicitationRequest,
  options: { readonly unattended: boolean; readonly remembered: ElicitationResult | undefined },
): ClaudeUrlPlan {
  const checked = checkMcpElicitationUrl(request.url);
  if (!checked.ok)
    return {
      type: "answer",
      result: DECLINE,
      notice: urlRefusedNotice(request.serverName, checked.reason),
    };
  if (options.unattended)
    return { type: "answer", result: DECLINE, notice: urlUnattendedNotice(request.serverName) };
  if (options.remembered !== undefined) return { type: "answer", result: options.remembered };
  return {
    type: "card",
    elicitation: {
      serverName: request.serverName,
      mode: "url",
      message: request.message,
      url: checked.link.url,
    },
  };
}

/** What the server gets for the person's press on a URL card. */
export function urlElicitationResult(decision: ProviderApprovalDecision): ElicitationResult {
  switch (decision) {
    case "decline":
      return DECLINE;
    case "cancel":
      return { action: "cancel" };
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return { action: "accept" };
  }
}

const REMEMBERED_CALLS = 200;

/**
 * The person's answer per tool call, so a `-32042` retry of the same call gets
 * it again. Only a key naming a tool call (`<server>:call:<tool use id>`) is
 * kept: a request that keys itself never comes again.
 */
export function makeClaudeUrlAnswers() {
  const answers = new Map<string, ElicitationResult>();
  return {
    get: (callKey: string) => answers.get(callKey),
    remember: (callKey: string, result: ElicitationResult) => {
      if (!callKey.includes(":call:")) return;
      answers.delete(callKey);
      answers.set(callKey, result);
      if (answers.size > REMEMBERED_CALLS) answers.delete(answers.keys().next().value as string);
    },
  };
}
