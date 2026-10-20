import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import { addFallbackEntry, MAX_FALLBACK_MODELS, moveFallbackEntry } from "./FallbackOrderList";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

describe("fallback order", () => {
  it("adds entries in order and refuses duplicates and overflow", () => {
    let order = addFallbackEntry([], codex, "gpt-6-astra");
    order = addFallbackEntry(order, codex, "gpt-6.1-sol");
    order = addFallbackEntry(order, codex, "gpt-6-astra");
    expect(order.map((entry) => entry.model)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
    let full = order;
    for (let at = 0; at < MAX_FALLBACK_MODELS + 2; at += 1)
      full = addFallbackEntry(full, claude, `model-${at}`);
    expect(full).toHaveLength(MAX_FALLBACK_MODELS);
  });

  it("moves an entry up or down and ignores moves past either end", () => {
    const order = [
      addFallbackEntry([], codex, "gpt-6-astra")[0]!,
      addFallbackEntry([], codex, "gpt-6.1-sol")[0]!,
      addFallbackEntry([], claude, "claude-opus-5-5")[0]!,
    ];
    expect(moveFallbackEntry(order, 2, -1).map((entry) => entry.model)).toEqual([
      "gpt-6-astra",
      "claude-opus-5-5",
      "gpt-6.1-sol",
    ]);
    expect(moveFallbackEntry(order, 0, -1)).toBe(order);
    expect(moveFallbackEntry(order, 2, 1)).toBe(order);
  });
});
