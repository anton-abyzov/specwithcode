import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeNativeCatalog, mergeClaudeNativeModels } from "./ClaudeNativeModels.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
  resolveClaudeModelSlug,
} from "./ClaudeModelCatalog.ts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import {
  makeClaudeQueryOptions,
  claudeProviderTurnTokenUsage,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const row = (
  value: string,
  resolvedModel = value,
  changes: Partial<ModelInfo> = {},
): ModelInfo => ({
  value,
  resolvedModel,
  displayName: value,
  description: "Native model",
  ...changes,
});
const haiku = row("haiku", "claude-haiku-5-5", {
  displayName: "Haiku",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  supportsAdaptiveThinking: true,
});
const selection = (model: string) => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model,
  options: [
    { id: "effort", value: "max" },
    { id: "thinking", value: true },
    { id: "fastMode", value: true },
  ],
});

describe("native Claude model discovery", () => {
  it("lists a dated native id once, under its undated model", () => {
    const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [
      row("haiku", "claude-haiku-4-5-20251001"),
    ]);
    const haikus = catalog.models.filter((entry) =>
      entry.model.slug.startsWith("claude-haiku-4-5"),
    );
    expect(haikus.map((entry) => entry.model.slug)).toEqual(["claude-haiku-4-5"]);
    expect(haikus[0]!.model.name).toBe("Claude Haiku 4.5");
    expect(resolveClaudeModelSlug(catalog, "claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    const lone = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [
      row("sonnet", "claude-sonnet-9-1-20270101"),
    ]).models.find((entry) => entry.model.slug === "claude-sonnet-9-1-20270101");
    expect(lone?.model.name).toBe("Claude Sonnet 9.1");
  });
  it("shows adaptive thinking as on until a thread turns it off", () => {
    const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [haiku]);
    const discovered = catalog.models.find((entry) => entry.model.slug === "claude-haiku-5-5")!;
    expect(
      discovered.model.capabilities?.optionDescriptors?.find((option) => option.id === "thinking"),
    ).toEqual({ id: "thinking", label: "Thinking", type: "boolean", currentValue: true });
    // Unset still asks for adaptive thinking; only an explicit false turns it off.
    const unset = compileClaudeModelSelection(
      { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
      catalog,
    );
    expect(unset.settings).not.toHaveProperty("alwaysThinkingEnabled", false);
    const off = compileClaudeModelSelection(
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-5-5",
        options: [{ id: "thinking", value: false }],
      },
      catalog,
    );
    expect(off.settings).toMatchObject({ alwaysThinkingEnabled: false });
  });

  it("discovers Haiku 5.5 and future models without a bundled release", () => {
    const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [
      haiku,
      row("future", "claude-future-9"),
    ]);
    const discovered = catalog.models.find((entry) => entry.model.slug === "claude-haiku-5-5")!;
    expect(discovered.model).toMatchObject({
      name: "Claude Haiku 5.5",
      aliases: ["haiku"],
      isLegacy: false,
    });
    expect(resolveClaudeModelSlug(catalog, "haiku")).toBe("claude-haiku-5-5");
    expect(resolveClaudeModelSlug(catalog, "future")).toBe("claude-future-9");
    const compiled = compileClaudeModelSelection(selection("claude-haiku-5-5"), catalog);
    expect(compiled).toMatchObject({
      apiModelId: "claude-haiku-5-5",
      effort: "max",
      settings: { alwaysThinkingEnabled: true },
    });
    expect(compiled.settings).not.toHaveProperty("fastMode");
  });

  it("deduplicates native default aliases and preserves older explicit selections", () => {
    const base = BUNDLED_CLAUDE_MODEL_CATALOG;
    const catalog = mergeClaudeNativeModels(base, [
      row("default", "claude-opus-5-5"),
      row("opus", "claude-opus-5-5"),
      haiku,
    ]);
    expect(catalog.models.filter((entry) => entry.model.slug === "claude-opus-5-5")).toHaveLength(
      1,
    );
    expect(
      catalog.models.filter((entry) => entry.model.isDefault).map((entry) => entry.model.slug),
    ).toEqual(["claude-opus-5-5"]);
    expect(resolveClaudeModelSlug(catalog, "default")).toBe("claude-opus-5-5");
    expect(resolveClaudeModelSlug(catalog, "opus")).toBe("claude-opus-5-5");
    expect(resolveClaudeCatalogApiModelId(catalog, selection("claude-haiku-4-5"))).toBe(
      "claude-haiku-4-5",
    );
    expect(resolveClaudeModelSlug(base, "haiku")).toBe("claude-haiku-4-5");
  });

  it("retains a native literal model suffix for dispatch without guessing its context size", () => {
    const catalog = mergeClaudeNativeModels({ models: [] }, [
      row("claude-future-9[1m]", "claude-future-9"),
    ]);
    expect(resolveClaudeCatalogApiModelId(catalog, selection("claude-future-9"))).toBe(
      "claude-future-9[1m]",
    );
    const usage = claudeProviderTurnTokenUsage(
      { input_tokens: 3, output_tokens: 1 },
      selection("claude-future-9"),
      "2026-10-09T00:00:00Z",
      catalog,
    );
    expect(usage.maxTokens).toBeNull();
  });

  it.each([false, true])(
    "gives native aliases ownership over imported aliases in either row order (reverse: %s)",
    (reverse) => {
      const old = row("claude-haiku-4-5");
      const rows = reverse ? [haiku, old] : [old, haiku];
      const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, rows);
      expect(resolveClaudeModelSlug(catalog, "haiku")).toBe("claude-haiku-5-5");
      expect(
        catalog.models.find((entry) => entry.model.slug === "claude-haiku-4-5")?.model.aliases,
      ).not.toContain("haiku");
      expect(resolveClaudeModelSlug(catalog, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
    },
  );

  it("preserves the fallback default when native discovery has no default row", () => {
    const fallback = BUNDLED_CLAUDE_MODEL_CATALOG.models.find((entry) => entry.model.isDefault)!;
    for (const rows of [[row(fallback.model.slug)], [haiku]]) {
      const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, rows);
      expect(
        catalog.models.filter((entry) => entry.model.isDefault).map((entry) => entry.model.slug),
      ).toEqual([fallback.model.slug]);
    }
  });

  it("honors an explicit known context selection over the native picker suffix", () => {
    const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [
      row("claude-fable-5-1[1m]", "claude-fable-5-1"),
    ]);
    for (const [value, wire] of [
      ["200k", "claude-fable-5-1"],
      ["1m", "claude-fable-5-1[1m]"],
    ]) {
      expect(
        resolveClaudeCatalogApiModelId(catalog, {
          ...selection("claude-fable-5-1"),
          options: [{ id: "contextWindow", value: value! }],
        }),
      ).toBe(wire);
    }
  });

  it("uses the same discovered capabilities at the SDK execution boundary", () => {
    const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [haiku]);
    const options = makeClaudeQueryOptions({
      modelSelection: selection("claude-haiku-5-5"),
      modelCatalog: catalog,
      nativeThreadId: "synthetic",
      resume: false,
      cwd: "/synthetic",
    });
    expect(options.model).toBe("claude-haiku-5-5");
    expect(options.effort).toBe("max");
    expect(options.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(options.settings).not.toHaveProperty("fastMode");
  });

  it("does not send unsupported effort, thinking or fast mode for a new opaque model", () => {
    const catalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, [
      row("future", "opaque-future"),
    ]);
    const options = makeClaudeQueryOptions({
      modelSelection: selection("opaque-future"),
      modelCatalog: catalog,
      nativeThreadId: "synthetic",
      resume: false,
      cwd: "/synthetic",
    });
    expect(options.model).toBe("opaque-future");
    expect(options.effort).toBeUndefined();
    expect(options.thinking).toBeUndefined();
    // Only the model-independent default workflow policy; no fast mode or thinking settings.
    expect(options.settings).toEqual({ enableWorkflows: true, ultracode: false });
  });

  it("keeps each instance independent and replaces prior account discovery on successful initialization", () => {
    const first = createClaudeNativeCatalog(BUNDLED_CLAUDE_MODEL_CATALOG),
      second = createClaudeNativeCatalog(BUNDLED_CLAUDE_MODEL_CATALOG);
    first.updateNative([haiku]);
    second.updateNative([row("other", "other-account-model")]);
    expect(resolveClaudeModelSlug(first.current(), "haiku")).toBe("claude-haiku-5-5");
    expect(resolveClaudeModelSlug(second.current(), "haiku")).toBe("claude-haiku-4-5");
    first.updateNative([row("new-account", "new-account-model")]);
    expect(first.current().models.some((entry) => entry.model.slug === "claude-haiku-5-5")).toBe(
      false,
    );
  });

  it("falls back on absent, empty or invalid discovery and preserves last known data when no successful update occurs", () => {
    const state = createClaudeNativeCatalog(BUNDLED_CLAUDE_MODEL_CATALOG);
    state.updateNative([haiku]);
    const successful = state.current();
    expect(state.current()).toBe(successful);
    state.updateBase(BUNDLED_CLAUDE_MODEL_CATALOG);
    expect(resolveClaudeModelSlug(state.current(), "haiku")).toBe("claude-haiku-5-5");
    for (const models of [undefined, [], [row("", "")]]) {
      state.updateNative(models);
      expect(state.current()).toBe(BUNDLED_CLAUDE_MODEL_CATALOG);
    }
  });
});
