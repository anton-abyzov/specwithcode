import { OPEN_MODEL_PRESETS } from "@specweave-studio/shared/openModelPresets";
import { describe, expect, it } from "vite-plus/test";

import { isProviderBrand, providerBrandFor } from "./ProviderLogo";

describe("providerBrandFor", () => {
  it("maps built-in drivers to their vendor's mark", () => {
    expect(providerBrandFor({ driverKind: "claudeAgent" })).toBe("claude");
    expect(providerBrandFor({ driverKind: "codex" })).toBe("openai");
    expect(providerBrandFor({ driverKind: "grok" })).toBe("grok");
    expect(providerBrandFor({ driverKind: "muse" })).toBe("meta");
    expect(providerBrandFor({ driverKind: "unknown" })).toBeNull();
  });

  it("names ACP Registry agents by registry identity, never by display name", () => {
    expect(
      providerBrandFor({ driverKind: "acpRegistry", acpRegistryAgentId: "github-copilot-cli" }),
    ).toBe("copilot");
    expect(providerBrandFor({ driverKind: "acpRegistry", acpRegistryAgentId: "gemini" })).toBe(
      "gemini",
    );
    expect(
      providerBrandFor({
        driverKind: "acpRegistry",
        acpRegistryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/qwen-code.svg",
      }),
    ).toBe("qwen");
    expect(providerBrandFor({ driverKind: "acpRegistry", acpRegistryAgentId: "opencode-v2" })).toBe(
      "opencode",
    );
    expect(
      providerBrandFor({ driverKind: "acpRegistry", acpRegistryAgentId: "deepseek-harness" }),
    ).toBe("deepseek");
    // A local command whose agent id was cleared keeps the generic mark.
    expect(providerBrandFor({ driverKind: "acpRegistry" })).toBeNull();
    // Icon URLs off the official CDN are ignored.
    expect(
      providerBrandFor({
        driverKind: "acpRegistry",
        acpRegistryIconUrl: "https://example.com/registry/v1/latest/gemini.svg",
      }),
    ).toBeNull();
    expect(providerBrandFor({ driverKind: "acpRegistry", acpRegistryAgentId: "kilo" })).toBeNull();
  });
});

describe("open-model marks", () => {
  it("draws the vendor's mark for a Claude Code instance made from a preset", () => {
    expect(
      OPEN_MODEL_PRESETS.map((preset) =>
        providerBrandFor({ driverKind: "claudeAgent", openModelPreset: preset.id }),
      ),
    ).toEqual(["deepseek", "kimi", "zai", "openrouter", "ollama", "lmstudio"]);
    expect(OPEN_MODEL_PRESETS.every((preset) => isProviderBrand(preset.brand))).toBe(true);
  });

  it("keeps every other instance's mark as before", () => {
    // No marker (an instance built by hand with its own base URL), or an unknown one.
    expect(providerBrandFor({ driverKind: "claudeAgent" })).toBe("claude");
    expect(providerBrandFor({ driverKind: "claudeAgent", openModelPreset: "mistral" })).toBe(
      "claude",
    );
    // Pi and OpenCode routes never take a preset mark.
    expect(providerBrandFor({ driverKind: "pi", openModelPreset: "deepseek" })).toBe("pi");
    expect(providerBrandFor({ driverKind: "opencode", openModelPreset: "openrouter" })).toBe(
      "opencode",
    );
    expect(
      providerBrandFor({
        driverKind: "acpRegistry",
        acpRegistryAgentId: "gemini",
        openModelPreset: "kimi",
      }),
    ).toBe("gemini");
  });
});
