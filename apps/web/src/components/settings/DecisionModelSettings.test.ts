import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decisionModelPatch } from "./DecisionModelSettings";

const off = DEFAULT_SERVER_SETTINGS.decisionModel;
const openRouter = { ...off, provider: "openrouter" as const, apiKey: "••••" };

describe("decisionModelPatch", () => {
  it("chooses a provider and saves a typed key", () => {
    expect(decisionModelPatch({ saved: off, provider: "openrouter" })).toEqual({
      provider: "openrouter",
    });
    expect(decisionModelPatch({ saved: openRouter, key: " sk-or-1 " })).toEqual({
      apiKey: "sk-or-1",
    });
  });

  it("drops the saved key when moving to the other provider, keeps it across off", () => {
    expect(decisionModelPatch({ saved: openRouter, provider: "typesafe" })).toEqual({
      provider: "typesafe",
      apiKey: "",
    });
    expect(decisionModelPatch({ saved: openRouter, provider: "off" })).toEqual({ provider: "off" });
    expect(
      decisionModelPatch({ saved: { ...openRouter, provider: "off" }, provider: "openrouter" }),
    ).toEqual({ provider: "openrouter" });
  });

  it("removes the key on request", () => {
    expect(decisionModelPatch({ saved: openRouter, removeKey: true })).toEqual({ apiKey: "" });
  });
});
