import type { OrchestrationV2ProviderFailure } from "@specweave-studio/contracts";

import {
  usageLimitReplyNotice,
  usageLimitReplyResetAt,
} from "@specweave-studio/shared/usageLimitReply";

import { makeProviderFailure } from "../ProviderFailure.ts";

export {
  isUsageLimitReply,
  MAX_LIMIT_REPLY_LENGTH,
} from "@specweave-studio/shared/usageLimitReply";

/**
 * The run failure for such a reply: a usage limit with a short notice in
 * place of the agent's raw text, so the limit fallback moves the thread on
 * and the person reads one clear line. A monthly quota names its reset (the
 * 1st of next month, UTC), which keeps the provider held until then; any
 * other notice gives no reset. No code: a request id is not one.
 */
export function usageLimitReplyFailure(
  text: string,
  nowMs: number | null = null,
): OrchestrationV2ProviderFailure | null {
  const notice = usageLimitReplyNotice(text);
  if (notice === null) return null;
  return makeProviderFailure({
    message: notice,
    code: null,
    class: "usage_limit",
    resetAt: nowMs === null ? null : usageLimitReplyResetAt(text, nowMs),
  });
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
  /** When the turn ended; the reset of a monthly quota is counted from it. */
  readonly nowMs?: number;
}

/**
 * The usage limit failure for a turn whose reply ends on the agent's limit
 * notice; null for anything else. A provider stops on its quota in answer to
 * a prompt, so a continuation (its reply reports work an earlier turn
 * started) and a slash command (`/usage` describes the account) never count.
 * A turn that did no work must reply with the notice alone. One that worked
 * first (Copilot runs out of premium requests mid-turn) counts when its last
 * segment is the notice alone: the limit stopped the work.
 */
export function limitReplyTurnFailure(turn: LimitReplyTurn): OrchestrationV2ProviderFailure | null {
  if (turn.continuation || turn.messageText.trimStart().startsWith("/")) return null;
  const segments = turn.assistantText.map((text) => text.trim()).filter((text) => text.length > 0);
  const reply = turn.didWork ? (segments.at(-1) ?? "") : segments.join("\n");
  return usageLimitReplyFailure(reply, turn.nowMs ?? null);
}

/**
 * The usage limit failure for an agent's error (a JSON-RPC error on
 * session/prompt) whose message is a limit notice, with or without an
 * `Error:` prefix; null for any other error.
 */
export function usageLimitErrorFailure(
  message: string,
  nowMs: number | null = null,
): OrchestrationV2ProviderFailure | null {
  const text = message.trim();
  return usageLimitReplyFailure(text, nowMs) ?? usageLimitReplyFailure(`Error: ${text}`, nowMs);
}
