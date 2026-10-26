import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeFallbackOptions } from "@specweave-studio/shared/fallbackOptions";
import { act } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  FallbackOptionsPanel,
  fallbackOptionAccessLabel,
  fallbackOptionStatusLabel,
} from "./FallbackOptionsPanel";
import {
  fallbackFamilySummaryLabel,
  isSupersededOption,
  layoutFallbackFamily,
  modelLineAndVersion,
  summarizeFallbackFamily,
} from "./fallbackOptionsLayout";

const now = Date.parse("2026-10-24T12:00:00.000Z");

function provider(
  id: string,
  driver: string,
  name: string,
  used: number | null,
  models: ReadonlyArray<readonly [string, string]>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(now).toISOString(),
    version: null,
    models: models.map(([slug, label]) => ({
      slug,
      name: label,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: new Date(now).toISOString(),
            windows: [
              {
                id: "five_hour",
                kind: "session" as const,
                label: "Session",
                usedPercent: used,
                resetsAt: "2026-10-24T15:00:00.000Z",
              },
            ],
          },
        }),
  };
}

const groups = describeFallbackOptions({
  providers: [
    provider("codex", "codex", "Codex", 40, [["gpt-6.1-sol", "GPT-6.1 Sol"]]),
    provider("grok", "grok", "Grok", 5, [["grok-4.7", "Grok 4.7"]]),
  ],
  rule: {
    providerLimitFallbackModelSelection: null,
    providerLimitExcludedModels: [{ model: "grok-4.7" }],
  },
  nowMs: now,
  belowPercent: 95,
});

const familyTriggers = (renderer: ReturnType<typeof create>) =>
  renderer.root.findAll(
    (node) => node.type === "button" && typeof node.props["aria-expanded"] === "boolean",
  );

function openFamilies(renderer: ReturnType<typeof create>) {
  for (const trigger of familyTriggers(renderer))
    if (!trigger.props["aria-expanded"])
      act(() => trigger.props.onClick?.({ preventDefault() {} }));
}

// The Claude subscription as a real machine lists it: current lines first, then older versions.
const claudeModels: ReadonlyArray<readonly [string, string]> = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-opus-4-7", "Claude Opus 4.7"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-opus-4-5", "Claude Opus 4.5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function claudeFamily(rule: Partial<Parameters<typeof describeFallbackOptions>[0]["rule"]> = {}) {
  const copilot = provider("copilot", "acpRegistry", "GitHub Copilot", null, [
    ["claude-opus-5.5", "Claude Opus 5.5"],
  ]);
  return describeFallbackOptions({
    providers: [
      provider("claudeAgent", "claudeAgent", "Claude", 49, claudeModels),
      { ...copilot, models: copilot.models.map((model) => ({ ...model, isCustom: true })) },
    ],
    rule: { providerLimitFallbackModelSelection: null, ...rule },
    nowMs: now,
    belowPercent: 95,
  }).find((group) => group.family === "claude")!;
}

const names = (options: ReadonlyArray<{ readonly modelName: string }>) =>
  options.map((option) => option.modelName);

describe("fallbackOptionsLayout", () => {
  it("reads a model's line and version from its name", () => {
    expect(modelLineAndVersion("Claude Opus 4.8")).toEqual({
      line: "claude opus #",
      version: [4, 8],
    });
    expect(modelLineAndVersion("claude-opus-5-5")).toEqual({
      line: "claude-opus-#",
      version: [5, 5],
    });
    expect(modelLineAndVersion("GPT-6.1 Sol")?.line).toBe("gpt-# sol");
    expect(modelLineAndVersion("Auto")).toBeNull();
  });

  it("folds older versions of a line and keeps every current line in sight", () => {
    const [claude, copilot] = layoutFallbackFamily(claudeFamily());
    expect(names(claude!.shown)).toEqual([
      "Claude Opus 5.5",
      "Claude Fable 5.1",
      "Claude Sonnet 5.5",
      "Claude Haiku 5.5",
    ]);
    expect(names(claude!.older)).toEqual([
      "Claude Fable 5",
      "Claude Opus 5",
      "Claude Opus 4.8",
      "Claude Opus 4.7",
      "Claude Opus 4.6",
      "Claude Opus 4.5",
      "Claude Sonnet 5",
      "Claude Haiku 4.5",
    ]);
    expect(names(copilot!.shown)).toEqual(["Claude Opus 5.5"]);
    expect(copilot!.older).toEqual([]);
  });

  it("never folds an excluded or ordered model away", () => {
    const [claude] = layoutFallbackFamily(
      claudeFamily({
        providerLimitExcludedModels: [{ model: "claude-opus-4-5" }],
        providerLimitFallbackModels: [
          { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-8" },
        ],
      }),
    );
    expect(names(claude!.shown)).toContain("Claude Opus 4.5");
    expect(names(claude!.shown)).toContain("Claude Opus 4.8");
    expect(names(claude!.older)).not.toContain("Claude Opus 4.5");
  });

  it("says a provider's shared status and usage once", () => {
    const [claude, copilot] = layoutFallbackFamily(
      claudeFamily({ providerLimitExcludedModels: [{ model: "claude-haiku-5-5" }] }),
    );
    expect(claude!.providerName).toBe("Claude");
    expect(claude!.common).toEqual({ status: "ready", access: "usage-read", usedPercent: 49 });
    expect(copilot!.common.access).toBe("no-usage-reported");
  });

  it("names a model without a version as never older", () => {
    const family = claudeFamily();
    const auto = { ...family.options[0]!, modelName: "Auto" };
    expect(isSupersededOption(auto, family.options)).toBe(false);
  });

  it("summarizes a folded family in one line", () => {
    const family = claudeFamily({ providerLimitExcludedModels: [{ model: "claude-opus-4-5" }] });
    expect(fallbackFamilySummaryLabel(summarizeFallbackFamily(family))).toBe(
      "13 models · 11 ready now · 1 excluded",
    );
    expect(fallbackFamilySummaryLabel({ total: 1, usable: 1, excluded: 0 })).toBe(
      "1 model · 1 ready now",
    );
  });
});

describe("FallbackOptionsPanel", () => {
  it("labels status and access in plain words", () => {
    const sol = groups.find((group) => group.family === "openai")!.options[0]!;
    expect(fallbackOptionStatusLabel(sol)).toBe("Can take a limited thread");
    expect(fallbackOptionAccessLabel(sol)).toBe("Plan usage 40% used");
    const stale = { ...sol, status: "unverified" as const };
    expect(fallbackOptionStatusLabel(stale)).toBe("Signed in, no recent usage reading");
    expect(fallbackOptionAccessLabel(stale)).toBe("Last read 40% used");
    expect(fallbackOptionAccessLabel({ ...stale, usedPercent: null })).toBe("Plan usage not read");
  });

  it("calls a reading older than the freshness window the last one, not current room", () => {
    const [stale] = describeFallbackOptions({
      providers: [provider("codex", "codex", "Codex", 22, [["gpt-6.1-sol", "GPT-6.1 Sol"]])],
      rule: { providerLimitFallbackModelSelection: null },
      nowMs: now + 60 * 60_000,
      belowPercent: 95,
    })[0]!.options;
    expect(stale!.status).toBe("unverified");
    expect(`${fallbackOptionStatusLabel(stale!)} · ${fallbackOptionAccessLabel(stale!)}`).toBe(
      "Signed in, no recent usage reading · Last read 22% used",
    );
    const grok = groups.find((group) => group.family === "xai")!.options[0]!;
    expect(fallbackOptionStatusLabel(grok)).toBe("Excluded from automatic fallback");
  });

  it("provides an exclusion control for a listed custom model", () => {
    const custom = provider("copilot", "acpRegistry", "Copilot", null, [
      ["claude-opus-5.5", "Custom Opus 5.5"],
    ]);
    const customGroups = describeFallbackOptions({
      providers: [
        { ...custom, models: custom.models.map((model) => ({ ...model, isCustom: true })) },
      ],
      rule: { providerLimitFallbackModelSelection: null },
      nowMs: now,
    });
    const onToggleExcluded = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <FallbackOptionsPanel groups={customGroups} onToggleExcluded={onToggleExcluded} />,
      );
    });
    const button = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Exclude Custom Opus 5.5",
    );
    act(() => button.props.onClick());
    expect(onToggleExcluded).toHaveBeenCalledWith("claude-opus-5.5");
    act(() => renderer.unmount());
  });

  it("toggles a model's exclusion from its row", () => {
    const onToggleExcluded = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <FallbackOptionsPanel groups={groups} onToggleExcluded={onToggleExcluded} />,
      );
    });
    openFamilies(renderer);
    const buttons = renderer.root.findAll(
      (node) => node.type === "button" && typeof node.props["aria-label"] === "string",
    );
    const labels = buttons.map((button) => button.props["aria-label"]);
    expect(labels).toEqual(["Exclude GPT-6.1 Sol", "Include Grok 4.7"]);
    act(() => buttons[1]!.props.onClick());
    expect(onToggleExcluded).toHaveBeenCalledWith("grok-4.7");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("GitHub Actions minutes");
  });

  it("starts with several families folded, each with its summary", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<FallbackOptionsPanel groups={groups} onToggleExcluded={vi.fn()} />);
    });
    const triggers = familyTriggers(renderer);
    expect(triggers.map((trigger) => trigger.props["aria-expanded"])).toEqual([false, false]);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("1 model · 1 ready now");
    expect(text).toContain("1 model · 0 ready now · 1 excluded");
    expect(text).not.toContain("Exclude GPT-6.1 Sol");
    act(() => renderer.unmount());
  });

  it("opens a lone family and shows older versions on request", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <FallbackOptionsPanel groups={[claudeFamily()]} onToggleExcluded={vi.fn()} />,
      );
    });
    const excludeLabels = () =>
      renderer.root
        .findAll(
          (node) =>
            node.type === "button" &&
            typeof node.props["aria-label"] === "string" &&
            node.props["aria-label"].startsWith("Exclude"),
        )
        .map((button) => button.props["aria-label"]);
    expect(excludeLabels()).toHaveLength(5);
    expect(excludeLabels()).not.toContain("Exclude Claude Opus 4.8");
    // The provider's status and usage appear once, not on every row.
    const text = JSON.stringify(renderer.toJSON());
    expect(text.match(/Plan usage 49% used/g)).toHaveLength(1);
    const more = renderer.root.find(
      (node) => node.type === "button" && node.props.children === "Show 8 older versions",
    );
    act(() => more.props.onClick());
    expect(excludeLabels()).toHaveLength(13);
    expect(excludeLabels()).toContain("Exclude Claude Opus 4.8");
    act(() => renderer.unmount());
  });
});
