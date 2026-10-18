import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { recommendedModelProviderOrder } from "./RecommendedModelProviders";

function provider(
  id: string,
  driver: string,
  models: ReadonlyArray<[slug: string, name: string]>,
  auth: ServerProvider["auth"] = { status: "authenticated" },
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth,
    checkedAt: "2026-10-17T00:00:00.000Z",
    models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

const entries = deriveProviderInstanceEntries([
  provider("claudeAgent", "claudeAgent", [["claude-opus-5-5", "Claude Opus 5.5"]]),
  provider("codex", "codex", [["gpt-6", "GPT-6"]]),
  provider("copilot", "acp", [["claude-opus-5.5", "Claude Opus 5.5"]]),
  provider("claudeWork", "claudeAgent", [["claude-opus-5-5", "Claude Opus 5.5"]]),
  provider("claudeApi", "claudeAgent", [["claude-opus-5-5", "Claude Opus 5.5"]], {
    status: "authenticated",
    type: "apiKey",
  }),
]);
const opus = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5-5");
const ids = (order: ReturnType<typeof recommendedModelProviderOrder>) =>
  order.others.map((choice) => `${choice.entry.instanceId}:${choice.slug}`);

describe("recommendedModelProviderOrder", () => {
  it("lists the other providers serving the model, same driver first, never per token", () => {
    const order = recommendedModelProviderOrder(entries, opus, []);
    expect(order.own?.instanceId).toBe("claudeAgent");
    expect(ids(order)).toEqual(["claudeWork:claude-opus-5-5", "copilot:claude-opus-5.5"]);
  });

  it("follows the saved order", () => {
    const order = recommendedModelProviderOrder(entries, opus, [
      ProviderInstanceId.make("copilot"),
    ]);
    expect(ids(order)).toEqual(["copilot:claude-opus-5.5", "claudeWork:claude-opus-5-5"]);
  });

  it("finds nothing for a model only one provider serves", () => {
    const gpt = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6");
    expect(recommendedModelProviderOrder(entries, gpt, []).others).toEqual([]);
  });
});
