/**
 * The fallback sweep keeps a thread's own Ultracode: it never reads a row's
 * (1506 D-05), and an off the thread chose stays off. A worker launch moved to
 * the same model on another account takes the row's, as launches do.
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

describe("falling back onto a track row", () => {
  it("keeps the thread's own options on the same model elsewhere, reading no row", () => {
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
      });
    // A thread that never had it (a routine, the coordinator) gains nothing.
    const unset = move([medium]);
    expect(unset?.instanceId).toBe("claudeAgent_work");
    expect(unset?.options).toEqual([medium]);
    // One launched from the row keeps it; one that turned it off keeps it off.
    expect(move([medium, ultracodeOn])?.options).toContainEqual(ultracodeOn);
    const off = { id: "ultracode", value: false };
    expect(move([medium, off])?.options).toContainEqual(off);
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
        ...rule({
          instanceId: id("claudeAgent_work"),
          model: OPUS,
          options: [medium, ultracodeOn],
        }),
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
    // A reviewer moved the same way takes only its model and effort.
    const review = resolveWorkerLaunchSelection({
      preferred: { instanceId: id("claudeAgent"), model: OPUS, options: [medium] },
      coordinator: null,
      providers: [spent, second, codex],
      rule: rule(opusRow),
      nowMs: now,
      review: true,
    });
    expect(review.selection.instanceId).toBe("claudeAgent_work");
    expect(review.selection.options).not.toContainEqual(ultracodeOn);
  });
});
