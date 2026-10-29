import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  museFullEntitled,
  museModels,
  museUsage,
  museUsageFromCliJson,
} from "./MuseDiscovery.ts";
import { museControl } from "./MuseConnection.ts";
const catalog = {
  source: "providerCatalog",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "Muse Wonder",
      isDefault: true,
      variants: ["high", "max"],
    },
    { modelId: "muse-wonder-full", displayLabel: "Muse Wonder Full" },
    { modelId: "muse-wonder-1.0-full", displayLabel: "Muse Wonder Full" },
  ],
};
describe("Muse account discovery", () => {
  it("requires an observed subscription and native catalogue for Full", () => {
    expect(museModels(catalog, true, false)).toHaveLength(3);
    expect(museModels(catalog, false, false).map((m) => m.slug)).toEqual(["muse-wonder-1.0"]);
    expect(museModels(catalog, true, true).map((m) => m.slug)).toEqual(["muse-wonder-1.0"]);
    for (const source of [
      "bundledCatalog",
      "configCatalog",
      "fakeCatalog",
      "unresolvedCatalog",
      "future",
    ])
      expect(museModels({ ...catalog, source }, true, false)).toEqual([]);
  });
  it("lets a cold host's catalog decide Full; an API key never does", () => {
    // usage/read on a fresh serve host: nothing observed yet.
    expect(museFullEntitled({}, false)).toBe(true);
    expect(museFullEntitled({}, true)).toBe(false);
    expect(
      museModels(catalog, museFullEntitled({}, false), false).map((m) => m.slug),
    ).toContain("muse-wonder-full");
    // Observed usage rows without a subscription tier are not "unobserved".
    expect(
      museFullEntitled(
        { usage: { observedAtMs: 1700000000000, window: { usedPercent: 1, resetsAtMs: 2 } } },
        false,
      ),
    ).toBe(false);
  });
  it("stamps billing, tool calls and native limits on discovered models", () => {
    const withLimits = {
      source: "providerCatalog",
      models: [
        {
          modelId: "muse-wonder-full-1.0",
          displayLabel: "muse-wonder-full-1.0",
          contextLimit: 1007997,
          outputLimit: 128000,
        },
      ],
    };
    const [subscription] = museModels(withLimits, true, false);
    expect(subscription).toMatchObject({
      billing: "subscription",
      toolCalls: true,
      contextWindow: 1007997,
      maxOutput: 128000,
    });
    expect(museModels(withLimits, true, true)).toEqual([]);
  });
  it("reads CLI usage JSON in envelope, bare and unstamped shapes", () => {
    const usage = {
      observedAtMs: 1700000000000,
      tier: "maximum",
      window: { usedPercent: 0, resetsAtMs: 1700000010000 },
      weekly: { usedPercent: 2, resetsAtMs: 1700000100000 },
    };
    expect(museUsageFromCliJson(JSON.stringify({ usage }), 5)).toMatchObject({
      ordinaryUsageAllowed: true,
      nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
    });
    expect(museUsageFromCliJson(JSON.stringify(usage), 5)).toBeDefined();
    const { observedAtMs: _omit, ...unstamped } = usage;
    expect(museUsageFromCliJson(JSON.stringify(unstamped), 1700000000000)).toMatchObject({
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(1700000000000)),
    });
    expect(museUsageFromCliJson("not logged in", 5)).toBeUndefined();
    expect(museUsageFromCliJson("{}", 5)).toBeUndefined();
  });
  it("keeps max effort separate from the Full model", () => {
    const models = museModels(catalog, false, false);
    const descriptor = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
    ).toEqual(["high", "max"]);
    expect(models.some((model) => model.name.includes("Full"))).toBe(false);
  });
  it("preserves native observation time and exhaustion; rejects malformed usage", () => {
    const usage = {
      observedAtMs: 1700000000000,
      tier: "power",
      window: { usedPercent: 10, resetsAtMs: 1700000010000 },
      weekly: { usedPercent: 100, resetsAtMs: 1700000100000 },
    };
    expect(museUsage({ usage })).toMatchObject({
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
      ordinaryUsageAllowed: false,
    });
    for (const value of [
      {},
      { ...usage, observedAtMs: 1e30 },
      { ...usage, weekly: { usedPercent: -1, resetsAtMs: 100 } },
      { ...usage, weekly: { usedPercent: NaN, resetsAtMs: 100 } },
      { ...usage, weekly: { usedPercent: 0, resetsAtMs: 1e30 } },
    ])
      expect(museUsage({ usage: value })).toBeUndefined();
  });
  it("closes an unresponsive control connection", async () => {
    let closed = false;
    await expect(
      museControl(
        new Promise(() => {}),
        async () => {
          closed = true;
        },
        5,
      ),
    ).rejects.toThrow("timed out");
    expect(closed).toBe(true);
  });
});
