import type { ProviderOptionDescriptor } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  carryModelOptions,
  describeCarriedOptions,
  missingCommonOptions,
} from "./modelOptionCarry.ts";

const level = (id: string, label: string) => ({ id, label });

const CLAUDE: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "effort",
    label: "Effort",
    type: "select",
    options: [
      level("low", "Low"),
      level("medium", "Medium"),
      level("high", "High"),
      level("xhigh", "Extra High"),
      level("max", "Max"),
    ],
  },
  { id: "fastMode", label: "Fast Mode", type: "boolean" },
  { id: "ultracode", label: "Ultracode", type: "boolean" },
];

const COPILOT: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "reasoning_effort",
    label: "Reasoning effort",
    type: "select",
    options: [level("low", "low"), level("medium", "medium"), level("high", "high")],
  },
];

const CODEX: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [level("medium", "Medium"), level("high", "High"), level("xhigh", "Extra High")],
  },
  {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [{ id: "default", label: "Standard", isDefault: true }, level("priority", "Fast")],
  },
];

describe("carryModelOptions", () => {
  it("keeps Claude effort, Fast and Ultracode on another Claude model", () => {
    const carried = carryModelOptions({
      previous: [
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "ultracode", value: true },
      ],
      previousDescriptors: CLAUDE,
      nextDescriptors: CLAUDE,
    });
    expect(carried.options).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "ultracode", value: true },
      { id: "fastMode", value: true },
    ]);
    expect(carried.dropped).toEqual([]);
    expect(carried.adjusted).toEqual([]);
  });

  it("names Ultracode and Fast when moving to Copilot and maps effort to the nearest level", () => {
    const carried = carryModelOptions({
      previous: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
        { id: "ultracode", value: true },
      ],
      previousDescriptors: CLAUDE,
      nextDescriptors: COPILOT,
    });
    expect(carried.options).toEqual([{ id: "reasoning_effort", value: "high" }]);
    expect(carried.dropped).toEqual(["Ultracode", "Fast mode"]);
    expect(carried.adjusted).toEqual(["Effort Max → high"]);
    expect(describeCarriedOptions(carried, "GitHub Copilot")).toBe(
      "GitHub Copilot has no Ultracode or Fast mode, so they were left off. Effort Max → high.",
    );
  });

  it("moves Claude Fast mode onto Codex's Fast service tier", () => {
    const carried = carryModelOptions({
      previous: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
      ],
      previousDescriptors: CLAUDE,
      nextDescriptors: CODEX,
    });
    expect(carried.options).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ]);
    expect(carried.dropped).toEqual([]);
  });

  it("moves Codex's Fast tier back to Claude Fast mode", () => {
    const carried = carryModelOptions({
      previous: [{ id: "serviceTier", value: "priority" }],
      previousDescriptors: CODEX,
      nextDescriptors: CLAUDE,
    });
    expect(carried.options).toEqual([{ id: "fastMode", value: true }]);
    expect(carried.dropped).toEqual([]);
  });

  it("keeps Extra High when a legacy Ultracode effort moves to a model without it", () => {
    const legacy: ReadonlyArray<ProviderOptionDescriptor> = [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          level("high", "High"),
          level("xhigh", "Extra High"),
          level("ultracode", "Ultracode"),
        ],
      },
    ];
    const carried = carryModelOptions({
      previous: [{ id: "effort", value: "ultracode" }],
      previousDescriptors: legacy,
      nextDescriptors: CODEX,
    });
    expect(carried.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
    expect(carried.dropped).toEqual(["Ultracode"]);
  });

  it("does not report switched-off toggles or default choices as lost", () => {
    const carried = carryModelOptions({
      previous: [
        { id: "fastMode", value: false },
        { id: "ultracode", value: false },
        { id: "serviceTier", value: "default" },
      ],
      previousDescriptors: [...CLAUDE, ...CODEX.slice(1)],
      nextDescriptors: COPILOT,
    });
    expect(carried.options).toEqual([]);
    expect(carried.dropped).toEqual([]);
    expect(describeCarriedOptions(carried, "GitHub Copilot")).toBeNull();
  });

  it("names other options the new model lacks by their label", () => {
    const carried = carryModelOptions({
      previous: [{ id: "contextWindow", value: "1m" }],
      previousDescriptors: [
        {
          id: "contextWindow",
          label: "Context window",
          type: "select",
          options: [{ id: "200k", label: "200K", isDefault: true }, level("1m", "1M")],
        },
      ],
      nextDescriptors: COPILOT,
    });
    expect(carried.dropped).toEqual(["Context window"]);
  });
});

describe("missingCommonOptions", () => {
  it("names what each provider lacks", () => {
    expect(missingCommonOptions(CLAUDE)).toEqual([]);
    expect(missingCommonOptions(COPILOT)).toEqual(["Fast mode", "Ultracode"]);
    expect(missingCommonOptions(CODEX)).toEqual(["Ultracode"]);
    expect(missingCommonOptions([])).toEqual(["Effort", "Fast mode", "Ultracode"]);
  });
});
