import type { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  layoutModelSearchResults,
  modelSearchIdentity,
  modelSearchProviderPlan,
  modelSearchProviderTier,
} from "./modelSearchGroups";

const entry = (
  instanceId: string,
  driverKind: string,
  displayName: string,
  auth: Record<string, unknown> = { status: "authenticated" },
): ProviderInstanceEntry =>
  ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { auth },
  }) as unknown as ProviderInstanceEntry;

const item = (instanceId: string, slug: string, name: string) => ({
  instanceId: instanceId as ProviderInstanceId,
  slug,
  name,
});

describe("modelSearchIdentity", () => {
  it("names one model the same across providers", () => {
    const keys = [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { slug: "opus-5.5", name: "Opus 5.5" },
      { slug: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5" },
    ].map((model) => modelSearchIdentity(model).key);
    expect(new Set(keys)).toEqual(new Set(["opus|5.5"]));
  });

  it("keeps variants and other families apart", () => {
    expect(modelSearchIdentity({ slug: "a", name: "GPT-6.1-Sol" }).key).toBe("gpt sol|6.1");
    expect(modelSearchIdentity({ slug: "b", name: "Claude Sonnet 5.5" }).family).toBe("sonnet");
    expect(modelSearchIdentity({ slug: "c", name: "Claude" }).family).toBe("claude");
  });
});

describe("modelSearchProviderTier", () => {
  it("orders subscriptions, Copilot Enterprise, Copilot, Cursor, then the rest", () => {
    const tiers = [
      entry("opencode", "opencode", "OpenCode"),
      entry("cursor", "cursor", "Cursor"),
      entry("github-copilot", "acpRegistry", "GitHub Copilot", {
        status: "authenticated",
        type: "subscription",
        label: "Copilot Pro",
      }),
      entry("github-copilot-enterprise", "acpRegistry", "Copilot Enterprise"),
      entry("claudeAgent", "claudeAgent", "Claude", {
        status: "authenticated",
        type: "subscription",
      }),
    ].map(modelSearchProviderTier);
    expect(tiers).toEqual([4, 3, 2, 1, 0]);
  });

  it("keeps the local Claude first even when it bills per token", () => {
    expect(
      modelSearchProviderTier(
        entry("claudeAgent", "claudeAgent", "Claude", {
          status: "authenticated",
          apiKeyBilling: true,
        }),
      ),
    ).toBe(0);
    expect(modelSearchProviderTier(entry("devin", "acpRegistry", "Devin"))).toBe(4);
  });
});

describe("layoutModelSearchResults", () => {
  const entries = [
    entry("cursor", "cursor", "Cursor"),
    entry("copilot", "acpRegistry", "GitHub Copilot"),
    entry("claudeAgent", "claudeAgent", "Claude", {
      status: "authenticated",
      type: "subscription",
    }),
  ];
  // Ranked as search returns them: providers and versions mixed.
  const ranked = [
    item("copilot", "claude-opus-4.8", "Claude Opus 4.8"),
    item("cursor", "opus-5.5", "Opus 5.5"),
    item("copilot", "claude-opus-5.5", "Claude Opus 5.5"),
    item("claudeAgent", "claude-opus-5-5", "Claude Opus 5.5"),
    item("claudeAgent", "claude-opus-5", "Claude Opus 5"),
    item("cursor", "composer-2.5", "Composer 2.5"),
  ];
  const keyOf = (model: (typeof ranked)[number]) => `${model.instanceId}/${model.slug}`;

  it("shows each model once, newest first, providers in order, older ones folded", () => {
    const layout = layoutModelSearchResults(ranked, entries, keyOf, new Set());
    expect(layout.keys).toEqual([
      "older-models:opus",
      "claudeAgent/claude-opus-5-5",
      "copilot/claude-opus-5.5",
      "cursor/opus-5.5",
      "cursor/composer-2.5",
    ]);
    // The family's heading row names the latest model; its first provider needs no header.
    expect(layout.headers.has("claudeAgent/claude-opus-5-5")).toBe(false);
    expect(layout.older.get("older-models:opus")).toEqual({
      family: "opus",
      latest: {
        label: "Claude Opus 5.5",
        family: "opus",
        providerCount: 3,
        older: false,
        latest: true,
      },
      familyLabel: "Claude Opus",
      labels: ["Claude Opus 5", "Claude Opus 4.8"],
      isExpanded: false,
    });
    expect(layout.headers.get("cursor/composer-2.5")).toEqual({
      label: "Composer 2.5",
      family: "composer",
      providerCount: 1,
      older: false,
      latest: false,
    });
  });

  it("opens the older versions under the latest model's providers", () => {
    const layout = layoutModelSearchResults(ranked, entries, keyOf, new Set(["opus"]));
    expect(layout.keys.slice(0, 6)).toEqual([
      "older-models:opus",
      "claudeAgent/claude-opus-5-5",
      "copilot/claude-opus-5.5",
      "cursor/opus-5.5",
      "claudeAgent/claude-opus-5",
      "copilot/claude-opus-4.8",
    ]);
    expect(layout.headers.get("copilot/claude-opus-4.8")?.older).toBe(true);
  });
});

describe("modelSearchProviderPlan", () => {
  it("drops a plan that repeats the provider's name", () => {
    const plan = (label: string, name: string) =>
      modelSearchProviderPlan(entry("x", "acpRegistry", name, { status: "authenticated", label }));
    expect(plan("Copilot Enterprise", "Copilot Enterprise")).toBeNull();
    expect(plan("Copilot Pro", "GitHub Copilot")).toBe("Copilot Pro");
  });
});
