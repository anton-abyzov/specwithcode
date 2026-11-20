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
    expect(carried.note).toBe(
      "GPT-6.1 Sol on GitHub Copilot doesn't offer Ultracode, Fast mode or Context Window, so those settings were not carried over.",
    );
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
      ).toMatchObject({ selection: { instanceId: claude, model: "claude-fable-5-2" }, note: null });
    }
  });

  it("brings Ultracode, 1M context and Fast mode back on the way home through a model without them", () => {
    const away = carriedProjectModelSelection({
      previous: opusWithUltracode,
      instanceId: copilot,
      model: "gpt-6.1-sol",
      entries,
    });
    const home = carriedProjectModelSelection({
      previous: away.selection,
      instanceId: claude,
      model: "claude-opus-5-5",
      entries,
      held: away.held,
    });
    expect([...(home.selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "contextWindow", value: "1m" },
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
      { id: "thinking", value: true },
      { id: "ultracode", value: true },
    ]);
    expect(home.note).toBeNull();
    // Without the picker's memory the way home has only what the middle model could run.
    expect(
      carriedProjectModelSelection({
        previous: away.selection,
        instanceId: claude,
        model: "claude-opus-5-5",
        entries,
      }).selection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("does not put held options on a choice that was saved somewhere else", () => {
    const away = carriedProjectModelSelection({
      previous: opusWithUltracode,
      instanceId: copilot,
      model: "gpt-6.1-sol",
      entries,
    });
    // Another project, or another window, saved the same model at Low: not this picker's choice.
    const elsewhere: ModelSelection = {
      instanceId: copilot,
      model: "gpt-6.1-sol",
      options: [{ id: "reasoning_effort", value: "low" }],
    };
    const next = carriedProjectModelSelection({
      previous: elsewhere,
      instanceId: claude,
      model: "claude-opus-5-5",
      entries,
      held: away.held,
    });
    expect(next.selection.options).toEqual([{ id: "effort", value: "low" }]);
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

  it("moves a Claude pick to a new Codex model with its effort and says nothing", () => {
    // Claude's Thinking toggle is on by default and Codex reasons at its effort
    // level, so neither Effort nor Thinking is reported as left off.
    const codex = ProviderInstanceId.make("codex");
    const codexReasoning: ReadonlyArray<ProviderOptionDescriptor> = [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          level("medium", "Medium"),
          level("high", "High"),
          level("xhigh", "Extra High"),
          level("max", "Max"),
          level("ultra", "Ultra"),
        ],
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [{ id: "default", label: "Standard", isDefault: true }, level("priority", "Fast")],
      },
    ];
    const thinkingOnByDefault = CLAUDE_OPTIONS.map((descriptor) =>
      descriptor.id === "thinking" && descriptor.type === "boolean"
        ? { ...descriptor, currentValue: true }
        : descriptor,
    );
    const withCodex: ReadonlyArray<ModelCarryEntry> = [
      {
        ...entries[0]!,
        models: [model("claude-opus-5-5", "Claude Opus 5.5", thinkingOnByDefault)],
      },
      {
        instanceId: codex,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        models: [model("gpt-6.2-astra", "GPT-6.2-Astra", codexReasoning)],
      },
    ];
    const carried = carriedProjectModelSelection({
      previous: {
        instanceId: claude,
        model: "claude-opus-5-5",
        options: [
          { id: "effort", value: "xhigh" },
          { id: "thinking", value: true },
        ],
      },
      instanceId: codex,
      model: "gpt-6.2-astra",
      entries: withCodex,
    });
    expect(carried.selection.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
    expect(carried.note).toBeNull();
  });

  it("names the provider when a model there truly has no effort setting", () => {
    const copilotModeOnly: ModelCarryEntry = {
      ...entries[1]!,
      models: [
        model("gpt-6.2-astra", "GPT-6.2-Astra", [
          {
            id: "mode",
            label: "Mode",
            type: "select",
            options: [level("agent", "Agent"), level("plan", "Plan")],
          },
        ]),
      ],
    };
    const carried = carriedProjectModelSelection({
      previous: {
        instanceId: claude,
        model: "claude-opus-5-5",
        options: [
          { id: "effort", value: "high" },
          { id: "thinking", value: true },
        ],
      },
      instanceId: copilot,
      model: "gpt-6.2-astra",
      entries: [entries[0]!, copilotModeOnly],
    });
    expect(carried.note).toBe(
      "GPT-6.2-Astra on GitHub Copilot doesn't offer Effort or Thinking, so those settings were not carried over.",
    );
  });
});
