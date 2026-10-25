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

describe("FallbackOptionsPanel", () => {
  it("labels status and access in plain words", () => {
    const sol = groups.find((group) => group.family === "openai")!.options[0]!;
    expect(fallbackOptionStatusLabel(sol)).toBe("Can take a limited thread");
    expect(fallbackOptionAccessLabel(sol)).toBe("Plan usage 40% used");
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
});
