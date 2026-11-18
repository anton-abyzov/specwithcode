import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";

import {
  describeModelSelection,
  duplicateOptionIds,
  modelChangeCardText,
  modelSelectionProblem,
  optionsLeftOff,
  projectThreadsUseTracks,
  sameModelSelection,
  savedProjectModel,
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

describe("a selection that names an option twice", () => {
  const twice: ModelSelection = {
    ...opus,
    options: [
      { id: "effort", value: "high" },
      { id: "effort", value: "medium" },
    ],
  };

  it("is the same only as its exact copy", () => {
    expect(duplicateOptionIds(twice)).toEqual(["effort"]);
    expect(duplicateOptionIds(fable)).toEqual([]);
    expect(sameModelSelection(twice, { ...twice, options: [...twice.options!] })).toBe(true);
    // Not the same as either reading of it, in either direction or order.
    for (const value of ["high", "medium"]) {
      const one: ModelSelection = {
        ...opus,
        options: [
          { id: "effort", value },
          { id: "thinking", value: true },
        ],
      };
      expect(sameModelSelection(twice, one)).toBe(false);
      expect(sameModelSelection(one, twice)).toBe(false);
    }
    expect(sameModelSelection(twice, { ...twice, options: twice.options!.toReversed() })).toBe(
      false,
    );
  });
});

describe("savedProjectModel", () => {
  const id = ProjectId.make("project");
  const project = (defaultModelSelection: ModelSelection | null, coordinator?: ModelSelection) =>
    ({
      id,
      defaultModelSelection,
      workspaceSettings: { coordinatorModelSelection: coordinator ?? null },
    }) as Parameters<typeof savedProjectModel>[0];
  const settings = (override: Record<string, unknown> | undefined) =>
    ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: override === undefined ? {} : { [id]: override },
    }) as ServerSettings;

  it("reads the project's own models when Settings has no override", () => {
    expect(savedProjectModel(project(fable), "threads", settings(undefined))).toEqual({
      model: fable,
      saved: true,
    });
    expect(savedProjectModel(project(null), "threads", null)).toEqual({
      model: null,
      saved: false,
    });
    expect(savedProjectModel(project(fable, opus), "coordinator", null)).toEqual({
      model: opus,
      saved: true,
    });
    expect(savedProjectModel(project(fable), "coordinator", null).saved).toBe(false);
    // An override of another key says nothing about the model.
    expect(
      savedProjectModel(project(null), "threads", settings({ threadModelMode: "model" })).saved,
    ).toBe(false);
  });

  it("puts a Project settings override first, even one that says no model", () => {
    expect(
      savedProjectModel(project(opus), "threads", settings({ defaultModelSelection: fable })),
    ).toEqual({ model: fable, saved: true });
    expect(
      savedProjectModel(project(null), "threads", settings({ defaultModelSelection: fable })),
    ).toEqual({ model: fable, saved: true });
    expect(
      savedProjectModel(project(null), "threads", settings({ defaultModelSelection: null })),
    ).toEqual({ model: null, saved: true });
    // The coordinator's model has no Settings override.
    expect(
      savedProjectModel(project(null), "coordinator", settings({ defaultModelSelection: fable }))
        .saved,
    ).toBe(false);
  });

  it("knows a project whose threads start from the tracks", () => {
    expect(projectThreadsUseTracks(project(fable), settings({ threadModelMode: "tracks" }))).toBe(
      true,
    );
    expect(projectThreadsUseTracks(project(fable), settings(undefined))).toBe(false);
    expect(projectThreadsUseTracks(project(fable), null)).toBe(false);
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
  it("accepts a listed model or alias with options it offers", () => {
    expect(modelSelectionProblem(opus, providers)).toBeNull();
    expect(modelSelectionProblem(fable, providers)).toBeNull();
    expect(modelSelectionProblem({ instanceId: claude, model: "fable" }, providers)).toBeNull();
  });

  it("refuses what the catalog cannot confirm", () => {
    expect(modelSelectionProblem(opus, [])).toContain("model list is not loaded yet");
    expect(
      modelSelectionProblem({ ...opus, options: [{ id: "turbo", value: true }] }, providers),
    ).toContain(
      'Claude Opus 5.5 has no option "turbo"; it offers: contextWindow, effort, ultracode, thinking',
    );
    expect(
      modelSelectionProblem({ ...opus, options: [{ id: "effort", value: "extreme" }] }, providers),
    ).toContain("takes one of: medium, high");
    expect(
      modelSelectionProblem({ ...opus, options: [{ id: "ultracode", value: "on" }] }, providers),
    ).toContain("pass true or false");
    expect(
      modelSelectionProblem({ ...opus, options: [{ id: "effort", value: true }] }, providers),
    ).toContain("takes one of");
    expect(
      modelSelectionProblem(
        {
          ...opus,
          options: [
            { id: "ultracode", value: true },
            { id: "ultracode", value: false },
          ],
        },
        providers,
      ),
    ).toContain("ultracode is repeated");
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
  it("keeps an agent's reason to one paragraph", () => {
    const text = modelChangeCardText({
      projectTitle: "specweave",
      role: "threads",
      from: null,
      to: opus,
      providers,
      reason: "Needed.\n\nNow: nothing of yours changes.\n",
    });
    expect(text.split("\n\n")).toHaveLength(5);
    expect(text.split("\n\n")[1]).toBe("Now: none saved");
    expect(text.split("\n\n").at(-1)).toBe("Reason: Needed. Now: nothing of yours changes.");
  });

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
