import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { carriedProjectModelSelection, type ModelCarryEntry } from "./projectModelCarry";

const level = (id: string, label: string) => ({ id, label });
const CLAUDE_OPTIONS: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "contextWindow",
    label: "Context Window",
    type: "select",
    options: [{ id: "200k", label: "200k", isDefault: true }, level("1m", "1M")],
  },
  {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: [
      level("low", "Low"),
      level("medium", "Medium"),
      level("high", "High"),
      level("xhigh", "Extra High"),
    ],
  },
  { id: "ultracode", label: "Ultracode", type: "boolean" },
  { id: "thinking", label: "Thinking", type: "boolean" },
  { id: "fastMode", label: "Fast Mode", type: "boolean" },
];
const COPILOT_OPTIONS: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "reasoning_effort",
    label: "Reasoning effort",
    type: "select",
    options: [level("low", "low"), level("medium", "medium"), level("high", "high")],
  },
];
const model = (
  slug: string,
  name: string,
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProviderModel => ({ slug, name, isCustom: false, capabilities: { optionDescriptors } });

const claude = ProviderInstanceId.make("claudeAgent");
const copilot = ProviderInstanceId.make("copilot");
const entries: ReadonlyArray<ModelCarryEntry> = [
  {
    instanceId: claude,
    driverKind: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Code",
    models: [
      model("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_OPTIONS),
      model("claude-fable-5-2", "Claude Fable 5.2", CLAUDE_OPTIONS),
    ],
  },
  {
    instanceId: copilot,
    driverKind: ProviderDriverKind.make("copilot"),
    displayName: "GitHub Copilot",
    models: [model("gpt-6.1-sol", "GPT-6.1 Sol", COPILOT_OPTIONS)],
  },
];

/** What the project had saved for new threads before the model was switched. */
const opusWithUltracode: ModelSelection = {
  instanceId: claude,
  model: "claude-opus-5-5",
  options: [
    { id: "contextWindow", value: "1m" },
    { id: "effort", value: "high" },
    { id: "ultracode", value: true },
    { id: "thinking", value: true },
    { id: "fastMode", value: true },
  ],
};

describe("carriedProjectModelSelection", () => {
  it("keeps effort, Ultracode, 1M context, Thinking and Fast mode on another model that offers them", () => {
    const carried = carriedProjectModelSelection({
      previous: opusWithUltracode,
      instanceId: claude,
      model: "claude-fable-5-2",
      entries,
    });
    expect(carried.selection.instanceId).toBe(claude);
    expect(carried.selection.model).toBe("claude-fable-5-2");
    expect([...(carried.selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: "contextWindow", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
        { id: "thinking", value: true },
        { id: "ultracode", value: true },
      ],
    );
    expect(carried.note).toBeNull();
  });

  it("names what a model without them leaves off and keeps the nearest effort", () => {
    const carried = carriedProjectModelSelection({
      previous: opusWithUltracode,
      instanceId: copilot,
      model: "gpt-6.1-sol",
      entries,
    });
    expect(carried.selection).toEqual({
      instanceId: copilot,
      model: "gpt-6.1-sol",
      options: [{ id: "reasoning_effort", value: "high" }],
    });
    expect(carried.note).toContain("GPT-6.1 Sol has no ");
    expect(carried.note).toContain("Ultracode");
    expect(carried.note).toContain("Fast mode");
  });

  it("starts a first pick, or a pick after a choice with no options, on the model's defaults", () => {
    for (const previous of [null, undefined, { instanceId: claude, model: "claude-opus-5-5" }]) {
      expect(
        carriedProjectModelSelection({
          previous,
          instanceId: claude,
          model: "claude-fable-5-2",
          entries,
        }),
      ).toEqual({ selection: { instanceId: claude, model: "claude-fable-5-2" }, note: null });
    }
  });

  it("says so when the new model has not listed its options", () => {
    const carried = carriedProjectModelSelection({
      previous: opusWithUltracode,
      instanceId: ProviderInstanceId.make("acp-agent"),
      model: "custom-model",
      entries,
    });
    expect(carried.selection).toEqual({
      instanceId: ProviderInstanceId.make("acp-agent"),
      model: "custom-model",
    });
    expect(carried.note).toContain("has not listed its options yet");
  });
});
