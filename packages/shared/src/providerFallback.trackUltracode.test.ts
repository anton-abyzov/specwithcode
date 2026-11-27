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

import {
  type ProviderFallbackRule,
  resolveProviderFallback,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";

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
    rowUltracode: true,
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

  it("gives a thread that set none the row's Ultracode on the same model elsewhere", () => {
    const spent = provider("claudeAgent", "claudeAgent", [OPUS], 100, claudeOptions);
    const second = provider("claudeAgent_work", "claudeAgent", [OPUS], 10, claudeOptions);
    const opusRow = { instanceId: id("claudeAgent"), model: OPUS, options: [medium, ultracodeOn] };
    const move = (currentOptions: ModelSelection["options"]) =>
      resolveProviderFallback({
        providers: [spent, second, codex],
        currentInstanceId: id("claudeAgent"),
        currentModel: OPUS,
        currentOptions,
        rule: rule(opusRow),
        nowMs: now,
        belowPercent: 100,
        anyReady: true,
        lane: "routine",
        rowUltracode: true,
      });
    const target = move([medium]);
    expect(target?.instanceId).toBe("claudeAgent_work");
    expect(target?.options).toContainEqual(ultracodeOn);
    // A thread that turned it off keeps it off.
    const off = { id: "ultracode", value: false };
    expect(move([medium, off])?.options).toContainEqual(off);
  });

  it("adds nothing for a caller the rows do not apply to (a routine, a coordinator turn)", () => {
    const spent = provider("claudeAgent", "claudeAgent", [OPUS], 100, claudeOptions);
    const second = provider("claudeAgent_work", "claudeAgent", [OPUS], 10, claudeOptions);
    const target = resolveProviderFallback({
      providers: [spent, second, codex],
      currentInstanceId: id("claudeAgent"),
      currentModel: OPUS,
      currentOptions: [medium],
      rule: rule({ instanceId: id("claudeAgent"), model: OPUS, options: [medium, ultracodeOn] }),
      nowMs: now,
      belowPercent: 100,
      anyReady: true,
      lane: "routine",
    });
    expect(target?.instanceId).toBe("claudeAgent_work");
    expect(target?.options).toEqual([medium]);
  });

  it("keeps a thread's own off when it moves to another model with the row on", () => {
    const SONNET = "claude-sonnet-5-5";
    const spent = provider("claudeAgent", "claudeAgent", [SONNET], 100, claudeOptions);
    const second = provider("claudeAgent_work", "claudeAgent", [OPUS], 10, claudeOptions);
    const off = { id: "ultracode", value: false };
    const target = resolveProviderFallback({
      providers: [spent, second, codex],
      currentInstanceId: id("claudeAgent"),
      currentModel: SONNET,
      currentOptions: [medium, off],
      rule: {
        ...rule({ instanceId: id("claudeAgent_work"), model: OPUS, options: [medium, ultracodeOn] }),
        modelLanes: {
          routine: [
            { instanceId: id("claudeAgent"), model: SONNET, options: [medium] },
            { instanceId: id("claudeAgent_work"), model: OPUS, options: [medium, ultracodeOn] },
          ],
          complex: [],
        },
      },
      nowMs: now,
      belowPercent: 100,
      anyReady: true,
      lane: "routine",
      rowUltracode: true,
    });
    expect(target?.model).toBe(OPUS);
    expect(target?.options).toContainEqual(off);
    expect(target?.options).not.toContainEqual(ultracodeOn);
  });

  it("gives a worker moved to the same model on another account the row's Ultracode", () => {
    const spent = provider("claudeAgent", "claudeAgent", [OPUS], 100, claudeOptions);
    const second = provider("claudeAgent_work", "claudeAgent", [OPUS], 10, claudeOptions);
    const opusRow = { instanceId: id("claudeAgent"), model: OPUS, options: [medium, ultracodeOn] };
    const result = resolveWorkerLaunchSelection({
      preferred: { instanceId: id("claudeAgent"), model: OPUS, options: [medium] },
      coordinator: null,
      providers: [spent, second, codex],
      rule: rule(opusRow),
      nowMs: now,
    });
    expect(result.reason).toBe("same-model");
    expect(result.selection.instanceId).toBe("claudeAgent_work");
    expect(result.selection.options).toContainEqual(ultracodeOn);
  });
});
