import { describe, expect, it } from "vite-plus/test";

import {
  compactCatalog,
  instanceCatalog,
  largestThatFits,
  MCP_RESULT_MAX_BYTES,
  newestItemsThatFit,
  serializedBytes,
} from "./mcpResultBudget.ts";

const modelCount = (provider: object | undefined) =>
  (provider as { readonly modelCount?: number } | undefined)?.modelCount;

describe("mcpResultBudget", () => {
  it("stays under an MCP client's 25,000-token spill limit at 2 bytes per token", () => {
    expect(MCP_RESULT_MAX_BYTES / 2).toBeLessThan(25_000);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(serializedBytes("é")).toBe(4);
    expect(serializedBytes({ a: [1, 2] })).toBe(11);
  });

  it("keeps the newest items that fit, counting separators", () => {
    const items = ["aaaa", "bbbb", "cccc"];
    // Each item is 6 bytes with quotes, plus 1 for its comma.
    expect(newestItemsThatFit(items, 10, 10 + 7 * 2)).toBe(2);
    expect(newestItemsThatFit(items, 10, 10 + 7 * 3)).toBe(3);
    expect(newestItemsThatFit(items, 10, 10 + 6)).toBe(0);
    expect(newestItemsThatFit([], 10, 5)).toBe(0);
  });

  it("finds the largest size that still fits", () => {
    expect(largestThatFits(100, (n) => n <= 37)).toBe(37);
    expect(largestThatFits(100, () => true)).toBe(100);
    expect(largestThatFits(100, () => false)).toBe(0);
  });

  const option = { id: "effort", label: "Effort", options: ["low", "medium", "high"] };
  type Catalog = ReturnType<typeof catalog>;
  type Provider = Catalog["providers"][number];
  type Model = Provider["models"][number];
  const catalog = (counts: ReadonlyArray<number>) => ({
    parentThreadId: null,
    providers: counts.map((count, index) => ({
      providerInstanceId: `instance-${index}`,
      models: Array.from({ length: count }, (_, model) => ({
        id: `instance-${index}/model-${model}`,
        label: `Model ${model} of instance ${index}`,
        options: [option, option],
        ...(model === 0 ? { paid: true } : {}),
      })),
    })),
  });

  it("returns a catalog that fits unchanged", () => {
    const full = catalog([3, 4]);
    expect(compactCatalog(full, 40_000)).toBe(full);
  });

  it("drops model options and keeps every model id, label and flag", () => {
    const full = catalog([3, 40, 5]);
    expect(serializedBytes(full)).toBeGreaterThan(5_000);
    const compact = compactCatalog(full, 5_000);
    expect(serializedBytes(compact)).toBeLessThanOrEqual(5_000);
    expect(compact.detail?.view).toBe("compact");
    expect(compact.providers.map((provider) => provider.models.length)).toEqual([3, 40, 5]);
    for (const provider of compact.providers) {
      expect(provider.models.every((model) => model.options === undefined)).toBe(true);
      expect(provider.models[0]?.paid).toBe(true);
      expect(provider.models[0]?.label).not.toBeNull();
      expect(modelCount(provider)).toBeUndefined();
    }
  });

  it("cuts labels, then the longest lists, when ids alone do not fit", () => {
    const full = catalog([3, 400, 5]);
    const compact = compactCatalog(full, 6_000);
    expect(serializedBytes(compact)).toBeLessThanOrEqual(6_000);
    const [small, large, other] = compact.providers;
    expect(small?.models).toHaveLength(3);
    expect(other?.models).toHaveLength(5);
    expect(modelCount(large)).toBe(400);
    expect(large?.models.length).toBeLessThan(400);
    expect(large?.models.length).toBeGreaterThan(0);
    expect(compact.providers.every((provider) => provider.models.every((m) => m.label === null))).toBe(
      true,
    );
  });

  it("pages one instance in full by model offset", () => {
    const full = catalog([3, 100]);
    const seen: Array<string> = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: ReturnType<typeof instanceCatalog<Model, Provider, typeof full>> =
        instanceCatalog(full, "instance-1", offset, 4_000);
      expect(page).toBeDefined();
      expect(serializedBytes(page)).toBeLessThanOrEqual(4_000);
      expect(page!.providers).toHaveLength(1);
      expect(modelCount(page!.providers[0])).toBe(100);
      for (const model of page!.providers[0]!.models) {
        expect(model.options).toEqual([option, option]);
        seen.push(model.id);
      }
      offset = page!.detail.nextModelOffset ?? null;
    }
    expect(seen).toEqual(full.providers[1]!.models.map((model) => model.id));
  });

  it("returns a small instance whole and refuses an unknown one", () => {
    const full = catalog([3, 100]);
    const page = instanceCatalog(full, "instance-0", 0, 40_000);
    expect(page?.providers[0]?.models).toHaveLength(3);
    expect(modelCount(page?.providers[0])).toBeUndefined();
    expect(page?.detail.nextModelOffset).toBeNull();
    expect(instanceCatalog(full, "missing", 0, 40_000)).toBeUndefined();
  });
});
