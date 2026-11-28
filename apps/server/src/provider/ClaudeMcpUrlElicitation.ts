/**
 * URL mode in a Claude thread (1498): an MCP server asks the person to open a
 * link, such as a sign-in, an API-key page or a payment confirmation. It asks
 * directly, or through error `-32042` (URL elicitation required), which Claude
 * Code retries up to 3 times.
 *
 * - The link is checked first (`@specweave-studio/shared/mcpElicitationUrl`).
 *   A link that is not `http` or `https`, or that has user info, is declined
 *   with a note and gets no card.
 * - A turn that runs without the person declines with a note: a delegated
 *   worker's or a routine's, or one an agent sent into the person's thread
 *   (1498 review). Only a person opens a link (D-02).
 * - Otherwise a card shows the link exactly as the server sent it. Only the
 *   person's Open link opens it, in their own browser; the server never opens,
 *   fetches or changes it, and adds nothing to it.
 * - The card's "I'm done, continue" is the server's `accept` with no content;
 *   Decline and Cancel are the same as a form's. The orchestrator takes only
 *   the person's own press (`ClaudeFormResponses.ts`).
 * - One card per tool call: a retry of the same link after the person
 *   answered gets that answer back, and no new card. A retry with another
 *   link gets a new card if the person said "I'm done", since they never saw
 *   that link; a Decline or Cancel still holds for the whole call.
 *
 * @module ClaudeMcpUrlElicitation
 */
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2McpElicitation,
  ProviderApprovalDecision,
} from "@specweave-studio/contracts";

import type * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
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
  `${serverName} asked you to open a link, but this turn runs without you, so it was declined.`;

/**
 * The person did not start this turn: the thread is a worker's or a routine's,
 * or an agent sent the message into the person's own thread.
 */
export function isClaudeTurnWithoutPerson(
  input: ProviderAdapter.ProviderAdapterV2TurnInput,
): boolean {
  return (
    input.appThread.createdBy !== "user" ||
    input.message.scheduledTaskId !== undefined ||
    input.message.createdBy !== "user"
  );
}

/** The person's answer to one link of a tool call. */
export interface ClaudeUrlAnswer {
  readonly url: string;
  readonly result: ElicitationResult;
}

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
  options: { readonly unattended: boolean; readonly remembered: ClaudeUrlAnswer | undefined },
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
  const remembered = options.remembered;
  // "I'm done" counts only for the link the person saw; a refusal holds for the call.
  if (
    remembered !== undefined &&
    (remembered.result.action !== "accept" || remembered.url === checked.link.url)
  )
    return { type: "answer", result: remembered.result };
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
  const answers = new Map<string, ClaudeUrlAnswer>();
  return {
    get: (callKey: string) => answers.get(callKey),
    remember: (callKey: string, answer: ClaudeUrlAnswer) => {
      if (!callKey.includes(":call:")) return;
      answers.delete(callKey);
      answers.set(callKey, answer);
      if (answers.size > REMEMBERED_CALLS) answers.delete(answers.keys().next().value as string);
    },
  };
}
