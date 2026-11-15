import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultReviewerChain,
  describeReviewRule,
  resolveReviewer,
  reviewerChain,
  reviewerOrderGroups,
} from "./adversarialReview.ts";
import { newestOfFamily, tierModelFor } from "./modelTiers.ts";

const now = Date.parse("2026-11-04T08:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: fresh,
            windows: [
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: "2026-11-06T00:00:00.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-fable-5-1"], 20);
const codex = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], 30);
const copilot = provider(
  "copilot",
  "acpRegistry",
  ["claude-opus-5.5", "gpt-6.1-sol", "auto"],
  null,
  { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" },
);
const muse = provider("muse", "muse", ["muse-wonder-1.0", "muse-wonder-full-1.0"], 10);
const providers = [claude, codex, copilot, muse];
const author = sel("claudeAgent", "claude-opus-5-5");

describe("tierModelFor", () => {
  it("uses the built-in regular and frontier models", () => {
    expect(tierModelFor(claude, "regular")).toBe("claude-opus-5-5");
    // The literal names Fable 5.2; a provider still on 5.1 keeps its newest Fable.
    expect(tierModelFor(claude, "frontier")).toBe("claude-fable-5-1");
    expect(tierModelFor(codex, "regular")).toBe("gpt-6.1-sol");
    expect(tierModelFor(codex, "frontier")).toBe("gpt-6-astra");
    expect(tierModelFor(muse, "frontier")).toBe("muse-wonder-full-1.0");
  });

  it("keeps a borrowed tier off a newer release billed per use or unknown", () => {
    const reseller = (billing: "api" | "unknown") => {
      const base = provider("copilot", "acpRegistry", ["claude-fable-5-2", "claude-fable-6"], null);
      return {
        ...base,
        models: base.models.map((model) =>
          model.slug === "claude-fable-6" ? { ...model, billing } : model,
        ),
      };
    };
    expect(tierModelFor(reseller("api"), "frontier")).toBe("claude-fable-5-2");
    expect(tierModelFor(reseller("unknown"), "frontier")).toBe("claude-fable-5-2");
  });

  it("follows a built-in default to the newest listed release of its family", () => {
    const newer = provider(
      "claudeAgent",
      "claudeAgent",
      [
        "claude-opus-5-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-fable-6",
        "claude-haiku-4-5-20251001",
      ],
      20,
    );
    expect(tierModelFor(newer, "frontier")).toBe("claude-fable-6");
    expect(tierModelFor(newer, "regular")).toBe("claude-opus-5-5");
    expect(tierModelFor(newer, "frontier", { claudeAgent: { frontier: "claude-fable-5-1" } })).toBe(
      "claude-fable-5-1",
    );
    expect(newestOfFamily(newer, "gpt-6-astra")).toBeUndefined();
    // A provider without its own entry (Copilot) still follows the Fable family.
    const borrowed = provider(
      "copilot",
      "acpRegistry",
      ["claude-opus-5.5", "claude-fable-5.1"],
      null,
    );
    expect(tierModelFor(borrowed, "frontier")).toBe("claude-fable-5.1");
    expect(newestOfFamily(muse, "muse-wonder-1.0")).toBe("muse-wonder-1.0");
  });

  it("prefers the person's choice for the instance, then for the driver", () => {
    expect(tierModelFor(codex, "regular", { codex: { regular: "gpt-6-luna" } })).toBe("gpt-6-luna");
    expect(
      tierModelFor(codex, "regular", {
        codex: { regular: "gpt-6-luna" },
        [codex.instanceId]: { regular: "gpt-6-astra" },
      }),
    ).toBe("gpt-6-astra");
  });

  it("borrows another driver's tier model on a provider without its own", () => {
    expect(tierModelFor(copilot, "regular")).toBe("gpt-6.1-sol");
  });

  it("falls back from frontier to regular and never returns an unlisted model", () => {
    const small = provider("codex-2", "codex", ["gpt-6.1-sol"], 0);
    expect(tierModelFor(small, "frontier")).toBe("gpt-6.1-sol");
    expect(tierModelFor(provider("codex-3", "codex", ["gpt-6-luna"], 0), "regular")).toBe(
      undefined,
    );
  });
});

describe("reviewerChain", () => {
  it("starts with the built-in Review track, then the other providers by family", () => {
    expect(defaultReviewerChain({ providers, tier: "regular" })).toEqual([
      sel("muse", "muse-wonder-1.0"),
      sel("codex", "gpt-6.1-sol"),
      sel("copilot", "gpt-6.1-sol"),
      sel("claudeAgent", "claude-opus-5-5"),
    ]);
  });

  it("follows each named reviewer with the same model on other providers", () => {
    expect(
      reviewerChain({ providers, reviewers: [sel("codex", "gpt-6.1-sol")], tier: "regular" }),
    ).toEqual([sel("codex", "gpt-6.1-sol"), sel("copilot", "gpt-6.1-sol")]);
  });
});

describe("resolveReviewer", () => {
  it("picks Muse Wonder for work Claude did, the top of the built-in Review track", () => {
    const result = resolveReviewer({
      providers,
      author,
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("muse", "muse-wonder-1.0"));
    expect(result.authorFamily).toBe("claude");
    expect(result.skipped).toEqual([]);
  });

  it("keeps a saved first reviewer whose usage is unread ahead of a later one with room", () => {
    // Muse reports no percent; Sol on Codex has known room. The saved order wins.
    const unread: ServerProvider = {
      ...muse,
      usageLimits: {
        checkedAt: fresh,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Usage could not be read." },
      },
    };
    const result = resolveReviewer({
      providers: [claude, codex, copilot, unread],
      author,
      reviewers: [sel("muse", "muse-wonder-full-1.0"), sel("codex", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("muse", "muse-wonder-full-1.0"));
    expect(result.skipped).toEqual([]);
  });

  it("lets a stale or denied reading yield to a later reviewer with room", () => {
    const stale: ServerProvider = {
      ...muse,
      usageLimits: {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 10 * 60_000)),
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 10,
            resetsAt: "2026-11-06T00:00:00.000Z",
          },
        ],
      },
    };
    const result = resolveReviewer({
      providers: [claude, codex, stale],
      author,
      reviewers: [sel("muse", "muse-wonder-1.0"), sel("codex", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("codex", "gpt-6.1-sol"));
  });

  it("gives a reviewer's alternate on the same driver the entry's effort", () => {
    const second = provider("codex2", "codex", ["gpt-6.1-sol"], 5);
    const effortful = {
      ...sel("codex", "gpt-6.1-sol"),
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    };
    expect(
      reviewerChain({
        providers: [codex, second, copilot],
        reviewers: [effortful],
        tier: "regular",
      }),
    ).toEqual([
      effortful,
      { ...sel("codex2", "gpt-6.1-sol"), options: effortful.options },
      sel("copilot", "gpt-6.1-sol"),
    ]);
  });

  it("falls through to Sol on Copilot when Codex is limited", () => {
    const result = resolveReviewer({
      providers,
      author,
      reviewers: [sel("codex", "gpt-6.1-sol"), sel("muse", "muse-wonder-1.0")],
      tier: "regular",
      nowMs: now,
      limitedInstanceIds: new Set(["codex"]),
    });
    // Copilot reports no usage, so a Muse with verified room is not preferred over it:
    // the order is the person's, and Copilot is ready.
    expect(result.reviewer).toEqual(sel("copilot", "gpt-6.1-sol"));
    expect(result.skipped).toEqual([{ selection: sel("codex", "gpt-6.1-sol"), reason: "limited" }]);
  });

  it("never reviews Claude work with Claude through Copilot", () => {
    const result = resolveReviewer({
      providers: [claude, copilot],
      author,
      reviewers: [sel("copilot", "claude-opus-5.5")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toBe(null);
    expect(result.skipped).toEqual([
      { selection: sel("copilot", "claude-opus-5.5"), reason: "same-family" },
      { selection: sel("claudeAgent", "claude-opus-5-5"), reason: "same-family" },
    ]);
  });

  it("reviews Codex work with Claude", () => {
    const result = resolveReviewer({
      providers: [claude, codex],
      author: sel("codex", "gpt-6.1-sol"),
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("claudeAgent", "claude-opus-5-5"));
  });

  it("uses frontier models when asked and skips signed-out and excluded entries", () => {
    const result = resolveReviewer({
      providers: [claude, { ...codex, auth: { status: "unauthenticated" } }, muse],
      author,
      reviewers: [],
      tier: "frontier",
      excludedModels: [{ model: "muse-wonder-full-1.0" }],
      nowMs: now,
    });
    expect(result.reviewer).toBe(null);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "signed-out",
      "excluded",
      "same-family",
    ]);
  });

  it("passes over an agent of unknown billing unless the person listed it", () => {
    const unknown = {
      ...codex,
      models: codex.models.map((model) => ({ ...model, billing: "unknown" as const })),
    };
    const listed = sel("codex", "gpt-6.1-sol");
    const byDefault = resolveReviewer({
      providers: [claude, unknown, muse],
      author,
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(byDefault.reviewer).toEqual(sel("muse", "muse-wonder-1.0"));
    // The built-in order never names it, so there is nothing to pass over.
    expect(byDefault.skipped).toEqual([]);
    const named = resolveReviewer({
      providers: [claude, unknown, muse],
      author,
      reviewers: [listed],
      tier: "regular",
      nowMs: now,
    });
    expect(named.reviewer).toEqual(listed);
  });

  it("never lets a model of no known family review itself on another provider", () => {
    const local = provider("local", "opencode", ["qwen3.6-35b"], 5);
    const mirror = provider("mirror", "acpRegistry", ["qwen3.6-35b"], 5);
    const result = resolveReviewer({
      providers: [local, mirror, codex],
      author: sel("local", "qwen3.6-35b"),
      reviewers: [sel("mirror", "qwen3.6-35b"), sel("codex", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.authorFamily).toBe("other");
    expect(result.reviewer).toEqual(sel("codex", "gpt-6.1-sol"));
    // The mirror's entry brings the author's own instance in after it.
    expect(result.skipped).toEqual([
      { selection: sel("mirror", "qwen3.6-35b"), reason: "same-family" },
      { selection: sel("local", "qwen3.6-35b"), reason: "same-family" },
    ]);
  });
});

describe("reviewerOrderGroups", () => {
  it("keeps a listed model in its own place instead of as an earlier alternate", () => {
    const groups = reviewerOrderGroups({
      providers,
      reviewers: [
        sel("codex", "gpt-6.1-sol"),
        sel("copilot", "gpt-6.1-sol"),
        sel("claudeAgent", "claude-opus-5-5"),
      ],
      tier: "regular",
    });
    expect(
      groups.map((group) => [
        `${group.primary.instanceId}/${group.primary.model}`,
        group.alternates.map((step) => `${step.instanceId}/${step.model}`),
      ]),
    ).toEqual([
      ["codex/gpt-6.1-sol", []],
      ["copilot/gpt-6.1-sol", []],
      ["claudeAgent/claude-opus-5-5", ["copilot/claude-opus-5.5"]],
    ]);
  });
});

describe("the family rule as Anton's order has it", () => {
  // Claude Opus 5.5 first, then Muse Wonder Full, GPT-6.1 Sol, Muse Wonder.
  const order = [
    sel("claudeAgent", "claude-opus-5-5"),
    sel("muse", "muse-wonder-full-1.0"),
    sel("codex", "gpt-6.1-sol"),
    sel("muse", "muse-wonder-1.0"),
  ];

  it("skips Claude Opus at #1 for work Fable did, on every source that serves it", () => {
    const result = resolveReviewer({
      providers,
      author: sel("claudeAgent", "claude-fable-5-1"),
      reviewers: order,
      tier: "regular",
      nowMs: now,
    });
    expect(result.authorFamily).toBe("claude");
    expect(result.reviewer).toEqual(sel("muse", "muse-wonder-full-1.0"));
    expect(result.skipped).toEqual([
      { selection: sel("claudeAgent", "claude-opus-5-5"), reason: "same-family" },
      { selection: sel("copilot", "claude-opus-5.5"), reason: "same-family" },
    ]);
  });

  it("lets another family on the author's own source review", () => {
    // Opus ran through Copilot; Sol through that same Copilot account still reviews.
    const result = resolveReviewer({
      providers: [claude, copilot],
      author: sel("copilot", "claude-opus-5.5"),
      reviewers: [sel("copilot", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("copilot", "gpt-6.1-sol"));
  });

  it("says who reviews each family's work", () => {
    const lines = describeReviewRule({
      providers,
      authors: [
        sel("claudeAgent", "claude-opus-5-5"),
        sel("claudeAgent", "claude-fable-5-1"),
        sel("codex", "gpt-6-astra"),
      ],
      reviewers: order,
      tier: "regular",
      nowMs: now,
    });
    expect(lines.map((line) => [line.family, line.authors, line.reviewer])).toEqual([
      ["claude", ["claude-opus-5-5", "claude-fable-5-1"], sel("muse", "muse-wonder-full-1.0")],
      ["openai", ["gpt-6-astra"], sel("claudeAgent", "claude-opus-5-5")],
    ]);
    expect(lines[0]?.sameFamily).toEqual([
      sel("claudeAgent", "claude-opus-5-5"),
      sel("copilot", "claude-opus-5.5"),
    ]);
    expect(lines[1]?.sameFamily).toEqual([]);
  });

  it("says no reviewer can run when the order holds only the author's family", () => {
    const [line] = describeReviewRule({
      providers: [claude, copilot],
      authors: [sel("claudeAgent", "claude-opus-5-5")],
      reviewers: [sel("claudeAgent", "claude-opus-5-5")],
      tier: "regular",
      nowMs: now,
    });
    expect(line?.reviewer).toBe(null);
    expect(line?.skipped.every((skip) => skip.reason === "same-family")).toBe(true);
  });
});
