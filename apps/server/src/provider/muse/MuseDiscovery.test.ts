import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { museModels, museUsage } from "./MuseDiscovery.ts";
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
