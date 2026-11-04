import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DEFAULT_ADVERSARIAL_REVIEW_SETTINGS } from "./adversarialReview.ts";
import { ProjectSettingsOverrides, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("adversarialReview setting", () => {
  it("is off by default and older settings files decode", () => {
    const settings = decodeServerSettings({});
    expect(settings.adversarialReview).toEqual(DEFAULT_ADVERSARIAL_REVIEW_SETTINGS);
    expect(settings.modelTiers).toEqual({});
  });

  it("persists a policy and tier models through encode and decode", () => {
    const saved = decodeServerSettings({
      adversarialReview: {
        autoOnFeatureComplete: true,
        reviewers: [{ instanceId: "codex", model: "gpt-6.1-sol" }],
        tier: "frontier",
      },
      modelTiers: { codex: { regular: "gpt-6.1-sol", frontier: "gpt-6-astra" } },
    });
    const reloaded = decodeServerSettings(encodeServerSettings(saved));
    expect(reloaded.adversarialReview).toEqual({
      autoOnFeatureComplete: true,
      reviewers: [{ instanceId: "codex", model: "gpt-6.1-sol" }],
      tier: "frontier",
    });
    expect(reloaded.modelTiers).toEqual({
      codex: { regular: "gpt-6.1-sol", frontier: "gpt-6-astra" },
    });
  });

  it("fills a partial policy and rejects unknown tiers and long reviewer lists", () => {
    expect(
      decodeServerSettings({ adversarialReview: { autoOnFeatureComplete: true } })
        .adversarialReview,
    ).toEqual({ ...DEFAULT_ADVERSARIAL_REVIEW_SETTINGS, autoOnFeatureComplete: true });
    expect(() => decodeServerSettings({ adversarialReview: { tier: "ultra" } })).toThrow();
    expect(() =>
      decodeServerSettings({
        adversarialReview: {
          reviewers: Array.from({ length: 9 }, (_, index) => ({
            instanceId: "codex",
            model: `gpt-${index}`,
          })),
        },
      }),
    ).toThrow();
  });

  it("can be overridden per project and patched", () => {
    expect(
      Schema.decodeUnknownSync(ProjectSettingsOverrides)({
        adversarialReview: { autoOnFeatureComplete: true },
      }).adversarialReview?.autoOnFeatureComplete,
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        modelTiers: { claudeAgent: { regular: "claude-opus-5-5" } },
      }).modelTiers,
    ).toEqual({ claudeAgent: { regular: "claude-opus-5-5" } });
  });
});
