import { ProviderDriverKind } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupResolver, providerGroupOf } from "./providerGroups";

const acp = ProviderDriverKind.make("acpRegistry");
const codex = ProviderDriverKind.make("codex");
const icon = (id: string) => `https://cdn.agentclientprotocol.com/registry/v1/latest/${id}.svg`;

describe("providerGroupOf", () => {
  it("keeps a built-in driver as its own provider", () => {
    expect(providerGroupOf({ driver: codex, displayName: "Codex work" })).toMatchObject({
      key: "codex",
      driver: codex,
      iconUrl: null,
    });
  });

  it("names a registry agent by its registry identity before its instance name", () => {
    expect(
      providerGroupOf({
        driver: acp,
        displayName: "My agent",
        iconUrl: icon("github-copilot-cli"),
      }),
    ).toMatchObject({ key: "acpRegistry:copilot", label: "GitHub Copilot" });
    expect(providerGroupOf({ driver: acp, iconUrl: icon("gemini") })).toMatchObject({
      key: "acpRegistry:gemini",
      label: "Gemini CLI",
    });
  });

  it("falls back to the instance name, and never to the transport's name", () => {
    expect(
      providerGroupOf({ driver: acp, displayName: "GitHub Copilot Enterprise" }),
    ).toMatchObject({ key: "acpRegistry:copilot", label: "GitHub Copilot" });
    expect(providerGroupOf({ driver: acp, displayName: "Zed Helper" })).toMatchObject({
      key: "acpRegistry:name:zed helper",
      label: "Zed Helper",
    });
    expect(providerGroupOf({ driver: acp }).label).toBe("Other registry agents");
  });

  it("keeps two instances of an agent without a bundled mark together by registry id", () => {
    const work = providerGroupOf({
      driver: acp,
      displayName: "Devin Work",
      iconUrl: icon("devin"),
    });
    const home = providerGroupOf({
      driver: acp,
      displayName: "Devin Home",
      iconUrl: icon("devin"),
    });
    expect(work.key).toBe("acpRegistry:agent:devin");
    expect(home.key).toBe(work.key);
  });

  it("ignores an icon URL off the registry's own origin", () => {
    expect(
      providerGroupOf({
        driver: acp,
        displayName: "Agent",
        iconUrl: "https://example.com/gemini.svg",
      }).key,
    ).toBe("acpRegistry:name:agent");
  });
});

describe("groupResolver", () => {
  it("files a ledger period under the agent of the account it belongs to", () => {
    const groupOf = groupResolver([
      { accountKey: "acpRegistry:a@example.com", driver: acp, iconUrl: icon("github-copilot-cli") },
      { accountKey: null, driver: acp, displayName: "Gemini CLI" },
    ]);
    expect(groupOf("acpRegistry:a@example.com", acp).label).toBe("GitHub Copilot");
    // An account no row describes stays with its driver's catch-all, never another agent.
    expect(groupOf("acpRegistry:gone@example.com", acp).label).toBe("Other registry agents");
  });
});
