import { describe, expect, it } from "vite-plus/test";

import { providerBrandFor } from "./ProviderLogo";

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
