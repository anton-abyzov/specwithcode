import { describe, expect, it } from "vite-plus/test";
import {
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";

import {
  describeModelSelection,
  modelChangeCardText,
  modelSelectionProblem,
  optionsLeftOff,
  sameModelSelection,
} from "./projectModelChange.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const fable: ModelSelection = {
  instanceId: claude,
  model: "claude-fable-5-2",
  options: [
    { id: "contextWindow", value: "1m" },
    { id: "effort", value: "high" },
    { id: "ultracode", value: true },
    { id: "thinking", value: true },
  ],
};
const opus: ModelSelection = {
  instanceId: claude,
  model: "claude-opus-5-5",
  options: [
    { id: "effort", value: "high" },
    { id: "thinking", value: true },
  ],
};
const descriptors = [
  {
    id: "contextWindow",
    label: "Context window",
    type: "select" as const,
    options: [
      { id: "200k", label: "200k" },
      { id: "1m", label: "1M" },
    ],
  },
  {
    id: "effort",
    label: "Effort",
    type: "select" as const,
    options: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
  { id: "ultracode", label: "Ultracode", type: "boolean" as const },
  { id: "thinking", label: "Thinking", type: "boolean" as const },
];
const providers = [
  {
    instanceId: claude,
    displayName: "Claude Code",
    models: [
      {
        slug: "claude-fable-5-2",
        name: "Claude Fable 5.2",
        aliases: ["fable"],
        isCustom: false,
        capabilities: { optionDescriptors: descriptors },
      },
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        isCustom: false,
        capabilities: { optionDescriptors: descriptors },
      },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;

describe("sameModelSelection", () => {
  it("ignores option order and treats no options like an empty list", () => {
    expect(sameModelSelection(fable, { ...fable, options: fable.options!.toReversed() })).toBe(
      true,
    );
    expect(
      sameModelSelection(
        { instanceId: claude, model: "claude-opus-5-5" },
        { instanceId: claude, model: "claude-opus-5-5", options: [] },
      ),
    ).toBe(true);
    expect(sameModelSelection(null, null)).toBe(true);
  });

  it("tells apart another model, provider, option value, or a dropped option", () => {
    expect(sameModelSelection(fable, opus)).toBe(false);
    expect(sameModelSelection(fable, null)).toBe(false);
    expect(
      sameModelSelection(fable, { ...fable, instanceId: ProviderInstanceId.make("copilot") }),
    ).toBe(false);
    expect(
      sameModelSelection(fable, {
        ...fable,
        options: fable.options!.filter((option) => option.id !== "ultracode"),
      }),
    ).toBe(false);
    expect(
      sameModelSelection(fable, {
        ...fable,
        options: fable.options!.map((option) =>
          option.id === "effort" ? { ...option, value: "medium" } : option,
        ),
      }),
    ).toBe(false);
    // Ultracode switched off is a decision; Ultracode never set follows the default.
    expect(
      sameModelSelection(opus, {
        ...opus,
        options: [...opus.options!, { id: "ultracode", value: false }],
      }),
    ).toBe(false);
  });
});

describe("describeModelSelection", () => {
  it("names the model, provider and every option by the catalog's labels", () => {
    expect(describeModelSelection(fable, providers)).toBe(
      "Claude Fable 5.2 on Claude Code (Context window 1M, Effort High, Ultracode on, Thinking on)",
    );
  });

  it("falls back to ids when this machine does not list the model", () => {
    expect(describeModelSelection(fable, [])).toBe(
      "claude-fable-5-2 on claudeAgent (Context window 1m, Effort high, Ultracode on, Thinking on)",
    );
    expect(describeModelSelection({ instanceId: claude, model: "claude-opus-5-5" }, [])).toBe(
      "claude-opus-5-5 on claudeAgent (no options set: the model's defaults)",
    );
    expect(describeModelSelection(null, providers)).toBe("none saved");
  });
});

describe("optionsLeftOff", () => {
  it("lists what the person had set that the new choice does not name", () => {
    expect(optionsLeftOff(fable, opus, providers)).toEqual(["Context window 1M", "Ultracode on"]);
    expect(optionsLeftOff(fable, fable, providers)).toEqual([]);
    expect(optionsLeftOff(null, opus, providers)).toEqual([]);
  });

  it("does not count a switched-off option as lost", () => {
    expect(
      optionsLeftOff(
        { ...opus, options: [...opus.options!, { id: "ultracode", value: false }] },
        opus,
        providers,
      ),
    ).toEqual([]);
  });
});

describe("modelSelectionProblem", () => {
  it("accepts a listed model or alias, and anything when the catalog is unknown", () => {
    expect(modelSelectionProblem(opus, providers)).toBeNull();
    expect(modelSelectionProblem({ instanceId: claude, model: "fable" }, providers)).toBeNull();
    expect(modelSelectionProblem({ instanceId: claude, model: "typo" }, [])).toBeNull();
  });

  it("names the missing provider or model", () => {
    expect(modelSelectionProblem({ instanceId: claude, model: "typo" }, providers)).toContain(
      "Claude Code does not list the model typo",
    );
    expect(
      modelSelectionProblem(
        { instanceId: ProviderInstanceId.make("nowhere"), model: "x" },
        providers,
      ),
    ).toContain("no provider nowhere");
  });
});

describe("modelChangeCardText", () => {
  it("says what the coordinator change does and omits the left-off sentence when nothing is lost", () => {
    const text = modelChangeCardText({
      projectTitle: "specweave",
      role: "coordinator",
      from: opus,
      to: fable,
      providers,
      reason: "Deep research.",
    });
    expect(text.split("\n\n")).toEqual([
      'Change the coordinator model of the project "specweave"?',
      "Now: Claude Opus 5.5 on Claude Code (Effort High, Thinking on)",
      "New: Claude Fable 5.2 on Claude Code (Context window 1M, Effort High, Ultracode on, Thinking on)",
      "The coordinator uses it from its next turn. Change it back any time in project settings.",
      "Reason: Deep research.",
    ]);
  });
});
