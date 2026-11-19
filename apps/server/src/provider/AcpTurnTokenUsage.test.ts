import { describe, expect, it } from "@effect/vitest";

import {
  acpSessionUsageIncrease,
  addAcpTurnUsage,
  normalizeAcpTurnTokenUsage,
  readAcpPromptUsage,
} from "./AcpTurnTokenUsage.ts";

describe("readAcpPromptUsage", () => {
  it("reads Grok's totals from _meta.usage, where input already includes the cache", () => {
    expect(
      readAcpPromptUsage({
        stopReason: "end_turn",
        _meta: {
          usage: {
            inputTokens: 47609,
            outputTokens: 452,
            totalTokens: 48061,
            cachedReadTokens: 25088,
            cacheCreationTokens: 0,
            reasoningTokens: 381,
          },
        },
      }),
    ).toEqual({
      inputTokens: 47609,
      outputTokens: 452,
      cachedInputTokens: 25088,
      cacheCreationTokens: 0,
      reasoningTokens: 381,
    });
  });

  it("adds a separately reported cache to the input of a standard ACP usage", () => {
    expect(
      readAcpPromptUsage({
        stopReason: "end_turn",
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 16136,
          cachedReadTokens: 7759,
          cachedWriteTokens: 8369,
          thoughtTokens: 2,
        },
      }),
    ).toEqual({
      inputTokens: 16131,
      outputTokens: 5,
      cachedInputTokens: 7759,
      cacheCreationTokens: 8369,
      reasoningTokens: 2,
    });
  });

  it("prefers the standard field over _meta and never reports reasoning above output", () => {
    expect(
      readAcpPromptUsage({
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, thoughtTokens: 40 },
        _meta: { usage: { inputTokens: 999, outputTokens: 999 } },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: undefined,
      cacheCreationTokens: undefined,
      reasoningTokens: 10,
    });
  });

  it("reads Gemini CLI's _meta.quota totals", () => {
    // Shape returned by Gemini CLI 0.63.0 for a Gemini 4 Argon turn on Vertex AI.
    expect(
      readAcpPromptUsage({
        stopReason: "end_turn",
        _meta: {
          quota: {
            token_count: { input_tokens: 54300, output_tokens: 670 },
            model_usage: [
              {
                model: "gemini-4-argon",
                token_count: { input_tokens: 54300, output_tokens: 670 },
              },
            ],
          },
        },
      }),
    ).toEqual({
      inputTokens: 54300,
      outputTokens: 670,
      cachedInputTokens: undefined,
      cacheCreationTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(
      readAcpPromptUsage({
        usage: { inputTokens: 5, outputTokens: 1 },
        _meta: { quota: { token_count: { input_tokens: 9, output_tokens: 9 } } },
      }),
    ).toMatchObject({ inputTokens: 5, outputTokens: 1 });
    expect(readAcpPromptUsage({ _meta: { quota: { token_count: {} } } })).toBeUndefined();
  });

  it("leaves a response without usage unreported", () => {
    expect(readAcpPromptUsage({ stopReason: "end_turn" })).toBeUndefined();
    expect(readAcpPromptUsage({ stopReason: "end_turn", usage: null })).toBeUndefined();
    expect(readAcpPromptUsage({ usage: { totalTokens: 12 } })).toBeUndefined();
    expect(readAcpPromptUsage({ usage: { inputTokens: -4, outputTokens: "9" } })).toBeUndefined();
  });
});

describe("normalizeAcpTurnTokenUsage", () => {
  const counts = {
    inputTokens: 200,
    outputTokens: 20,
    cachedInputTokens: 150,
    cacheCreationTokens: undefined,
    reasoningTokens: 5,
  };

  it("is complete only for a completed turn with both totals", () => {
    expect(normalizeAcpTurnTokenUsage(counts, false, "completed")).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 200,
      outputTokens: 20,
      cachedInputTokens: 150,
      reasoningTokens: 5,
      hasSubagents: false,
    });
    expect(normalizeAcpTurnTokenUsage(counts, true, "interrupted").usageStatus).toBe("partial");
    expect(
      normalizeAcpTurnTokenUsage({ ...counts, outputTokens: undefined }, false, "completed"),
    ).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      inputTokens: 200,
      cachedInputTokens: 150,
      reasoningTokens: 5,
      hasSubagents: false,
    });
  });

  it("sums prompts of one turn and drops a category one prompt did not report", () => {
    expect(addAcpTurnUsage(undefined, counts)).toBe(counts);
    expect(
      addAcpTurnUsage(counts, {
        inputTokens: 300,
        outputTokens: 30,
        cachedInputTokens: undefined,
        cacheCreationTokens: 7,
        reasoningTokens: 1,
      }),
    ).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cachedInputTokens: undefined,
      cacheCreationTokens: undefined,
      reasoningTokens: 6,
    });
  });
});

describe("acpSessionUsageIncrease", () => {
  const totals = (inputTokens: number, outputTokens: number, cachedInputTokens?: number) => ({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens: undefined,
    reasoningTokens: undefined,
  });

  it("keeps the first prompt of a live session as reported", () => {
    expect(acpSessionUsageIncrease(undefined, totals(5000, 40, 4500))).toEqual(
      totals(5000, 40, 4500),
    );
  });

  it("returns what a prompt added to the session's running totals", () => {
    expect(acpSessionUsageIncrease(totals(5000, 40, 4500), totals(7200, 95, 6600))).toEqual(
      totals(2200, 55, 2100),
    );
  });

  it("counts an unchanged repeat once, as nothing used", () => {
    // October 21, 2026: ten turns of one Copilot thread all reported 526,009,087.
    let baseline: ReturnType<typeof totals> | undefined;
    let stored = 0;
    for (let turn = 0; turn < 10; turn++) {
      const reported = totals(526_009_087, 1_200);
      stored += acpSessionUsageIncrease(baseline, reported).inputTokens ?? 0;
      baseline = reported;
    }
    expect(stored).toBe(526_009_087);
  });

  it("starts again when a count falls, as after a reset", () => {
    expect(acpSessionUsageIncrease(totals(9000, 300), totals(1200, 20))).toEqual(
      totals(1200, 20),
    );
  });

  it("leaves a category unknown when the previous prompt did not report it", () => {
    expect(acpSessionUsageIncrease(totals(1000, 10), totals(1500, 20, 1400))).toEqual(
      totals(500, 10, undefined),
    );
  });

  it("never reports reasoning above the prompt's own output", () => {
    expect(
      acpSessionUsageIncrease(
        { ...totals(100, 50), reasoningTokens: 10 },
        { ...totals(200, 60), reasoningTokens: 40 },
      ),
    ).toEqual({ ...totals(100, 10), reasoningTokens: 10 });
  });
});
