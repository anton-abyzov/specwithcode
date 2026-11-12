import { describe, expect, it } from "vite-plus/test";
import { providerUsageLink } from "./providerUsageLinks";

describe("providerUsageLink", () => {
  it("links each subscription provider to its own usage page", () => {
    expect(providerUsageLink({ driver: "claudeAgent" })?.url).toBe(
      "https://claude.ai/settings/usage",
    );
    expect(providerUsageLink({ driver: "codex" })?.url).toBe("https://chatgpt.com/#settings/Usage");
    expect(providerUsageLink({ driver: "cursor" })?.url).toBe("https://cursor.com/dashboard");
  });

  it("finds Copilot behind an ACP registry agent", () => {
    expect(providerUsageLink({ driver: "acpRegistry", agentId: "github-copilot" })?.kind).toBe(
      "copilot",
    );
    expect(
      providerUsageLink({ driver: "acpRegistry", label: "Copilot personal (someone)" })?.kind,
    ).toBe("copilot");
  });

  it("gives no link when the page is unknown or the account is an API key", () => {
    expect(providerUsageLink({ driver: "grok" })).toBeNull();
    expect(providerUsageLink({ driver: "acpRegistry", label: "Devin" })).toBeNull();
    expect(providerUsageLink({ driver: "codex", subscription: false })).toBeNull();
    expect(providerUsageLink({ driver: null })).toBeNull();
  });

  it("never puts an account in the URL", () => {
    const link = providerUsageLink({ driver: "claudeAgent", label: "dev@example.com" });
    expect(link?.url).not.toContain("example");
  });
});
