/**
 * A limit fallback onto another model used to send no effort, so the new
 * model ran at its provider's own default: Max on Muse Wonder Full.
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ProviderFallbackRule, resolveProviderFallback } from "./providerFallback.ts";

const now = Date.parse("2026-11-18T09:00:00.000Z");
const id = ProviderInstanceId.make;

const levels = (ids: ReadonlyArray<string>, optionId = "reasoningEffort") => ({
  optionDescriptors: [
    {
      id: optionId,
      label: "Reasoning effort",
      type: "select" as const,
      options: ids.map((level) => ({
        id: level,
        label: level,
        ...(level === "max" ? { isDefault: true } : {}),
      })),
    },
  ],
});

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; levels: ReadonlyArray<string> | null; optionId?: string }>,
): ServerProvider {
  return {
    instanceId: id(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-18T09:00:00.000Z",
    version: null,
    models: models.map((model, index) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: model.levels === null ? null : levels(model.levels, model.optionId),
      ...(index === 0 ? { isDefault: true } : {}),
    })),
    slashCommands: [],
    skills: [],
  };
}

const claude = provider("claudeAgent", "claudeAgent", [
  {
    slug: "claude-opus-5-5",
    levels: ["low", "medium", "high", "xhigh", "max"],
    optionId: "effort",
  },
]);
const muse = provider("muse", "muse", [
  { slug: "muse-wonder-full-1.0", levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
]);
const museHighOnly = provider("muse", "muse", [
  { slug: "muse-wonder-full-1.0", levels: ["high", "max"] },
]);
const museNoEffort = provider("muse", "muse", [{ slug: "muse-wonder-full-1.0", levels: null }]);

const rule = (target: {
  instanceId: ProviderInstanceId;
  model: string;
  options?: ReadonlyArray<{ id: string; value: string }>;
}) =>
  ({
    providerLimitAction: "switch",
    providerLimitFallbackModelSelection: null,
    providerLimitFallbackModels: [target],
    providerLimitSwitchAtPercent: null,
    defaultModelSelection: null,
    modelLanes: null,
  }) satisfies ProviderFallbackRule;

const fallback = (
  providers: ReadonlyArray<ServerProvider>,
  currentOptions?: ReadonlyArray<{ id: string; value: string }>,
) =>
  resolveProviderFallback({
    providers,
    currentInstanceId: claude.instanceId,
    currentModel: "claude-opus-5-5",
    ...(currentOptions === undefined ? {} : { currentOptions: [...currentOptions] }),
    rule: rule({ instanceId: id("muse"), model: "muse-wonder-full-1.0" }),
    nowMs: now,
    anyReady: true,
    limitedInstanceIds: new Set([claude.instanceId]),
  });

describe("a limit fallback onto another model", () => {
  it("starts Muse Wonder Full at Medium when the thread named no level", () => {
    expect(fallback([claude, muse])).toEqual({
      instanceId: id("muse"),
      model: "muse-wonder-full-1.0",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });

  it("carries the thread's own level, under the id the new model reads", () => {
    expect(fallback([claude, muse], [{ id: "effort", value: "high" }])?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("takes the nearest level the new model offers", () => {
    expect(fallback([claude, museHighOnly])?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("sends no effort to a model without one", () => {
    expect(fallback([claude, museNoEffort])).toEqual({
      instanceId: id("muse"),
      model: "muse-wonder-full-1.0",
    });
  });

  it("leaves a move that keeps the model as it was", () => {
    const claudeElsewhere = provider("claude-work", "claudeAgent", [
      { slug: "claude-opus-5-5", levels: ["low", "medium", "high"], optionId: "effort" },
    ]);
    expect(
      resolveProviderFallback({
        providers: [claude, claudeElsewhere],
        currentInstanceId: claude.instanceId,
        currentModel: "claude-opus-5-5",
        rule: rule({ instanceId: id("claude-work"), model: "claude-opus-5-5" }),
        nowMs: now,
        anyReady: true,
        limitedInstanceIds: new Set([claude.instanceId]),
      }),
    ).toEqual({ instanceId: id("claude-work"), model: "claude-opus-5-5" });
  });

  it("moves a target's own level saved under another harness's id to the id its model reads", () => {
    // A track entry saved with Claude's `effort` id now resolved onto Muse (`reasoningEffort`).
    const target = {
      instanceId: id("muse"),
      model: "muse-wonder-full-1.0",
      options: [{ id: "effort", value: "xhigh" }],
    };
    const moved = resolveProviderFallback({
      providers: [claude, museHighOnly],
      currentInstanceId: claude.instanceId,
      currentModel: "claude-opus-5-5",
      rule: rule(target),
      nowMs: now,
      anyReady: true,
      limitedInstanceIds: new Set([claude.instanceId]),
    });
    // Mapped to the nearest level Muse offers here (a tie goes to the higher
    // level), with no second effort option.
    expect(moved?.options).toEqual([{ id: "reasoningEffort", value: "max" }]);
  });
});
