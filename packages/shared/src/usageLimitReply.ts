import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Some ACP agents (GitHub Copilot) answer a turn they cannot run with their
 * limit notice as the reply, "Error: You have exceeded your monthly quota
 * (Request ID: …)", and end the prompt normally. These rules pick out that
 * reply, and only that reply: it opens like an error and the stop follows
 * the error prefix at once, followed only by known notice metadata. An
 * answer that reports a third-party limit is not the provider's own stop.
 * Shared so the server fails the turn on it and the timeline can show a
 * short notice instead of the raw reply.
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

/** The window the notice names, when it names one. */
function noticeWindow(text: string): "monthly" | "weekly" | "daily" | null {
  const match = /\b(monthly|weekly|daily)\b/iu.exec(text);
  return match === null ? null : (match[1]!.toLowerCase() as "monthly" | "weekly" | "daily");
}

/**
 * When the limit in a notice resets, if the notice says enough to know: a
 * monthly quota (GitHub Copilot's AI Credits) resets at 00:00 UTC on the 1st
 * of the next month. Null otherwise; a weekly or daily notice gives no anchor.
 */
export function usageLimitReplyResetAt(text: string, nowMs: number): string | null {
  if (!isUsageLimitReply(text) || noticeWindow(text) !== "monthly") return null;
  const now = DateTime.make(nowMs);
  if (Option.isNone(now)) return null;
  const { year, month } = DateTime.toPartsUtc(now.value);
  const reset = DateTime.makeUnsafe({
    year: month === 12 ? year + 1 : year,
    month: month === 12 ? 1 : month + 1,
    day: 1,
  });
  return DateTime.formatIso(reset);
}

/**
 * The short line shown for a limit notice reply instead of the raw text,
 * which carries an `Error:` prefix and a request id nobody needs.
 */
export function usageLimitReplyNotice(text: string): string | null {
  if (!isUsageLimitReply(text)) return null;
  switch (noticeWindow(text)) {
    case "monthly":
      return "Monthly quota used up on this provider.";
    case "weekly":
      return "Weekly limit used up on this provider.";
    case "daily":
      return "Daily limit used up on this provider.";
    default:
      return "Usage limit reached on this provider.";
  }
}
