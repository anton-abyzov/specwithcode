/**
 * When the "Star on GitHub" card may show, and what each answer leaves behind (1489).
 *
 * Fair by construction: it asks only after real use, at most three times with growing gaps,
 * never again after a star, an "Already starred" or the Settings switch, and it never stars for
 * anyone. Pure: callers pass the clock.
 */
import {
  GITHUB_STAR_PROMPT_MAX_ASKS,
  type GitHubStarPrompt,
  type GitHubStarUsage,
} from "@specweave-studio/contracts";

/** Threads with a started turn before the first ask. */
export const STAR_PROMPT_MIN_THREADS = 5;
/** Days since this device's first started turn before the first ask. */
export const STAR_PROMPT_MIN_DAYS = 3;
/** Wait after the first and second "Not now". The third ask is the last. */
export const STAR_PROMPT_BACKOFF_DAYS = [14, 30] as const;
/** Quiet time with the window focused before the card appears. */
export const STAR_PROMPT_QUIET_MS = 15_000;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Records one started turn; returns null when nothing changes, so no write is made. */
export function noteStartedTurn(
  usage: GitHubStarUsage,
  threadKey: string,
  now: number,
): GitHubStarUsage | null {
  const firstUsedAt = usage.firstUsedAt ?? new Date(now).toISOString();
  const known = usage.threadKeys.includes(threadKey);
  const full = usage.threadKeys.length >= STAR_PROMPT_MIN_THREADS;
  if (usage.firstUsedAt !== null && (known || full)) return null;
  return {
    firstUsedAt,
    threadKeys: known || full ? usage.threadKeys : [...usage.threadKeys, threadKey.slice(0, 256)],
  };
}

/** Whether the card may show now, before the quiet-window and starred checks. */
export function isStarPromptDue(
  prompt: GitHubStarPrompt,
  usage: GitHubStarUsage,
  now: number,
): boolean {
  if (prompt.status !== "asking") return false;
  if (prompt.asks >= GITHUB_STAR_PROMPT_MAX_ASKS) return false;
  if (usage.threadKeys.length < STAR_PROMPT_MIN_THREADS) return false;
  const firstUsed = parseTime(usage.firstUsedAt);
  if (firstUsed === null || now - firstUsed < STAR_PROMPT_MIN_DAYS * DAY_MS) return false;
  const nextAsk = parseTime(prompt.nextAskAt);
  return nextAsk === null || now >= nextAsk;
}

/**
 * `shown` is saved the moment the card appears, so an ignored card, a reload or a closed window
 * still uses up that ask; "Not now" then only hides it. The other three end the asking.
 */
export type StarPromptAnswer = "shown" | "starred-now" | "already-starred" | "detected";

/** The shared state after an answer. Showing the last ask ends the asking. */
export function answerStarPrompt(
  prompt: GitHubStarPrompt,
  answer: StarPromptAnswer,
  now: number,
): GitHubStarPrompt {
  const choice = prompt.choiceAt === undefined ? {} : { choiceAt: prompt.choiceAt };
  if (answer !== "shown") {
    return { status: "starred", asks: prompt.asks, nextAskAt: null, ...choice };
  }
  const asks = Math.min(prompt.asks + 1, GITHUB_STAR_PROMPT_MAX_ASKS);
  const waitDays = STAR_PROMPT_BACKOFF_DAYS[asks - 1];
  if (asks >= GITHUB_STAR_PROMPT_MAX_ASKS || waitDays === undefined) {
    return { status: "done", asks, nextAskAt: null, ...choice };
  }
  return {
    status: "asking",
    asks,
    nextAskAt: new Date(now + waitDays * DAY_MS).toISOString(),
    ...choice,
  };
}

/** The Settings switch, stamped so the later choice wins across machines. On starts afresh. */
export function setStarPromptEnabled(enabled: boolean, now: number): GitHubStarPrompt {
  return {
    status: enabled ? "asking" : "off",
    asks: 0,
    nextAskAt: null,
    choiceAt: new Date(now).toISOString(),
  };
}
