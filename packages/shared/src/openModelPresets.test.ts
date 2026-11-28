import { describe, expect, it } from "vitest";

import { classifyBaseUrlBilling } from "./modelBilling.ts";
import {
  buildOpenModelEnvironment,
  isOpenModelRoute,
  OPEN_MODEL_PRESET_ENV,
  OPEN_MODEL_PRESETS,
  openModelPresetById,
  openModelPresetModelIds,
  openModelPresetOfEnvironment,
  openModelPriceNote,
  openModelRouteLabel,
} from "./openModelPresets.ts";

const preset = (id: string) => {
  const found = openModelPresetById(id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
};
const rowsOf = (environment: ReturnType<typeof buildOpenModelEnvironment>) =>
  Object.fromEntries(environment.map((row) => [row.name, row]));

describe("open-model presets", () => {
  it("lists the six presets with their vendor endpoints and no coding-plan path", () => {
    expect(OPEN_MODEL_PRESETS.map((entry) => entry.id)).toEqual([
      "deepseek",
      "kimi",
      "zai",
      "openrouter",
      "ollama",
      "lmstudio",
    ]);
    for (const entry of OPEN_MODEL_PRESETS) {
      expect(entry.baseUrl).not.toMatch(/\/coding(\/|$)/);
      expect(entry.docsUrl).toMatch(/^https:\/\//);
      if (entry.kind === "key") expect(entry.keyConsoleUrl).toMatch(/^https:\/\//);
    }
  });

  it("never classifies a preset as a subscription", () => {
    const billing = Object.fromEntries(
      OPEN_MODEL_PRESETS.map((entry) => [
        entry.id,
        classifyBaseUrlBilling(entry.baseUrl, entry.billingProviderId),
      ]),
    );
    expect(billing).toEqual({
      deepseek: "api",
      kimi: "api",
      zai: "api",
      openrouter: "paid-router",
      ollama: "local",
      lmstudio: "local",
    });
  });

  it("builds a keyed route with a sensitive token and every other credential blanked", () => {
    const rows = rowsOf(
      buildOpenModelEnvironment({ preset: preset("deepseek"), key: "  sk-test-123  " }),
    );
    expect(rows[OPEN_MODEL_PRESET_ENV]).toEqual({
      name: OPEN_MODEL_PRESET_ENV,
      value: "deepseek",
      sensitive: false,
    });
    expect(rows.ANTHROPIC_BASE_URL?.value).toBe("https://api.deepseek.com/anthropic");
    expect(rows.ANTHROPIC_AUTH_TOKEN).toEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "sk-test-123",
      sensitive: true,
    });
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]) {
      expect(rows[name]?.value).toBe("");
    }
    expect(rows.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB?.value).toBe("1");
    expect(rows.ANTHROPIC_DEFAULT_OPUS_MODEL?.value).toBe("deepseek-flash");
    expect(rows.ANTHROPIC_DEFAULT_HAIKU_MODEL?.value).toBe("deepseek-flash");
  });

  it("marks only the key row sensitive", () => {
    const environment = buildOpenModelEnvironment({ preset: preset("zai"), key: "k" });
    expect(environment.filter((row) => row.sensitive).map((row) => row.name)).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });

  it("refuses a keyed preset without a key", () => {
    expect(() => buildOpenModelEnvironment({ preset: preset("kimi"), key: "   " })).toThrow(
      "Kimi needs your API key.",
    );
  });

  it("builds a local route with no secret and the runtime's placeholder token", () => {
    const rows = rowsOf(
      buildOpenModelEnvironment({
        preset: preset("lmstudio"),
        key: "ignored",
        baseUrl: "http://127.0.0.1:1300",
        model: "qwen3-coder-30b",
      }),
    );
    expect(rows.ANTHROPIC_AUTH_TOKEN).toEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "lmstudio",
      sensitive: false,
    });
    expect(rows.ANTHROPIC_BASE_URL?.value).toBe("http://127.0.0.1:1300");
    expect(rows.ANTHROPIC_DEFAULT_SONNET_MODEL?.value).toBe("qwen3-coder-30b");
    expect(rows.CLAUDE_CODE_ATTRIBUTION_HEADER?.value).toBe("0");
  });

  it("leaves model rows out when a preset has no fixed ids and none was chosen", () => {
    const rows = rowsOf(buildOpenModelEnvironment({ preset: preset("ollama") }));
    expect(rows.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(openModelPresetModelIds(preset("ollama"))).toEqual([]);
    expect(openModelPresetModelIds(preset("zai"))).toEqual(["glm-5.4", "glm-5.3-flash"]);
  });

  it("reads the marker back from rows and snapshots", () => {
    const environment = buildOpenModelEnvironment({ preset: preset("ollama") });
    expect(openModelPresetOfEnvironment(environment)?.id).toBe("ollama");
    expect(openModelPresetOfEnvironment([])).toBeUndefined();
    expect(isOpenModelRoute({ openModelPreset: "openrouter" })).toBe(true);
    expect(isOpenModelRoute({ openModelPreset: "someone-else" })).toBe(false);
    expect(isOpenModelRoute({})).toBe(false);
    expect(isOpenModelRoute(undefined)).toBe(false);
  });

  it("labels keyed routes and local routes without price numbers", () => {
    expect(openModelRouteLabel(preset("kimi"))).toBe("Your key");
    expect(openModelRouteLabel(preset("ollama"))).toBe("Local");
    expect(openModelPriceNote(preset("openrouter"))).toBe(
      "OpenRouter bills your key at its own list price.",
    );
    expect(openModelPriceNote(preset("lmstudio"))).toBe("Runs on your own LM Studio.");
  });
});
