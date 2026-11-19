import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { COORDINATOR_RECOMMENDED_TRAITS } from "../../studio/shellModel";
import {
  buildTraitsTriggerDisplay,
  buildTraitsTriggerParts,
  traitsTriggerDescription,
  buildUnavailableModelOptionDescriptors,
  traitOptionBadges,
  effectiveUltracodeState,
  type TraitsUltracodeDefault,
  ultracodeUnsetNote,
} from "./TraitsPicker";
import { getComposerProviderState, traitsUltracodeDefault } from "./composerProviderState";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "ultrafast" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
    });
  });

  it("pairs fast mode with reasoning before the context window", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High Fast · 1M",
    });
    expect(display([EFFORT, CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({
      label: "High Fast · 1M",
    });
  });

  it.each(["reasoningEffort", "reasoning", "effort", "variant", "thinking"])(
    "pairs Fast with %s even when context is the primary select",
    (id) => {
      for (const speed of [fastModeDescriptor(true), serviceTierDescriptor("priority")]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: CODEX,
            descriptors: [
              selectDescriptor("profile", [{ id: "balanced", label: "Balanced" }], "balanced"),
              CONTEXT_WINDOW,
              { ...EFFORT, id },
              speed,
            ],
            primarySelectDescriptorId: "profile",
            ultrathinkPromptControlled: false,
          }),
        ).toEqual({ label: "Balanced · 1M · High Fast" });
      }
      expect(
        buildTraitsTriggerDisplay({
          provider: CODEX,
          descriptors: [CONTEXT_WINDOW, { ...EFFORT, id }, serviceTierDescriptor("ultrafast")],
          primarySelectDescriptorId: CONTEXT_WINDOW.id,
          ultrathinkPromptControlled: false,
        }),
      ).toEqual({ label: "1M · High Ultrafast" });
    },
  );

  it("pairs Cursor Fast with reasoning rather than the thinking toggle", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("cursor"),
        descriptors: [
          { ...EFFORT, id: "reasoning" },
          fastModeDescriptor(true),
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        ],
        primarySelectDescriptorId: "reasoning",
        ultrathinkPromptControlled: false,
      }),
    ).toEqual({ label: "High Fast · Thinking On" });
  });

  it.each([true, false])("keeps boolean thinking %s independent of Fast", (currentValue) => {
    const thinking = {
      id: "thinking",
      label: "Thinking",
      type: "boolean" as const,
      currentValue,
    };
    const label = `Thinking ${currentValue ? "On" : "Off"}`;
    expect(display([thinking, fastModeDescriptor(true)])).toEqual({ label: `${label} · Fast` });
    expect(display([thinking, { ...EFFORT, id: "reasoning" }, fastModeDescriptor(true)])).toEqual({
      label: `${label} · High Fast`,
    });
    expect(display([thinking, fastModeDescriptor(false)])).toEqual({ label });
  });

  it("keeps speed separate when there is no reasoning descriptor", () => {
    expect(display([CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({ label: "1M · Fast" });
  });

  it.each(["Low", "Medium", "High", "Extra High", "Max", "Ultra"])(
    "preserves %s reasoning with Fast across harnesses",
    (label) => {
      for (const provider of ["codex", "claudeAgent", "cursor"]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: ProviderDriverKind.make(provider),
            descriptors: [
              { ...EFFORT, options: [{ id: "effort", label }], currentValue: "effort" },
              fastModeDescriptor(true),
            ],
            primarySelectDescriptorId: EFFORT.id,
            ultrathinkPromptControlled: false,
          }),
        ).toEqual({ label: `${label} Fast` });
      }
    },
  );

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({ label: "High" });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({ label: "High Fast" });
  });

  it("keeps Codex Ultrafast distinct from Fast", () => {
    expect(display([EFFORT, serviceTierDescriptor("ultrafast")])).toEqual({
      label: "High Ultrafast",
    });
  });

  it("uses Ultrafast without requiring a Fast tier", () => {
    const descriptor = serviceTierDescriptor("ultrafast");
    expect(
      display([
        EFFORT,
        { ...descriptor, options: descriptor.options.filter(({ id }) => id !== "priority") },
      ]),
    ).toEqual({ label: "High Ultrafast" });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({ label: "High · Flex" });
  });

  it("keeps Standard as text for models without speed tiers", () => {
    const descriptor = serviceTierDescriptor("default");
    const nonSpeedDescriptor = {
      ...descriptor,
      options: descriptor.options.filter(({ id }) => id === "default" || id === "flex"),
    };
    expect(display([EFFORT, nonSpeedDescriptor])).toEqual({ label: "High · Standard" });
    expect(display([nonSpeedDescriptor])).toEqual({ label: "Standard" });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({ label: "Standard" });
    expect(display([serviceTierDescriptor("priority")])).toEqual({ label: "Fast" });
  });

  it("keeps Ultrafast readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("ultrafast")])).toEqual({ label: "Ultrafast" });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({ label: "High · Thinking On" });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({ label: "Fast" });
    expect(display([fastModeDescriptor(false)])).toEqual({ label: "Normal" });
  });

  it("does not add Fast to a model without a speed option", () => {
    expect(display([EFFORT, CONTEXT_WINDOW])).toEqual({ label: "High · 1M" });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "" });
  });

  it("still renders prompt-controlled ultrathink with Fast", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink Fast" });
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  it("shows only saved values without inventing alternatives", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "variant", value: "max" },
        { id: "agent", value: "build" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: [{ id: "max", label: "max" }],
        currentValue: "max",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "build" }],
        currentValue: "build",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });
});

it("shows Unknown until a matching provider report provides Default", () => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "ling",
    options: [],
  };
  const input = {
    provider: ProviderDriverKind.make("opencode"),
    descriptors: [
      selectDescriptor(
        "variant",
        [
          { id: "none", label: "None" },
          { id: "thinking", label: "Thinking" },
        ],
        "",
      ),
    ],
    primarySelectDescriptorId: "variant",
    ultrathinkPromptControlled: false,
    modelSelection: selection,
  };
  expect(buildTraitsTriggerDisplay(input).label).toBe("Unknown");
  expect(
    buildTraitsTriggerDisplay({
      ...input,
      reportedModelSelection: { ...selection, options: [{ id: "variant", value: "default" }] },
    }).label,
  ).toBe("Default");
});

describe("traitOptionBadges", () => {
  it("marks Medium as recommended for a coordinator beside the provider default", () => {
    expect(
      traitOptionBadges(
        "effort",
        { id: "medium", isDefault: true },
        COORDINATOR_RECOMMENDED_TRAITS,
      ),
    ).toEqual(["Default", "Recommended"]);
    expect(
      traitOptionBadges("reasoningEffort", { id: "medium" }, COORDINATOR_RECOMMENDED_TRAITS),
    ).toEqual(["Recommended"]);
    expect(
      traitOptionBadges("effort", { id: "high", isDefault: true }, COORDINATOR_RECOMMENDED_TRAITS),
    ).toEqual(["Default"]);
  });

  it("recommends nothing for a worker picker", () => {
    expect(traitOptionBadges("effort", { id: "medium", isDefault: true }, undefined)).toEqual([
      "Default",
    ]);
    expect(traitOptionBadges("effort", { id: "medium" }, undefined)).toEqual([]);
  });
});

describe("buildTraitsTriggerParts", () => {
  const CLAUDE = ProviderDriverKind.make("claudeAgent");
  const CLAUDE_EFFORT = selectDescriptor(
    "effort",
    [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
      { id: "ultracode", label: "Ultracode" },
      { id: "ultrathink", label: "Ultrathink" },
    ],
    "high",
  );
  const thinking = (currentValue: boolean): ProviderOptionDescriptor => ({
    id: "thinking",
    label: "Thinking",
    type: "boolean",
    currentValue,
  });
  const parts = (
    descriptors: ReadonlyArray<ProviderOptionDescriptor>,
    ultrathinkPromptControlled = false,
  ) =>
    buildTraitsTriggerParts({
      provider: CLAUDE,
      descriptors,
      primarySelectDescriptorId: "contextWindow",
      ultrathinkPromptControlled,
    });

  it("labels the effort and summarizes context, thinking and speed", () => {
    expect(
      parts([CONTEXT_WINDOW, CLAUDE_EFFORT, thinking(true), fastModeDescriptor(true)]),
    ).toMatchObject({
      effort: { value: "high", label: "High" },
      details: "1M · Thinking",
      speed: { icon: "fast", label: "Fast mode" },
    });
    expect(
      parts([CONTEXT_WINDOW, CLAUDE_EFFORT, thinking(false), fastModeDescriptor(false)]),
    ).toMatchObject({ details: "1M · No thinking", speed: null });
  });

  it("capitalizes a level whose provider label is its raw id", () => {
    const copilotEffort = selectDescriptor(
      "reasoning_effort",
      [
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
      ],
      "medium",
    );
    expect(parts([copilotEffort]).effort).toEqual({ value: "medium", label: "Medium" });
  });

  it("names the Ultracode toggle beside the effort, not as one", () => {
    const toggle = (currentValue?: boolean): ProviderOptionDescriptor => ({
      id: "ultracode",
      label: "Ultracode",
      type: "boolean",
      ...(currentValue === undefined ? {} : { currentValue }),
    });
    const medium = { ...CLAUDE_EFFORT, currentValue: "medium" };
    const on = parts([medium, CONTEXT_WINDOW, toggle(true)]);
    expect(on).toMatchObject({
      effort: { value: "medium", label: "Medium" },
      details: "1M",
      ultracode: true,
    });
    expect(on.label).toBe("Medium · 1M · Ultracode");
    expect(traitsTriggerDescription(on)).toBe("Medium effort · Ultracode · 1M");
    for (const off of [toggle(false), toggle()]) {
      const result = parts([medium, CONTEXT_WINDOW, off]);
      expect(result).toMatchObject({ details: "1M", ultracode: false });
      expect(result.label).toBe("Medium · 1M");
    }
  });

  it("names Ultracode as the effort", () => {
    expect(parts([{ ...CLAUDE_EFFORT, currentValue: "ultracode" }, CONTEXT_WINDOW]).effort).toEqual(
      { value: "ultracode", label: "Ultracode" },
    );
  });

  it("shows Ultrathink while the prompt asks for it", () => {
    const result = buildTraitsTriggerParts({
      provider: CLAUDE,
      descriptors: [CLAUDE_EFFORT, CONTEXT_WINDOW],
      primarySelectDescriptorId: "effort",
      ultrathinkPromptControlled: true,
    });
    expect(result.effort).toEqual({ value: "ultrathink", label: "Ultrathink" });
    expect(result.details).toBe("1M");
  });

  it("drops the standard Codex tier and keeps a faster one", () => {
    const codex = (tier: "default" | "priority") =>
      buildTraitsTriggerParts({
        provider: CODEX,
        descriptors: [EFFORT, serviceTierDescriptor(tier)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: false,
      });
    expect(codex("default")).toMatchObject({
      effort: { label: "High" },
      details: "",
      speed: null,
    });
    expect(codex("priority")).toMatchObject({
      effort: { label: "High" },
      details: "",
      speed: { icon: "fast", label: "Fast service tier" },
    });
    expect(traitsTriggerDescription(codex("priority"))).toBe("High effort · Fast service tier");
    expect(traitsTriggerDescription(codex("default"))).toBe("High effort");
  });

  it("draws Ultrafast with its own bolt and names it", () => {
    const parts = buildTraitsTriggerParts({
      provider: CODEX,
      descriptors: [EFFORT, serviceTierDescriptor("ultrafast")],
      primarySelectDescriptorId: "reasoningEffort",
      ultrathinkPromptControlled: false,
    });
    expect(parts.speed).toEqual({ icon: "ultrafast", label: "Ultrafast service tier" });
    expect(traitsTriggerDescription(parts)).toBe("High effort · Ultrafast service tier");
  });

  it("falls back to the plain label without an effort setting", () => {
    expect(parts([CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({
      label: "1M · Fast",
      effort: null,
      details: "",
      speed: { icon: "fast", label: "Fast mode" },
      ultracode: false,
    });
  });
});

describe("the Ultracode default on the chip and menu", () => {
  const CLAUDE = ProviderDriverKind.make("claudeAgent");
  const high = selectDescriptor(
    "effort",
    [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
    "high",
  );
  const toggle = (currentValue?: boolean): ProviderOptionDescriptor => ({
    id: "ultracode",
    label: "Ultracode",
    type: "boolean",
    ...(currentValue === undefined ? {} : { currentValue }),
  });
  const ON: TraitsUltracodeDefault = { state: "on", reason: "default", scope: "threads" };
  const PAUSED: TraitsUltracodeDefault = { state: "paused", reason: "usage", scope: "threads" };
  const COORDINATOR: TraitsUltracodeDefault = {
    state: "off",
    reason: "chat-kind",
    scope: "threads",
  };
  const parts = (
    descriptors: ReadonlyArray<ProviderOptionDescriptor>,
    ultracodeDefault?: TraitsUltracodeDefault,
  ) =>
    buildTraitsTriggerParts({
      provider: CLAUDE,
      descriptors,
      primarySelectDescriptorId: "effort",
      ultrathinkPromptControlled: false,
      ...(ultracodeDefault ? { ultracodeDefault } : {}),
    });

  it("reads an unset toggle as off without the default, as before", () => {
    const result = parts([high, toggle()]);
    expect(result.ultracode).toBe(false);
    expect(result).not.toHaveProperty("ultracodePaused");
    expect(result.label).toBe("High");
    expect(traitsTriggerDescription(result)).toBe("High effort");
  });

  it("reads an unset toggle like an explicit On while the default is on", () => {
    const result = parts([high, toggle()], ON);
    expect(result.ultracode).toBe(true);
    expect(result.label).toBe("High · Ultracode");
    expect(traitsTriggerDescription(result)).toBe("High effort · Ultracode");
    expect(traitsTriggerDescription(result)).toBe(traitsTriggerDescription(parts([high, toggle(true)])));
  });

  it("names a paused default, and only for an unset toggle", () => {
    const result = parts([high, toggle()], PAUSED);
    expect(result).toMatchObject({ ultracode: false, ultracodePaused: true });
    expect(result.label).toBe("High · Ultracode paused");
    expect(traitsTriggerDescription(result)).toBe("High effort · Ultracode paused");
    // On set in the chat still runs while the default is paused.
    expect(parts([high, toggle(true)], PAUSED)).toMatchObject({ ultracode: true });
    expect(parts([high, toggle(true)], PAUSED)).not.toHaveProperty("ultracodePaused");
  });

  it("shows effort alone for a coordinator, a toggle set Off and a model without the toggle", () => {
    for (const result of [
      parts([high, toggle()], COORDINATOR),
      parts([high, toggle(false)], ON),
      parts([high, toggle(false)], PAUSED),
      parts([high], ON),
      parts([high], PAUSED),
    ]) {
      expect(result.ultracode).toBe(false);
      expect(result).not.toHaveProperty("ultracodePaused");
      expect(result.label).toBe("High");
    }
  });

  it("resolves the effective state: the chat's toggle wins over the default", () => {
    expect(effectiveUltracodeState(undefined, undefined)).toBe("off");
    expect(effectiveUltracodeState(undefined, ON)).toBe("on");
    expect(effectiveUltracodeState(undefined, PAUSED)).toBe("paused");
    expect(effectiveUltracodeState(false, ON)).toBe("off");
    expect(effectiveUltracodeState(true, COORDINATOR)).toBe("on");
  });

  it("says why an unset toggle reads the way it does", () => {
    expect(ultracodeUnsetNote(undefined)).toBe("Not set: follows the Claude workflow mode");
    expect(ultracodeUnsetNote(ON)).toBe(
      "Not set here: on by default for threads. Uses more of your Claude limit.",
    );
    expect(ultracodeUnsetNote({ ...ON, scope: "all" })).toBe(
      "Not set here: on by default for all chats. Uses more of your Claude limit.",
    );
    expect(ultracodeUnsetNote(PAUSED)).toBe(
      "Not set here: the default is paused until your Claude limit resets.",
    );
    expect(ultracodeUnsetNote({ state: "off", reason: "workflows-disabled", scope: "threads" })).toBe(
      "Not set here: off because Claude workflows are disabled.",
    );
    expect(ultracodeUnsetNote({ state: "off", reason: "api-key", scope: "threads" })).toBe(
      "Not set here: off by default when Claude bills an API key.",
    );
    expect(ultracodeUnsetNote(COORDINATOR)).toBeNull();
    expect(ultracodeUnsetNote({ state: "off", reason: "default-off", scope: "off" })).toBeNull();
  });

  const nowMs = Date.parse("2026-11-14T12:00:00.000Z");
  const claude = (patch: Partial<ServerProvider> = {}) =>
    ({
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: { status: "authenticated" },
      ...patch,
    }) as unknown as ServerProvider;
  const weekly = (usedPercent: number, resetsAt = "2026-11-15T00:00:00.000Z") =>
    claude({
      usageLimits: {
        windows: [{ id: "seven_day", kind: "weekly", usedPercent, resetsAt }],
      },
    } as unknown as Partial<ServerProvider>);
  const resolve = (provider: ServerProvider | undefined, chatKind: "thread" | "coordinator") =>
    traitsUltracodeDefault({
      settings: { claudeWorkflowMode: "on-request", claudeUltracodeDefault: "threads" },
      chatKind,
      provider,
      model: "claude-opus-5-5",
      nowMs,
    });

  it("reads the chat's instance: API keys stay off, high usage pauses, unknown usage does not", () => {
    expect(resolve(undefined, "thread")).toEqual(ON);
    expect(resolve(claude(), "thread")).toEqual(ON);
    expect(resolve(weekly(79), "thread")).toEqual(ON);
    expect(resolve(weekly(82), "thread")).toEqual(PAUSED);
    // The pause ends at the reset.
    expect(resolve(weekly(82, "2026-11-14T11:00:00.000Z"), "thread")).toEqual(ON);
    expect(
      resolve(claude({ auth: { status: "authenticated", apiKeyBilling: true } } as never), "thread"),
    ).toEqual({ state: "off", reason: "api-key", scope: "threads" });
    expect(resolve(claude(), "coordinator")).toEqual(COORDINATOR);
    expect(
      traitsUltracodeDefault({
        settings: { claudeWorkflowMode: "automatic", claudeUltracodeDefault: "threads" },
        chatKind: "coordinator",
        provider: claude(),
        model: "claude-opus-5-5",
        nowMs,
      }),
    ).toEqual({ state: "on", reason: "default", scope: "all" });
  });

  it("never dispatches the default: an unset toggle sends no Ultracode option", () => {
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "claude-opus-5-5",
        name: "Opus 5.5",
        isCustom: false,
        capabilities: { optionDescriptors: [high, toggle()] },
      } as ServerProviderModel,
    ];
    const state = getComposerProviderState({
      provider: CLAUDE,
      model: "claude-opus-5-5",
      models,
      modelOptions: [{ id: "effort", value: "high" }],
      planModeEnabled: false,
    });
    expect(state.modelOptionsForDispatch?.some((option) => option.id === "ultracode") ?? false).toBe(
      false,
    );
  });
});
