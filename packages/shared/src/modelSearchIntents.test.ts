import { describe, expect, it } from "vite-plus/test";

import {
  boundedEditDistance,
  closestNameWordDistance,
  modelHasCapability,
  modelSizeClass,
  modelVendorAliases,
  parseModelSearch,
  providerKnownToOffer,
  providerVendorAliases,
  removeModelSearchWord,
} from "./modelSearchIntents.ts";

describe("parseModelSearch", () => {
  it("separates capability words from text words", () => {
    const parsed = parseModelSearch("  Opus fast 1M ");
    expect(parsed.text).toEqual(["opus"]);
    expect(parsed.capabilities.map((capability) => capability.id)).toEqual(["fast", "long"]);
  });

  it("folds synonyms into one filter", () => {
    expect(parseModelSearch("smart best").capabilities).toHaveLength(1);
    expect(parseModelSearch("vision images").capabilities.map((c) => c.id)).toEqual(["images"]);
  });

  it("removes one capability word from the query", () => {
    expect(removeModelSearchWord("opus Fast 1m", "fast")).toBe("opus 1m");
  });
});

describe("modelSizeClass", () => {
  it("reads small and large families from the name", () => {
    expect(modelSizeClass({ name: "Claude Haiku 4.5" })).toBe("small");
    expect(modelSizeClass({ name: "GPT-6.1 mini" })).toBe("small");
    expect(modelSizeClass({ name: "Gemini 4 Flash" })).toBe("small");
    expect(modelSizeClass({ name: "Claude Opus 5.5" })).toBe("large");
    expect(modelSizeClass({ name: "Claude Sonnet 5.5" })).toBe("medium");
  });
});

describe("vendor aliases", () => {
  it("names the vendor of a model family", () => {
    expect(modelVendorAliases({ name: "Claude Opus 5.5" })).toContain("anthropic");
    expect(modelVendorAliases({ name: "GPT-5.3-Codex" })).toContain("openai");
    expect(modelVendorAliases({ name: "Gemini 4 Carbon" })).toEqual(["google"]);
  });

  it("names the vendor of a provider", () => {
    expect(
      providerVendorAliases({ driverKind: "acpRegistry", displayName: "Copilot Enterprise" }),
    ).toContain("github");
    expect(providerVendorAliases({ driverKind: "cursor", displayName: "Cursor" })).toEqual([]);
  });
});

describe("modelHasCapability", () => {
  const opus = { name: "Claude Opus 5.5", slug: "claude-opus-5-5", billing: "subscription" };
  const haiku = { name: "Claude Haiku 4.5", slug: "claude-haiku-4-5", billing: "subscription" };

  it("cheap: small subscription models and local ones, never per token", () => {
    expect(modelHasCapability("cheap", haiku)).toBe(true);
    expect(modelHasCapability("cheap", opus)).toBe(false);
    expect(modelHasCapability("cheap", { ...haiku, billing: "api" })).toBe(false);
    expect(modelHasCapability("cheap", { name: "Qwen 3", slug: "qwen3", billing: "local" })).toBe(
      true,
    );
  });

  it("fast: Fast mode or a small model", () => {
    expect(modelHasCapability("fast", { ...opus, hasFast: true })).toBe(true);
    expect(modelHasCapability("fast", opus)).toBe(false);
    expect(modelHasCapability("fast", haiku)).toBe(true);
  });

  it("smart: the Hardest work tier, then the latest large models", () => {
    expect(modelHasCapability("smart", { ...haiku, inHardestTier: true })).toBe(true);
    expect(modelHasCapability("smart", { ...opus, isLatest: true })).toBe(true);
    expect(modelHasCapability("smart", { ...opus, isLatest: false })).toBe(false);
    expect(modelHasCapability("smart", haiku)).toBe(false);
  });

  it("free, images, long, new", () => {
    expect(modelHasCapability("free", opus)).toBe(true);
    expect(modelHasCapability("free", { ...opus, billing: "api" })).toBe(false);
    expect(modelHasCapability("free", { ...opus, billing: undefined })).toBe(false);
    expect(modelHasCapability("images", { ...opus, imageInput: true })).toBe(true);
    expect(modelHasCapability("long", { ...opus, contextWindow: 1_000_000 })).toBe(true);
    expect(modelHasCapability("long", { ...opus, slug: "claude-opus-5-5[1m]" })).toBe(true);
    expect(modelHasCapability("long", opus)).toBe(false);
    expect(modelHasCapability("new", { ...opus, isNew: true })).toBe(true);
  });
});

describe("providerKnownToOffer", () => {
  const cursor = { driverKind: "cursor", displayName: "Cursor" };

  it("says a signed-out Cursor would list Carbon", () => {
    expect(providerKnownToOffer(cursor, ["carbon"])).toBe(true);
    expect(providerKnownToOffer(cursor, ["google"])).toBe(true);
  });

  it("stays quiet for families it does not offer and for empty queries", () => {
    expect(providerKnownToOffer(cursor, ["llama"])).toBe(false);
    expect(providerKnownToOffer(cursor, [])).toBe(false);
    expect(providerKnownToOffer({ driverKind: "codex", displayName: "Codex" }, ["carbon"])).toBe(
      false,
    );
  });
});

describe("typo distance", () => {
  it("counts a transposition as one edit", () => {
    expect(boundedEditDistance("cabron", "carbon", 1)).toBe(1);
    expect(boundedEditDistance("carbon", "carbon", 1)).toBe(0);
    expect(boundedEditDistance("corbin", "carbon", 1)).toBeNull();
  });

  it("allows one edit, two for seven or more characters", () => {
    expect(closestNameWordDistance("carbn", ["gemini", "4", "carbon"])).toBe(1);
    expect(closestNameWordDistance("sonnnett", ["claude", "sonnet", "5.5"])).toBe(2);
    expect(closestNameWordDistance("xyz", ["claude", "opus"])).toBeNull();
    expect(closestNameWordDistance("5.6", ["opus", "5.5"])).toBeNull();
  });
});
