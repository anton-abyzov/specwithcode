// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { adjacentEffort, effortWord, type ModelPickerEffort } from "./ModelPickerEffortStrip";
import { useTraitsEffortControl } from "./TraitsPicker";

const effort = (value: string | null, locked: string | null = null): ModelPickerEffort => ({
  options: [
    { id: "low", label: "low" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  value,
  locked,
  select: () => {},
  fast: null,
});

describe("adjacentEffort", () => {
  it("steps along the strip and stops at its ends", () => {
    expect(adjacentEffort(effort("high"), 1)).toBe("max");
    expect(adjacentEffort(effort("high"), -1)).toBe("low");
    expect(adjacentEffort(effort("max"), 1)).toBeNull();
    expect(adjacentEffort(effort("low"), -1)).toBeNull();
  });

  it("starts from an end when nothing is chosen, and never moves a locked effort", () => {
    expect(adjacentEffort(effort(null), 1)).toBe("low");
    expect(adjacentEffort(effort(null), -1)).toBe("max");
    expect(adjacentEffort(effort("high", "ultrathink in the prompt"), 1)).toBeNull();
  });

  it("names raw level ids by their display word", () => {
    expect(effortWord({ id: "low", label: "low" })).toBe("Low");
    expect(effortWord({ id: "xhigh", label: "xhigh" })).toBe("Extra High");
    expect(effortWord({ id: "max", label: "Maximum" })).toBe("Maximum");
  });
});

describe("useTraitsEffortControl", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const models: ServerProviderModel[] = [
    {
      slug: "gpt",
      name: "GPT",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
          { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false },
        ],
      },
    },
  ];
  let container: HTMLDivElement;
  let root: Root;
  let latest: ModelPickerEffort | null = null;
  function Probe(props: {
    onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
    model?: string;
  }) {
    latest = useTraitsEffortControl({
      provider: ProviderDriverKind.make("codex"),
      instanceId,
      models,
      model: props.model ?? "gpt",
      prompt: "",
      onPromptChange: () => {},
      planModeEnabled: false,
      onModelOptionsChange: props.onModelOptionsChange,
    });
    return null;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    latest = null;
  });

  it("reads the model's effort and Fast mode and writes them back as options", async () => {
    const onModelOptionsChange = vi.fn();
    await act(async () => root.render(<Probe onModelOptionsChange={onModelOptionsChange} />));
    expect(latest?.options.map((option) => option.id)).toEqual(["low", "high"]);
    expect(latest?.value).toBe("high");
    expect(latest?.fast?.on).toBe(false);
    latest!.select("low");
    expect(onModelOptionsChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ id: "reasoningEffort", value: "low" }]),
    );
    latest!.fast!.toggle();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ id: "fastMode", value: true }]),
    );
  });

  it("offers nothing for a model without effort or speed options", async () => {
    await act(async () => root.render(<Probe onModelOptionsChange={vi.fn()} model="other" />));
    expect(latest).toBeNull();
  });
});
