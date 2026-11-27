/**
 * A thread that falls back along its track onto a row with Ultracode on runs
 * with it, unless the thread itself turned Ultracode off (1506).
 */
import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ProviderFallbackRule, resolveProviderFallback } from "./providerFallback.ts";

const now = Date.parse("2026-11-27T15:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const id = ProviderInstanceId.make;

const claudeOptions = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "xhigh", label: "Extra High" },
      ],
    },
    { id: "ultracode", label: "Ultracode", type: "boolean" as const },
  ],
};
const codexOptions = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "medium", label: "Medium", isDefault: true }],
    },
  ],
};

function provider(
  instanceId: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number,
  capabilities: ServerProvider["models"][number]["capabilities"],
): ServerProvider {
  return {
    instanceId: id(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(now),
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(now),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: used,
          resetsAt: iso(now + 3 * 60 * 60_000),
        },
      ],
    },
  };
}

const OPUS = "claude-opus-5-5";
const SOL = "gpt-6.2-sol";
const claude = provider("claudeAgent", "claudeAgent", [OPUS], 20, claudeOptions);
const codex = provider("codex", "codex", [SOL], 100, codexOptions);
const providers = [claude, codex];
const medium = { id: "effort", value: "medium" };
const ultracodeOn = { id: "ultracode", value: true };
const sol: ModelSelection = {
  instanceId: id("codex"),
  model: SOL,
  options: [{ id: "reasoningEffort", value: "medium" }],
};

const rule = (opusRow: ModelSelection): ProviderFallbackRule => ({
  threadModelMode: "tracks",
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: null,
  defaultModelSelection: null,
  modelLanes: { routine: [sol, opusRow], complex: [] },
});

const fallBack = (opusRow: ModelSelection) =>
  resolveProviderFallback({
    providers,
    currentInstanceId: id("codex"),
    currentModel: SOL,
    currentOptions: sol.options,
    rule: rule(opusRow),
    nowMs: now,
    belowPercent: 100,
    anyReady: true,
    lane: "routine",
  });

describe("falling back onto a track row", () => {
  it("takes the row's Ultracode when the row has it on", () => {
    const target = fallBack({
      instanceId: id("claudeAgent"),
      model: OPUS,
      options: [medium, ultracodeOn],
    });
    expect(target?.model).toBe(OPUS);
    expect(target?.options).toContainEqual(ultracodeOn);
  });

  it("adds nothing when the row has it off", () => {
    const target = fallBack({ instanceId: id("claudeAgent"), model: OPUS, options: [medium] });
    expect(target?.model).toBe(OPUS);
    expect(target?.options?.some((option) => option.id === "ultracode")).toBe(false);
  });
});
