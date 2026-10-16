import { describe, expect, it } from "@effect/vitest";

import { claudeMainThreadPromptCacheTtl, withMainThreadPromptCache } from "./ClaudePromptCache.ts";

describe("withMainThreadPromptCache", () => {
  it("asks for the 1-hour cache on the main conversation", () => {
    expect(withMainThreadPromptCache({ PATH: "/bin" })).toEqual({
      PATH: "/bin",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    });
  });

  it.each([
    ["CLAUDE_CODE_PROMPT_CACHE_TTL", "5m"],
    ["CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL", "5m"],
    ["ENABLE_PROMPT_CACHING_1H", "1"],
    ["FORCE_PROMPT_CACHING_5M", "1"],
    ["DISABLE_PROMPT_CACHING", "1"],
  ])("keeps a TTL the environment already sets with %s", (name, value) => {
    const environment = { [name]: value };
    expect(withMainThreadPromptCache(environment)).toBe(environment);
  });
});

describe("claudeMainThreadPromptCacheTtl", () => {
  it("follows Claude Code's order of precedence", () => {
    expect(claudeMainThreadPromptCacheTtl({})).toBe("1h");
    expect(claudeMainThreadPromptCacheTtl(withMainThreadPromptCache({}))).toBe("1h");
    expect(claudeMainThreadPromptCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })).toBe("5m");
    expect(claudeMainThreadPromptCacheTtl({ ENABLE_PROMPT_CACHING_1H: "1" })).toBe("1h");
    expect(claudeMainThreadPromptCacheTtl({ ENABLE_PROMPT_CACHING_1H: "false" })).toBe("5m");
    expect(
      claudeMainThreadPromptCacheTtl({
        CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
        FORCE_PROMPT_CACHING_5M: "1",
      }),
    ).toBe("5m");
    expect(
      claudeMainThreadPromptCacheTtl({
        CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
        CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: "5m",
      }),
    ).toBe("5m");
    expect(claudeMainThreadPromptCacheTtl({ DISABLE_PROMPT_CACHING: "true" })).toBe("off");
    expect(claudeMainThreadPromptCacheTtl({ FORCE_PROMPT_CACHING_5M: "0" })).toBe("1h");
  });
});
