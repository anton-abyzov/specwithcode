import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@specweave-studio/contracts";

import {
  providerModelKey,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("groups favorites first while preserving provider model order inside each group", () => {
    const models = [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.4-mini" },
      { slug: "crest-alpha" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["gpt-5.5", "gpt-5.4-mini", "crest-alpha"],
        groupFavorites: true,
        modelOrder: ["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"],
      }).map((model) => model.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"]);
  });

  it("sorts the favorites view by provider order, then provider model order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.4-mini" },
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.5" },
      { instanceId: CODEX_WORK_ID, slug: "crest-alpha" },
      { instanceId: CLAUDE_ID, slug: "claude-opus-4-6" },
    ];
    const favoriteKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CODEX_WORK_ID, "crest-alpha"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favoriteKeys,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }).map((item) => item.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "claude-opus-4-6"]);
  });
});

describe("newer releases of a family", () => {
  it("put Fable 5.2 above a ranked or starred Fable 5.1", () => {
    const models = [
      { slug: "claude-opus-5-5" },
      { slug: "claude-fable-5-1" },
      { slug: "claude-fable-5-2" },
      { slug: "claude-haiku-5-5" },
      { slug: "claude-haiku-4-5-20251001" },
    ];
    const plain = sortModelsForProviderInstance(models).map((m) => m.slug);
    expect(plain.indexOf("claude-fable-5-2")).toBeLessThan(plain.indexOf("claude-fable-5-1"));
    expect(plain[0]).toBe("claude-opus-5-5");

    const ranked = sortModelsForProviderInstance(models, {
      modelOrder: ["claude-haiku-5-5", "claude-fable-5-1", "claude-opus-5-5"],
    }).map((m) => m.slug);
    expect(ranked.slice(0, 4)).toEqual([
      "claude-haiku-5-5",
      "claude-fable-5-2",
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);

    const starred = sortModelsForProviderInstance(models, {
      favoriteModels: ["claude-fable-5-1"],
      groupFavorites: true,
    }).map((m) => m.slug);
    expect(starred.slice(0, 2)).toEqual(["claude-fable-5-2", "claude-fable-5-1"]);

    const picker = sortProviderModelItems(
      sortModelsForProviderInstance(models).map((m) => ({ instanceId: CLAUDE_ID, slug: m.slug })),
      {
        favoriteModelKeys: [providerModelKey(CLAUDE_ID, "claude-fable-5-1")],
        groupFavorites: true,
      },
    ).map((m) => m.slug);
    expect(picker.slice(0, 2)).toEqual(["claude-fable-5-2", "claude-fable-5-1"]);
  });
});
