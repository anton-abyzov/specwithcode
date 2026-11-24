import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fallbackSelectionKey,
  resolveCoordinatorTurnSelection,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";

// 1460: a source a provider just refused (its usage read still showing room)
// stays off new workers and coordinator turns until its hold ends.
const now = Date.parse("2026-11-24T15:00:00.000Z");
const resetsAt = "2026-11-24T18:00:00.000Z";

function source(id: string, driver: string, used: number, slug: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    version: null,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      windows: [{ id: "monthly", kind: "weekly", label: "Monthly", usedPercent: used, resetsAt }],
    },
  };
}

const neon = "gemini-4-neon";
const copilot = source("copilot", "acpRegistry", 40, neon);
const cursor = source("cursor", "cursor", 40, neon);
const codex = source("codex", "codex", 20, "gpt-6.2-sol");
const neonOn = (instance: ServerProvider) => ({ instanceId: instance.instanceId, model: neon });
const sol = { instanceId: codex.instanceId, model: "gpt-6.2-sol" };
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitSwitchAtPercent: 95,
  providerLimitFallbackModelSelection: null,
  providerLimitFallbackModels: [sol],
  defaultModelSelection: null,
};
const held = new Set([fallbackSelectionKey(neonOn(copilot)), fallbackSelectionKey(neonOn(cursor))]);

describe("held sources", () => {
  it("never starts a worker on a held source of its model", () => {
    const input = {
      preferred: neonOn(copilot),
      coordinator: null,
      providers: [copilot, cursor, codex],
      rule,
      nowMs: now,
    };
    expect(resolveWorkerLaunchSelection(input).selection).toEqual(neonOn(copilot));
    const launch = resolveWorkerLaunchSelection({ ...input, heldSelections: held });
    expect(launch.selection.instanceId).toBe(codex.instanceId);
    // Only Copilot held: the same model on Cursor still takes the worker.
    const one = new Set([fallbackSelectionKey(neonOn(copilot))]);
    expect(resolveWorkerLaunchSelection({ ...input, heldSelections: one }).selection).toEqual(
      neonOn(cursor),
    );
  });

  it("moves a coordinator off a held saved model and never onto another held source", () => {
    const turn = resolveCoordinatorTurnSelection({
      saved: neonOn(copilot),
      thread: neonOn(cursor),
      providers: [copilot, cursor, codex],
      rule,
      nowMs: now,
      heldSelections: held,
    });
    expect(turn.selection.instanceId).toBe(codex.instanceId);
  });
});
