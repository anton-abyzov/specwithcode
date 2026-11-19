import { describe, expect, it } from "@effect/vitest";

import {
  acpSessionUsageIncrease,
  addAcpTurnUsage,
  normalizeAcpPromptUsage,
  type AcpRawPromptUsage,
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
  const totals = (
    inputTokens: number,
    outputTokens: number,
    more: Partial<AcpRawPromptUsage> = {},
  ): AcpRawPromptUsage => ({
    inputTokens,
    outputTokens,
    cachedReadTokens: undefined,
    cachedWriteTokens: undefined,
    reasoningTokens: undefined,
    totalTokens: undefined,
    ...more,
  });

  it("keeps the first prompt of a live session as reported", () => {
    expect(acpSessionUsageIncrease(undefined, totals(5000, 40))).toEqual({
      usage: totals(5000, 40),
      complete: true,
    });
  });

  it("returns what a prompt added to the session's running totals", () => {
    expect(
      acpSessionUsageIncrease(
        totals(5000, 40, { cachedReadTokens: 4500 }),
        totals(7200, 95, { cachedReadTokens: 6600 }),
      ),
    ).toEqual({ usage: totals(2200, 55, { cachedReadTokens: 2100 }), complete: true });
  });

  it("counts an unchanged repeat once, as nothing used", () => {
    // October 21, 2026: ten turns of one Copilot thread all reported 526,009,087.
    let baseline: AcpRawPromptUsage | undefined;
    let stored = 0;
    for (let turn = 0; turn < 10; turn++) {
      const reported = totals(526_009_087, 1_200);
      stored += acpSessionUsageIncrease(baseline, reported).usage.inputTokens ?? 0;
      baseline = reported;
    }
    expect(stored).toBe(526_009_087);
  });

  it("starts again when a count falls, as after a reset", () => {
    expect(acpSessionUsageIncrease(totals(9000, 300), totals(1200, 20))).toEqual({
      usage: totals(1200, 20),
      complete: true,
    });
  });

  it("leaves a count the previous prompt did not report unknown and the usage incomplete", () => {
    expect(
      acpSessionUsageIncrease(totals(1000, 10), totals(1500, 20, { cachedReadTokens: 1400 })),
    ).toEqual({ usage: totals(500, 10), complete: false });
  });

  it("interprets the prompt's own numbers, not the difference of interpreted totals", () => {
    // The cache is reported on top of input in both totals (the totals prove it).
    const first = totals(100, 10, { cachedReadTokens: 900, totalTokens: 1010 });
    const second = totals(150, 20, { cachedReadTokens: 1400, totalTokens: 1570 });
    const { usage } = acpSessionUsageIncrease(first, second);
    expect(normalizeAcpPromptUsage(usage)).toEqual({
      inputTokens: 550,
      outputTokens: 10,
      cachedInputTokens: 500,
      cacheCreationTokens: undefined,
      reasoningTokens: undefined,
    });
    // Reasoning is capped at the prompt's own output after subtracting.
    const thinking = acpSessionUsageIncrease(
      totals(10, 50, { reasoningTokens: 100 }),
      totals(20, 100, { reasoningTokens: 100 }),
    );
    expect(normalizeAcpPromptUsage(thinking.usage).reasoningTokens).toBe(0);
  });
});

it("stores a turn whose counts may belong to another prompt as partial", () => {
  expect(
    normalizeAcpTurnTokenUsage(
      {
        inputTokens: 500,
        outputTokens: 15,
        cachedInputTokens: undefined,
        cacheCreationTokens: undefined,
        reasoningTokens: undefined,
      },
      false,
      "completed",
      false,
    ),
  ).toEqual({
    usageScope: "main_agent",
    usageStatus: "partial",
    inputTokens: 500,
    outputTokens: 15,
    hasSubagents: false,
  });
});
