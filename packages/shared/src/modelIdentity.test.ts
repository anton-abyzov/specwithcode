import { describe, expect, it } from "vite-plus/test";

import { isSameModel, modelIdentityKeys, sameModelOn } from "./modelIdentity.ts";

const model = (slug: string, name: string, extra: { isCustom?: boolean } = {}) => ({
  slug,
  name,
  isCustom: extra.isCustom ?? false,
  capabilities: null,
});

describe("model identity", () => {
  it("matches one model across providers' spellings", () => {
    const claude = { slug: "claude-opus-5-5", name: "Claude Opus 5.5", aliases: ["opus-5.5"] };
    expect(isSameModel(claude, { slug: "claude-opus-5.5" })).toBe(true);
    expect(isSameModel(claude, { slug: "anthropic/claude-opus-5.5" })).toBe(true);
    expect(isSameModel(claude, { slug: "copilot-opus", name: "Claude Opus 5.5" })).toBe(true);
    expect(isSameModel(claude, { slug: "claude-opus-5-5[1m]" })).toBe(true);
  });

  it("keeps different versions and nameless spellings apart", () => {
    const claude = { slug: "claude-opus-5-5", name: "Claude Opus 5.5" };
    expect(isSameModel(claude, { slug: "claude-opus-5", name: "Claude Opus 5" })).toBe(false);
    expect(isSameModel({ slug: "auto", name: "Default" }, { slug: "auto", name: "Default" })).toBe(
      false,
    );
    expect([...modelIdentityKeys({ slug: "opus", name: "Opus" })]).toEqual([]);
  });

  it("finds the slug another provider serves the model under, custom models included", () => {
    const copilot = {
      models: [model("gpt-6-luna", "GPT-6 Luna"), model("claude-opus-5.5", "", { isCustom: true })],
    };
    expect(sameModelOn(copilot, { slug: "claude-opus-5-5", name: "Claude Opus 5.5" })).toBe(
      "claude-opus-5.5",
    );
    expect(sameModelOn(copilot, { slug: "claude-sonnet-5-5" })).toBeUndefined();
  });
});
