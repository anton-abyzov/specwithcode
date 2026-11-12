import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelPickerSearchText,
  countModelSearchMatches,
  modelSearchHighlightRanges,
  modelSearchMatchedAlias,
  rankModelPickerSearch,
  scoreModelPickerSearch,
  searchModelPicker,
} from "./modelPickerSearch";

describe("buildModelPickerSearchText", () => {
  it("builds provider-agnostic search text from generic fields", () => {
    expect(
      buildModelPickerSearchText({
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      }),
    ).toBe("claude opus 4.7 github copilot opencode opencode");
  });
});

/** The catalog in the report: Copilot Enterprise and personal, Claude and Codex. */
const item = (
  instanceDisplayName: string,
  driverKind: string,
  name: string,
  extra: { aliases?: string[]; slug?: string } = {},
) => ({
  instanceDisplayName,
  driverKind,
  name,
  slug: extra.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
  ...(extra.aliases ? { aliases: extra.aliases } : {}),
});
const ENTERPRISE = "Copilot Enterprise (acme-robotics-on)";
const PERSONAL = "Copilot personal (fixture-person)";
const CATALOG = [
  item(ENTERPRISE, "acpRegistry", "Gemini 4 Carbon"),
  item("Claude Code", "claudeAgent", "Claude Opus 5.5", { aliases: ["opus-5.5"] }),
  item(ENTERPRISE, "acpRegistry", "Claude Opus 5.5"),
  item(PERSONAL, "acpRegistry", "Claude Opus 5.5"),
  item("Codex", "codex", "GPT-5.3-Codex"),
  item(ENTERPRISE, "acpRegistry", "GPT-5.3-Codex"),
  item("Claude Code", "claudeAgent", "Claude Fable 5", { aliases: ["fable"] }),
  item(PERSONAL, "acpRegistry", "Claude Fable 5"),
  item("Claude Code", "claudeAgent", "Claude Sonnet 5.5"),
  item("Codex", "codex", "GPT-6.1 Sol"),
];
const none = () => false;
const names = (models: ReadonlyArray<{ name: string }>) => models.map((model) => model.name);

describe("searching the reported catalog for carbon", () => {
  it("lists Gemini 4 Carbon and nothing else", () => {
    expect(names(rankModelPickerSearch(CATALOG, "carbon", none))).toEqual(["Gemini 4 Carbon"]);
  });

  it("no longer reaches a model through letters scattered in a provider name", () => {
    // "carbon" is a subsequence of this account's name, which listed all its models.
    expect(
      scoreModelPickerSearch(
        { driverKind: "acpRegistry", providerDisplayName: ENTERPRISE, name: "Claude Opus 5.5" },
        "carbon",
      ),
    ).toBeNull();
  });
});

describe("scoreModelPickerSearch", () => {
  const opus = {
    driverKind: "opencode",
    providerDisplayName: "opencode",
    name: "Claude Opus 4.7",
    subProvider: "GitHub Copilot",
  };

  it("needs every word to match", () => {
    expect(scoreModelPickerSearch(opus, "copilot opus")).not.toBeNull();
    expect(scoreModelPickerSearch(opus, "copilot sonnet")).toBeNull();
  });

  it("does not match loosely", () => {
    expect(scoreModelPickerSearch(opus, "coplt op")).toBeNull();
    expect(scoreModelPickerSearch(opus, "pus")).toBeNull();
  });

  it("ranks exact, then prefix, then word start, then provider", () => {
    const model = (name: string) => ({ driverKind: "x", providerDisplayName: "Sol Labs", name });
    const exact = scoreModelPickerSearch(model("Sol"), "sol")!;
    const prefix = scoreModelPickerSearch(model("Solar 2"), "sol")!;
    const wordStart = scoreModelPickerSearch(model("GPT-6.1 Sol"), "sol")!;
    const provider = scoreModelPickerSearch(model("Other"), "sol")!;
    expect(exact).toBeLessThan(prefix);
    expect(prefix).toBeLessThan(wordStart);
    expect(wordStart).toBeLessThan(provider);
  });

  it("treats a vendor word in front of the name as no loss of rank", () => {
    const claude = {
      driverKind: "claudeAgent",
      providerDisplayName: "Claude",
      name: "Claude Opus 4.7",
    };
    const cursor = { driverKind: "cursor", providerDisplayName: "Cursor", name: "Opus 4.7" };
    expect(scoreModelPickerSearch(claude, "opu")).toBe(scoreModelPickerSearch(cursor, "opu"));
  });

  it("finds a version glued to the name and a word inside a run-together name", () => {
    const local = (name: string) => ({
      driverKind: "opencode",
      providerDisplayName: "Local",
      name,
    });
    expect(scoreModelPickerSearch(local("Qwen3 Coder"), "qwen 3")).not.toBeNull();
    expect(scoreModelPickerSearch(local("qwen2.5-coder:7b"), "qwen 2.5")).not.toBeNull();
    expect(scoreModelPickerSearch(local("llama3.2:latest"), "llama 3.2")).not.toBeNull();
    expect(scoreModelPickerSearch(local("DeepSeek-V3.1"), "seek")).not.toBeNull();
    expect(scoreModelPickerSearch(local("Claude Opus 5.5"), "pus")).toBeNull();
    // Never inside a word: "mini" is not in Gemini, "nnet" is not a word of Sonnet.
    expect(scoreModelPickerSearch(local("Gemini 4 Carbon"), "mini")).toBeNull();
    expect(scoreModelPickerSearch(local("Claude Sonnet 5.5"), "nnet")).toBeNull();
    expect(scoreModelPickerSearch(local("GPT-5 mini"), "mini")).not.toBeNull();
  });

  it("matches without the separators", () => {
    expect(
      scoreModelPickerSearch(
        { driverKind: "codex", providerDisplayName: "Codex", name: "GPT-5.3-Codex" },
        "gpt5",
      ),
    ).not.toBeNull();
  });

  it("matches aliases, vendors and the account", () => {
    const base = { driverKind: "claudeAgent", providerDisplayName: "Claude Code" };
    expect(
      scoreModelPickerSearch({ ...base, name: "Claude Fable 5.2", aliases: ["mythos"] }, "mythos"),
    ).not.toBeNull();
    expect(scoreModelPickerSearch({ ...base, name: "Opus 5.5" }, "anthropic")).not.toBeNull();
    expect(scoreModelPickerSearch({ ...base, name: "Opus 5.5" }, "openai")).toBeNull();
    expect(
      scoreModelPickerSearch(
        { driverKind: "acpRegistry", providerDisplayName: "Copilot Enterprise", name: "GPT-6" },
        "github",
      ),
    ).not.toBeNull();
    expect(
      scoreModelPickerSearch({ ...base, name: "Opus 5.5", accountLabel: "Claude Max" }, "max"),
    ).not.toBeNull();
  });

  it("matches a custom instance's display name against its models", () => {
    expect(
      scoreModelPickerSearch(
        { driverKind: "codex", providerDisplayName: "Codex Personal", name: "GPT-5 Codex" },
        "personal",
      ),
    ).not.toBeNull();
  });

  it("finds every model of a provider by its display name alone", () => {
    const base = { driverKind: "claudeAgent", providerDisplayName: "Claude Code" };
    expect(scoreModelPickerSearch({ ...base, name: "Opus 5.5" }, "claude")).not.toBeNull();
    expect(scoreModelPickerSearch({ ...base, name: "Sonnet 5" }, "claude code")).not.toBeNull();
    expect(scoreModelPickerSearch({ ...base, name: "Sonnet 5" }, "codex")).toBeNull();
  });
});

describe("searchModelPicker", () => {
  it("lets a favorite win a tie, never a better match", () => {
    const favorite = (model: { instanceDisplayName: string }) =>
      model.instanceDisplayName === PERSONAL;
    expect(
      rankModelPickerSearch(CATALOG, "opus", favorite).map((m) => m.instanceDisplayName)[0],
    ).toBe(PERSONAL);
    // The exact alias on Claude Code outranks the favorite's prefix match.
    expect(
      rankModelPickerSearch(CATALOG, "opus-5.5", favorite).map((m) => m.instanceDisplayName)[0],
    ).toBe("Claude Code");
  });

  it("puts name matches before provider matches", () => {
    const ranked = names(rankModelPickerSearch(CATALOG, "codex", none));
    expect(ranked.slice(0, 2)).toEqual(["GPT-5.3-Codex", "GPT-5.3-Codex"]);
    expect(ranked).toContain("GPT-6.1 Sol");
  });

  it("offers closest matches only when nothing matches directly", () => {
    const typo = searchModelPicker(CATALOG, "cabron", none);
    expect(typo.closest).toBe(true);
    expect(names(typo.matches)).toEqual(["Gemini 4 Carbon"]);
    expect(searchModelPicker(CATALOG, "carbon", none).closest).toBe(false);
    const nothing = searchModelPicker(CATALOG, "zzzzzz", none);
    expect(nothing).toMatchObject({ matches: [], closest: false });
  });

  it("filters by a capability word and reports it", () => {
    const facts = (model: (typeof CATALOG)[number]) => ({
      name: model.name,
      slug: model.slug,
      billing: "subscription",
      hasFast: model.name === "Claude Opus 5.5",
    });
    const result = searchModelPicker(CATALOG, "fast", none, facts);
    expect(result.capabilities.map((capability) => capability.id)).toEqual(["fast"]);
    expect(new Set(names(result.matches))).toEqual(new Set(["Claude Opus 5.5"]));
    expect(names(searchModelPicker(CATALOG, "fast codex", none, facts).matches)).toEqual([]);
  });

  it("never hides a model whose own name is the capability word", () => {
    const models = [...CATALOG, item("Grok", "grok", "Grok Code Fast 1")];
    expect(names(searchModelPicker(models, "fast", none).matches)).toEqual(["Grok Code Fast 1"]);
  });
});

describe("highlighting", () => {
  it("marks the matched characters in the name", () => {
    expect(modelSearchHighlightRanges("Gemini 4 Carbon", "carbon")).toEqual([[9, 15]]);
    expect(modelSearchHighlightRanges("Claude Opus 5.5", "opus 5")).toEqual([
      [7, 11],
      [12, 13],
    ]);
    expect(modelSearchHighlightRanges("Claude Opus 5.5", "fast")).toEqual([]);
  });

  it("names the alias when the shown name does not carry the match", () => {
    expect(modelSearchMatchedAlias({ aliases: ["mythos"] }, "Claude Fable 5.2", "myth")).toBe(
      "mythos",
    );
    expect(modelSearchMatchedAlias({ aliases: ["fable"] }, "Claude Fable 5.2", "fable")).toBeNull();
  });
});

describe("countModelSearchMatches", () => {
  it("counts matches per provider, for All and for Favorites", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const copilot = ProviderInstanceId.make("copilot_work");
    const counts = countModelSearchMatches(
      [
        { instanceId: claude, slug: "claude-opus-5-5" },
        { instanceId: copilot, slug: "claude-opus-5-5" },
        { instanceId: copilot, slug: "claude-opus-5" },
      ],
      new Set(["copilot_work:claude-opus-5"]),
    );
    expect(Object.fromEntries(counts)).toEqual({
      all: 3,
      favorites: 1,
      claudeAgent: 1,
      copilot_work: 2,
    });
  });
});
