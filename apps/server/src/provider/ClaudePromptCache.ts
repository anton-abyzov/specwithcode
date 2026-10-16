/**
 * How long Claude Code keeps a thread's prompt cache.
 *
 * Claude Code 2.1.30x resolves the main conversation's TTL in this order:
 * FORCE_PROMPT_CACHING_5M, then CLAUDE_CODE_PROMPT_CACHE_TTL, then the
 * `promptCacheTtl` setting, then ENABLE_PROMPT_CACHING_1H; with none of them a
 * Claude subscription writes 1-hour entries and an API key, Bedrock, Vertex or
 * Foundry writes 5-minute ones. Subagents and helper requests follow
 * CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL instead and stay at 5 minutes.
 *
 * SpecWithCode threads sit idle between messages for minutes at a time, so a
 * 5-minute cache is rewritten in full on most follow-ups. Recorded sessions put
 * that at 17% more input cost than the 1-hour cache, which costs 2x base input
 * to write instead of 1.25x but survives the wait.
 */

export type ClaudePromptCacheTtl = "1h" | "5m" | "off";

const TTL_VARIABLES = [
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL",
  "ENABLE_PROMPT_CACHING_1H",
  "FORCE_PROMPT_CACHING_5M",
  "DISABLE_PROMPT_CACHING",
] as const;

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "no" &&
    normalized !== "off"
  );
}

/**
 * The main conversation's cache lifetime in a session started with this
 * environment. Without an explicit choice it is the 1-hour cache that
 * {@link withMainThreadPromptCache} asks for.
 */
export function claudeMainThreadPromptCacheTtl(
  environment: Readonly<Record<string, string | undefined>>,
): ClaudePromptCacheTtl {
  if (truthy(environment.DISABLE_PROMPT_CACHING)) return "off";
  if (truthy(environment.FORCE_PROMPT_CACHING_5M)) return "5m";
  if (environment.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL?.trim() === "5m") return "5m";
  const explicit = environment.CLAUDE_CODE_PROMPT_CACHE_TTL?.trim();
  if (explicit === "5m" || explicit === "1h") return explicit;
  if (environment.ENABLE_PROMPT_CACHING_1H !== undefined) {
    return truthy(environment.ENABLE_PROMPT_CACHING_1H) ? "1h" : "5m";
  }
  return "1h";
}

/**
 * Asks for the 1-hour cache on the main conversation unless the environment
 * already decides the TTL. A subscription gets it anyway; for an API key it
 * replaces the 5-minute default. Subagents keep their 5-minute cache: their
 * requests run back to back, so the cheaper write wins there.
 */
export function withMainThreadPromptCache<T extends Record<string, string | undefined>>(
  environment: T,
): T {
  if (TTL_VARIABLES.some((name) => environment[name] !== undefined)) return environment;
  return { ...environment, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" };
}
