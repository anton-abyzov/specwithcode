import type { OrchestrationV2ProviderFailure } from "@specweave-studio/contracts";

import { makeProviderFailure } from "../ProviderFailure.ts";

/**
 * Some ACP agents (GitHub Copilot) answer a turn they cannot run with their
 * limit notice as the reply, "Error: You have exceeded your monthly quota
 * (Request ID: …)", and end the prompt normally. Read as a completed turn,
 * nothing moves the thread off the provider. These rules pick out that
 * reply, and only that reply: it opens like an error and the stop follows
 * the error prefix at once, followed only by known notice metadata. An
 * answer that reports a third-party limit is not the provider's own stop.
 */

/** Longest reply read as a limit notice; the notices seen are under 120 characters. */
export const MAX_LIMIT_REPLY_LENGTH = 400;

/** `Error:`, `API Error:`, `Error 429 -`, `[Error]`, and the space after it. */
const ERROR_OPENING = /^(?:\[\s*error\s*\]|(?:api\s+)?error(?:\s+\d{3})?\s*[:\-–—])\s*/iu;

/**
 * What ran out. A bare "limit" is left out on purpose: context, recursion and
 * token limits are no usage limit and another provider would not help.
 */
const LIMIT_NOUN =
  "(?:quota|allowance|credits?|(?:usage|rate|session|weekly|monthly|daily|hourly|plan|spending|billing|request|premium\\s+request)[\\s-]limits?)";

/** Account-window wording, never an arbitrary service name such as "GitHub API". */
const LIMIT_MODIFIER = "(?:(?:monthly|weekly|daily|hourly|premium(?:\\s+request)?|request)\\s+)?";

/** The agent's own stop, right after the error prefix. */
const LIMIT_STOP_HEAD: ReadonlyArray<RegExp> = [
  // "You have exceeded your monthly quota", "You've hit your session limit", "You have run out of credits"
  new RegExp(
    `^you(?:'ve|’ve|\\s+have)?\\s+(?:exceeded|reached|hit|used\\s+up|run\\s+out\\s+of|ran\\s+out\\s+of)\\s+(?:your\\s+${LIMIT_MODIFIER})?${LIMIT_NOUN}(?![\\w-])`,
    "iu",
  ),
  // "rate limit exceeded", "Your premium request allowance has been exhausted"
  new RegExp(
    `^(?:your\\s+)?${LIMIT_MODIFIER}${LIMIT_NOUN}\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:exceeded|reached|exhausted)\\b`,
    "iu",
  ),
  // Provider codes some agents print as the reply.
  /^(?:\d{3}\s+)?(?:insufficient_quota|resource_exhausted|rate_limit_exceeded|usage_limit_exceeded)\b/iu,
];

/**
 * Accept the entire notice, not just its opening. A service attribution,
 * explanation, or another assistant segment must not become a provider stop.
 */
const LIMIT_NOTICE_END: ReadonlyArray<RegExp> = [
  /^[.!]?$/u,
  /^for\s+(?:this|your)\s+account[.!]?$/iu,
  /^(?:[.!]\s*)?\(request id:\s*[a-z\d:_-]+\)[.!]?$/iu,
  /^(?:[·;,.—–-]\s*)?resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?(?:\s*[ap]m)?(?:\s*\([a-z_+-]+(?:\/[a-z_+-]+)*\))?[.!]?$/iu,
];

/** The agent speaking for itself ("I'll retry", "let me"): an answer, never a provider notice. */
const FIRST_PERSON =
  /(?<![\w'’])(?:I(?:['’](?:ll|m|ve|d))?|[Ll]et me|[Ww]e(?:['’](?:ll|re|ve))?)(?![\w'’])/u;

/**
 * Whether `text`, the whole reply of a turn that did no work, is a usage
 * limit, quota or rate limit notice: short, opening like an error with the
 * stop right after the prefix, and not in the agent's own voice.
 */
export function isUsageLimitReply(text: string): boolean {
  const reply = text.trim();
  if (reply.length === 0 || reply.length > MAX_LIMIT_REPLY_LENGTH) return false;
  const opening = ERROR_OPENING.exec(reply);
  if (opening === null || FIRST_PERSON.test(reply)) return false;
  const rest = reply.slice(opening[0].length);
  return LIMIT_STOP_HEAD.some((pattern) => {
    const stop = pattern.exec(rest);
    if (stop === null) return false;
    const ending = rest.slice(stop[0].length).trim();
    return LIMIT_NOTICE_END.some((suffix) => suffix.test(ending));
  });
}

/**
 * The run failure for such a reply: a usage limit with the agent's own text,
 * so the limit fallback moves the thread on. The notice gives no reset time,
 * and no code: a request id is not one.
 */
export function usageLimitReplyFailure(text: string): OrchestrationV2ProviderFailure | null {
  if (!isUsageLimitReply(text)) return null;
  return makeProviderFailure({ message: text.trim(), code: null, class: "usage_limit" });
}

/** What a finished turn did, as far as reading a limit reply goes. */
export interface LimitReplyTurn {
  /** The text of the message that started the turn. */
  readonly messageText: string;
  /** The turn attached to wake traffic the agent produced on its own: no prompt reached it. */
  readonly continuation: boolean;
  /** Tool calls (file edits included) or subagents ran this turn. */
  readonly didWork: boolean;
  /** The root assistant text of the turn, segment by segment. */
  readonly assistantText: ReadonlyArray<string>;
}

/**
 * The usage limit failure for a turn whose whole reply is the agent's limit
 * notice; null for anything else. A provider stops on its quota in answer to
 * a prompt, so a continuation (its reply reports work an earlier turn
 * started) and a slash command (`/usage` describes the account) never count.
 */
export function limitReplyTurnFailure(turn: LimitReplyTurn): OrchestrationV2ProviderFailure | null {
  if (turn.didWork || turn.continuation || turn.messageText.trimStart().startsWith("/"))
    return null;
  const segments = turn.assistantText.map((text) => text.trim()).filter((text) => text.length > 0);
  return usageLimitReplyFailure(segments.join("\n"));
}
