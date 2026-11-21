import { DEFAULT_PROVIDER_MODEL_TIERS } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { strongestVariantsFirst, strongVariantBases } from "./modelVariants.ts";

type Row = {
  readonly slug: string;
  readonly isCustom: boolean;
  readonly isDefault?: boolean;
  readonly isLegacy?: boolean;
  readonly billing?: string;
};
const row = (slug: string, extra: Partial<Row> = {}): Row => ({ slug, isCustom: false, ...extra });
const slugs = (models: ReadonlyArray<Row>) => models.map((model) => model.slug);
const defaults = (models: ReadonlyArray<Row>) =>
  models.filter((model) => model.isDefault === true).map((model) => model.slug);

// Muse Code 1.4.23's own catalog order: Wonder first and default, Full second.
const MUSE_HOST = [
  row("muse-wonder-1.0", { isDefault: true, billing: "subscription" }),
  row("muse-wonder-full-1.0", { billing: "subscription" }),
  row("muse-ember-1.0", { billing: "subscription" }),
  row("muse-spark-1.3", { billing: "subscription" }),
];

describe("strongVariantBases", () => {
  it("takes one variant word out of the slug", () => {
    expect(strongVariantBases("muse-wonder-full-1.0")).toEqual(["muse-wonder-1.0"]);
    expect(strongVariantBases("gpt-5.1-codex-max")).toEqual(["gpt-5.1-codex"]);
    expect(strongVariantBases("openai/gpt-5-pro")).toEqual(["openai/gpt-5"]);
    expect(strongVariantBases("muse-wonder-1.0")).toEqual([]);
    expect(strongVariantBases("gpt-6.2-astra")).toEqual([]);
    // A leading word is a name, not a variant.
    expect(strongVariantBases("pro-1")).toEqual([]);
  });

  it("agrees with the built-in Muse tiers: the frontier model is the regular one's Full", () => {
    const muse = DEFAULT_PROVIDER_MODEL_TIERS.muse!;
    expect(strongVariantBases(muse.frontier)).toContain(muse.regular);
  });
});

describe("strongestVariantsFirst", () => {
  it("puts Muse Wonder Full above Wonder and recommends it", () => {
    const ranked = strongestVariantsFirst(MUSE_HOST);
    expect(slugs(ranked)).toEqual([
      "muse-wonder-full-1.0",
      "muse-wonder-1.0",
      "muse-ember-1.0",
      "muse-spark-1.3",
    ]);
    expect(defaults(ranked)).toEqual(["muse-wonder-full-1.0"]);
  });

  it("leaves Wonder the default when the account has no Full", () => {
    const notEntitled = MUSE_HOST.filter((model) => model.slug !== "muse-wonder-full-1.0");
    expect(strongestVariantsFirst(notEntitled)).toBe(notEntitled);
  });

  it("moves only the default when Full is already listed first", () => {
    const ranked = strongestVariantsFirst([MUSE_HOST[1]!, MUSE_HOST[0]!, MUSE_HOST[2]!]);
    expect(slugs(ranked)).toEqual(["muse-wonder-full-1.0", "muse-wonder-1.0", "muse-ember-1.0"]);
    expect(defaults(ranked)).toEqual(["muse-wonder-full-1.0"]);
  });

  it("is stable: ranking a ranked list returns the same list", () => {
    const ranked = strongestVariantsFirst(MUSE_HOST);
    expect(strongestVariantsFirst(ranked)).toBe(ranked);
  });

  it("never reorders different lines", () => {
    const codex = [
      row("gpt-6.2-sol"),
      row("gpt-6.2-astra", { isDefault: true }),
      row("gpt-6-luna"),
    ];
    const claude = [row("claude-opus-5-5", { isDefault: true }), row("claude-fable-5-2")];
    expect(strongestVariantsFirst(codex)).toBe(codex);
    expect(strongestVariantsFirst(claude)).toBe(claude);
  });

  it("ranks a Max variant above its base without taking another model's default", () => {
    const ranked = strongestVariantsFirst([
      row("gpt-6.2-astra", { isDefault: true }),
      row("gpt-5.1-codex"),
      row("gpt-5.1-codex-max"),
    ]);
    expect(slugs(ranked)).toEqual(["gpt-6.2-astra", "gpt-5.1-codex-max", "gpt-5.1-codex"]);
    expect(defaults(ranked)).toEqual(["gpt-6.2-astra"]);
  });

  it("lists a paid Pro first but keeps the plan-billed default", () => {
    const ranked = strongestVariantsFirst([
      row("openai/gpt-5", { isDefault: true, billing: "subscription" }),
      row("openai/gpt-5-pro", { billing: "api" }),
    ]);
    expect(slugs(ranked)).toEqual(["openai/gpt-5-pro", "openai/gpt-5"]);
    expect(defaults(ranked)).toEqual(["openai/gpt-5"]);
  });

  it("never moves a custom model or gives it the default", () => {
    const models = [
      row("muse-wonder-1.0", { isDefault: true }),
      row("muse-wonder-full-1.0", { isCustom: true }),
    ];
    expect(strongestVariantsFirst(models)).toBe(models);
  });

  it("keeps the default off a legacy variant", () => {
    const ranked = strongestVariantsFirst([
      row("muse-wonder-1.0", { isDefault: true }),
      row("muse-wonder-full-1.0", { isLegacy: true }),
    ]);
    expect(slugs(ranked)).toEqual(["muse-wonder-full-1.0", "muse-wonder-1.0"]);
    expect(defaults(ranked)).toEqual(["muse-wonder-1.0"]);
  });
});
