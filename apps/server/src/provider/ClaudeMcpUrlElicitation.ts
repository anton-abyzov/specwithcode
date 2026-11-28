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
 * - One card per link of a tool call: a retry with the same link and message
 *   after the person said "I'm done" gets that answer back, and no new card.
 *   Any other link or message gets its own card, since the person never saw
 *   it. A Decline or Cancel holds for the whole call. Retries carry a new
 *   elicitation id, so the link and message are all that tell two asks apart:
 *   the same link and message again is the server asking the same thing, and
 *   is answered as a retry (AC-05). "I'm done" carries no data and opens
 *   nothing; what the person agrees to, they agree to at the linked site.
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
const REMEMBERED_LINKS_PER_CALL = 20;

/** What the person said to the links of one tool call. */
interface CallAnswers {
  refusal: ElicitationResult | undefined;
  readonly done: Set<string>;
}

const linkKey = (request: Pick<ElicitationRequest, "url" | "message">) =>
  JSON.stringify([request.url ?? "", request.message]);

/**
 * The person's answers per tool call, so a `-32042` retry of the same call gets
 * them again: a Decline or Cancel for every later link, "I'm done" only for
 * the same link and message. Only a key naming a tool call
 * (`<server>:call:<tool use id>`) is kept: a request that keys itself never
 * comes again.
 */
export function makeClaudeUrlAnswers() {
  const calls = new Map<string, CallAnswers>();
  return {
    get: (callKey: string, request: Pick<ElicitationRequest, "url" | "message">) => {
      const call = calls.get(callKey);
      if (call === undefined) return undefined;
      if (call.refusal !== undefined) return call.refusal;
      return call.done.has(linkKey(request)) ? ({ action: "accept" } as const) : undefined;
    },
    remember: (
      callKey: string,
      request: Pick<ElicitationRequest, "url" | "message">,
      result: ElicitationResult,
    ) => {
      if (!callKey.includes(":call:")) return;
      const call = calls.get(callKey) ?? { refusal: undefined, done: new Set<string>() };
      calls.delete(callKey);
      calls.set(callKey, call);
      if (calls.size > REMEMBERED_CALLS) calls.delete(calls.keys().next().value as string);
      if (result.action !== "accept") {
        call.refusal ??= result;
        return;
      }
      call.done.add(linkKey(request));
      if (call.done.size > REMEMBERED_LINKS_PER_CALL)
        call.done.delete(call.done.values().next().value as string);
    },
  };
}
