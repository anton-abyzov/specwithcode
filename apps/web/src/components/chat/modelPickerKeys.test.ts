import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelPickerGroupKey,
  modelPickerGroupStarts,
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerGroupKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";

describe("model picker item keys", () => {
  it("keeps model and legacy section keys distinct for colliding instance names", () => {
    const modelKey = modelPickerModelKey(ProviderInstanceId.make("legacy-models"), "codex");
    const sectionKey = modelPickerLegacySectionKey(ProviderInstanceId.make("codex"));

    expect(modelKey).not.toBe(sectionKey);
    expect(parseModelPickerLegacySectionKey(modelKey)).toBeNull();
    expect(parseModelPickerModelKey(modelKey)).toEqual({
      instanceId: "legacy-models",
      slug: "codex",
    });
  });

  it("round-trips arbitrary strings without throwing", () => {
    const instanceId = ProviderInstanceId.make("custom");
    const slug = "model:\udfff";

    const key = modelPickerModelKey(instanceId, slug);

    expect(parseModelPickerModelKey(key)).toEqual({ instanceId, slug });
  });
});

describe("model picker group headers", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const codex = ProviderInstanceId.make("codex");

  it("keeps group keys apart from model and legacy keys", () => {
    const key = modelPickerGroupKey(codex);
    expect(parseModelPickerGroupKey(key)).toBe(codex);
    expect(parseModelPickerModelKey(key)).toBeNull();
    expect(parseModelPickerLegacySectionKey(key)).toBeNull();
    expect(parseModelPickerGroupKey(modelPickerModelKey(codex, "gpt"))).toBeNull();
  });

  it("heads only the first item of each run of one provider", () => {
    const opus = modelPickerModelKey(claude, "opus");
    const sonnet = modelPickerModelKey(claude, "sonnet");
    const legacy = modelPickerLegacySectionKey(claude);
    const gpt = modelPickerModelKey(codex, "gpt");
    const starts = modelPickerGroupStarts([opus, sonnet, legacy, gpt, "not-a-key"]);
    expect([...starts]).toEqual([
      [opus, claude],
      [gpt, codex],
    ]);
  });

  it("starts a group at a legacy section when the provider has no current models", () => {
    const legacy = modelPickerLegacySectionKey(claude);
    expect([...modelPickerGroupStarts([legacy])]).toEqual([[legacy, claude]]);
  });
});
