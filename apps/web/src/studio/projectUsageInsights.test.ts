import { describe, expect, it } from "vite-plus/test";
import type { ProjectUsageSummary, ProjectUsageTotals } from "@specweave-studio/contracts";

import {
  filterOptions,
  groupByHarness,
  groupByModel,
  matches,
  modelFamily,
  modelLabel,
  normalizeModelId,
  periodChange,
  trendDays,
  usageDayFacts,
  usageFacts,
} from "./projectUsageInsights";
import { cliOfDriver, providerLabel } from "./projectUsageModel";

const t = (total: number, cached: number | null = 0): ProjectUsageTotals => ({
  inputTokens: total,
  outputTokens: 0,
  totalTokens: total,
  cachedInputTokens: cached,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  equivalentCostUsd: null,
});

const summary = {
  threads: [
    {
      threadId: "coord",
      title: "Coordinator",
      role: "coordinator",
      archived: false,
      totals: t(300),
      share: 0.5,
      models: [
        {
          provider: "claudeAgent",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5.5",
          totals: t(300),
        },
      ],
    },
    {
      threadId: "w1",
      title: "Worker",
      role: "worker",
      archived: false,
      totals: t(300),
      share: 0.5,
      models: [
        {
          provider: "claudeAgent",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5[1m]",
          totals: t(200),
        },
        {
          provider: "acpRegistry",
          providerInstanceId: "acp-grok-cli",
          model: null,
          totals: t(100, null),
        },
      ],
    },
    {
      threadId: "idle",
      title: "Idle",
      role: "worker",
      archived: true,
      totals: t(0),
      share: 0,
      models: [],
    },
  ],
  models: [],
  daily: [
    {
      day: "2026-10-28",
      role: "worker",
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
      model: "claude-opus-5-5",
      totalTokens: 50,
    },
    {
      day: "2026-10-20",
      role: "coordinator",
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
      model: "claude-opus-5.5",
      totalTokens: 25,
    },
  ],
  folderSessions: {
    models: [{ provider: "codex", model: "gpt-5.1-codex", totals: t(400) }],
    daily: [{ day: "2026-10-29", provider: "codex", model: "gpt-5.1-codex", totalTokens: 400 }],
  },
} as unknown as ProjectUsageSummary;

describe("model names", () => {
  it.each([
    ["claude-opus-5.5", "claude-opus-5-5"],
    ["claude-opus-5-5[1m]", "claude-opus-5-5"],
    ["anthropic/claude-opus-5-5-20261001", "claude-opus-5-5"],
    ["us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5"],
    ["GPT-5.1-Codex", "gpt-5-1-codex"],
    ["gpt-4o-2024-08-06", "gpt-4o"],
    ["", null],
    [null, null],
  ])("normalizes %s to %s", (input, key) => {
    expect(normalizeModelId(input)).toBe(key);
  });

  it("reads keys as people name models and groups them by family", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("gpt-5-1-codex")).toBe("GPT-5.1 Codex");
    expect(modelLabel(null)).toBe("Model not reported");
    expect(modelFamily("claude-opus-5-5")).toBe("Claude Opus");
    expect(modelFamily("claude-3-5-sonnet")).toBe("Claude Sonnet");
    expect(modelFamily("gpt-5-1-codex")).toBe("GPT-5");
    expect(modelFamily("grok-code-fast-1")).toBe("Grok");
    expect(modelLabel("auto")).toBe("Chosen by the agent");
    expect(modelFamily("auto")).toBe("Chosen by the agent");
  });
});

describe("harness names", () => {
  it.each([
    ["acpRegistry_copilot", "Copilot"],
    ["copilot-0889", "Copilot"],
    ["acpRegistry_gemini", "Gemini"],
    ["acpRegistry_devin", "Devin"],
    ["acpRegistry_deepseek_harness", "DeepSeek"],
    ["acpRegistry", "ACP agent"],
  ])("names the ACP instance %s as %s", (instance, label) => {
    expect(providerLabel(cliOfDriver("acpRegistry", instance))).toBe(label);
  });
});

describe("usage facts", () => {
  const facts = usageFacts(summary);

  it("merges spellings of one model across threads and sources, dropping empty rows", () => {
    expect(facts).toHaveLength(4);
    const models = groupByModel(facts);
    expect(models.map((row) => [row.label, row.totals.totalTokens])).toEqual([
      ["Claude Opus 5.5", 500],
      ["GPT-5.1 Codex", 400],
      ["Model not reported", 100],
    ]);
    expect(models[0]?.via).toEqual(["Claude"]);
  });

  it("names ACP agents by harness and keeps unknown cache categories unknown", () => {
    const harnesses = groupByHarness(facts);
    expect(harnesses.map((row) => [row.label, row.share])).toEqual([
      ["Claude", 0.5],
      ["Codex", 0.4],
      ["Grok", 0.1],
    ]);
    expect(harnesses.find((row) => row.key === "grok")?.totals.cachedInputTokens).toBe(null);
  });

  it("filters by source, harness and family together", () => {
    const keep = (filters: Parameters<typeof matches>[1]) =>
      facts
        .filter((fact) => matches(fact, filters))
        .reduce((sum, f) => sum + f.totals.totalTokens, 0);
    expect(keep({ source: "coordinator", harness: "all", family: "all" })).toBe(300);
    expect(keep({ source: "thread", harness: "claude", family: "all" })).toBe(200);
    expect(keep({ source: "all", harness: "all", family: "Claude Opus" })).toBe(500);
    expect(keep({ source: "cli", harness: "all", family: "GPT-5" })).toBe(400);
  });

  it("offers only filters that have tokens, unreported models last", () => {
    expect(filterOptions(facts)).toEqual({
      sources: ["coordinator", "thread", "cli"],
      harnesses: [
        { value: "claude", label: "Claude" },
        { value: "codex", label: "Codex" },
        { value: "grok", label: "Grok" },
      ],
      families: ["Claude Opus", "GPT-5", "Model not reported"],
    });
  });

  it("falls back to project models when the server does not split threads", () => {
    const older = {
      ...summary,
      threads: summary.threads.map(({ models: _models, ...thread }) => thread),
      models: [
        {
          provider: "codex",
          providerInstanceId: "codex",
          model: "gpt-5.5",
          modelAttribution: "run_selection",
          totals: t(10),
        },
      ],
    } as unknown as ProjectUsageSummary;
    expect(usageFacts(older).map((fact) => [fact.source, fact.harness])).toEqual([
      ["thread", "codex"],
      ["cli", "codex"],
    ]);
  });
});

describe("trend", () => {
  it("zero-fills a window ending today and compares the last week with the one before", () => {
    const days = trendDays(usageDayFacts(summary), "2026-10-29", 14);
    expect(days).toHaveLength(14);
    expect(days[0]?.day).toBe("2026-10-16");
    expect(days.at(-1)).toEqual({ day: "2026-10-29", threads: 0, cli: 400 });
    expect(days.at(-2)).toEqual({ day: "2026-10-28", threads: 50, cli: 0 });
    expect(periodChange(days, 7)).toEqual({ recent: 450, previous: 25, change: 17 });
    expect(periodChange(trendDays([], "2026-10-29", 14), 7).change).toBe(null);
  });

  it("crosses month ends", () => {
    expect(trendDays([], "2026-11-01", 3).map((day) => day.day)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });
});
