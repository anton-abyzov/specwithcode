import { OPEN_MODEL_PRESETS, openModelPresetById } from "@specweave-studio/shared/openModelPresets";
import { describe, expect, it } from "vite-plus/test";

import {
  canCreateOpenModelInstance,
  openModelInstance,
  openModelPresetNeedsModel,
} from "./openModelInstance";

const preset = (id: string) => {
  const found = openModelPresetById(id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};

const blanked = [
  { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: false },
  { name: "CLAUDE_CODE_USE_BEDROCK", value: "", sensitive: false },
  { name: "CLAUDE_CODE_USE_VERTEX", value: "", sensitive: false },
  { name: "CLAUDE_CODE_USE_FOUNDRY", value: "", sensitive: false },
];

describe("openModelInstance", () => {
  it("makes a Claude Code instance on the vendor endpoint, its key kept sensitive", () => {
    const deepseek = openModelInstance({
      preset: preset("deepseek"),
      key: " sk-test-deepseek ",
      existingIds: new Set(["claudeAgent"]),
    });
    expect(deepseek).toEqual({
      instanceId: "claudeAgent_deepseek",
      instance: {
        driver: "claudeAgent",
        enabled: true,
        displayName: "DeepSeek",
        environment: [
          { name: "SPECWITHCODE_OPEN_MODEL_PRESET", value: "deepseek", sensitive: false },
          {
            name: "ANTHROPIC_BASE_URL",
            value: "https://api.deepseek.com/anthropic",
            sensitive: false,
          },
          { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-test-deepseek", sensitive: true },
          ...blanked,
          { name: "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", value: "1", sensitive: false },
          { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "deepseek-flash", sensitive: false },
          { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: "deepseek-flash", sensitive: false },
          { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "deepseek-flash", sensitive: false },
          { name: "CLAUDE_CODE_SUBAGENT_MODEL", value: "deepseek-flash", sensitive: false },
        ],
        config: { customModels: ["deepseek-flash"] },
      },
    });
    // The key row is the only sensitive row, so the server stores it as a secret.
    expect(deepseek.instance.environment?.filter((row) => row.sensitive)).toEqual([
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-test-deepseek", sensitive: true },
    ]);
  });

  it("lists both vendor models and never replaces an existing instance", () => {
    const zai = openModelInstance({
      preset: preset("zai"),
      key: "sk-test-zai",
      existingIds: new Set(["claudeAgent_zai"]),
    });
    expect(zai.instanceId).toBe("claudeAgent_zai_2");
    expect(zai.instance.displayName).toBe("Z.ai GLM");
    expect(zai.instance.config).toEqual({ customModels: ["glm-5.4", "glm-5.3-flash"] });
  });

  it("puts the model id named for OpenRouter in every slot and the picker", () => {
    const router = openModelInstance({
      preset: preset("openrouter"),
      key: "sk-test-or",
      model: " vendor/model-1 ",
      existingIds: new Set(),
    });
    expect(router.instanceId).toBe("claudeAgent_openrouter");
    expect(router.instance.config).toEqual({ customModels: ["vendor/model-1"] });
    expect(
      router.instance.environment?.find((row) => row.name === "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ).toEqual({
      name: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      value: "vendor/model-1",
      sensitive: false,
    });
  });

  it("needs nothing for a local runtime, and keeps an address it was given", () => {
    const ollama = openModelInstance({ preset: preset("ollama"), existingIds: new Set() });
    expect(ollama.instanceId).toBe("claudeAgent_ollama");
    // The runtime lists its own models, so none are written until discovery.
    expect(ollama.instance.config).toBeUndefined();
    expect(ollama.instance.environment?.slice(0, 3)).toEqual([
      { name: "SPECWITHCODE_OPEN_MODEL_PRESET", value: "ollama", sensitive: false },
      { name: "ANTHROPIC_BASE_URL", value: "http://localhost:11434", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "ollama", sensitive: false },
    ]);
    expect(ollama.instance.environment?.some((row) => row.sensitive)).toBe(false);

    const lmstudio = openModelInstance({
      preset: preset("lmstudio"),
      key: "sk-test-ignored",
      baseUrl: " http://127.0.0.1:1300 ",
      model: "qwen-local",
      existingIds: new Set(),
    });
    const rows = lmstudio.instance.environment ?? [];
    expect(rows.find((row) => row.name === "ANTHROPIC_BASE_URL")?.value).toBe(
      "http://127.0.0.1:1300",
    );
    expect(rows.find((row) => row.name === "ANTHROPIC_AUTH_TOKEN")).toEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "lmstudio",
      sensitive: false,
    });
    expect(rows.some((row) => row.value === "sk-test-ignored")).toBe(false);
    expect(rows.at(-1)).toEqual({
      name: "CLAUDE_CODE_ATTRIBUTION_HEADER",
      value: "0",
      sensitive: false,
    });
    expect(lmstudio.instance.config).toEqual({ customModels: ["qwen-local"] });
  });

  it("never sends a keyed preset to another address", () => {
    const kimi = openModelInstance({
      preset: preset("kimi"),
      key: "sk-test-kimi",
      baseUrl: "http://127.0.0.1:9999",
      existingIds: new Set(),
    });
    expect(kimi.instance.environment?.find((row) => row.name === "ANTHROPIC_BASE_URL")?.value).toBe(
      "https://api.moonshot.ai/anthropic",
    );
  });
});

describe("open-model form rules", () => {
  it("asks a keyed preset for its key, and OpenRouter alone for a model id", () => {
    expect(OPEN_MODEL_PRESETS.filter(openModelPresetNeedsModel).map((entry) => entry.id)).toEqual([
      "openrouter",
    ]);
    expect(canCreateOpenModelInstance({ preset: preset("kimi"), key: " ", model: "" })).toBe(false);
    expect(canCreateOpenModelInstance({ preset: preset("kimi"), key: "sk-test", model: "" })).toBe(
      true,
    );
    expect(
      canCreateOpenModelInstance({ preset: preset("openrouter"), key: "sk-test", model: "" }),
    ).toBe(false);
    expect(
      canCreateOpenModelInstance({ preset: preset("openrouter"), key: "sk-test", model: "a/b" }),
    ).toBe(true);
    expect(canCreateOpenModelInstance({ preset: preset("ollama"), key: "", model: "" })).toBe(true);
  });
});
