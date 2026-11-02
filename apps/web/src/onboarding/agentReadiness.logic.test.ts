import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentReadinessMessage, summarizeAgentReadiness } from "./agentReadiness.logic";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}
const signedOut = provider({ status: "error", auth: { status: "unauthenticated" } });
const missing = provider({ installed: false, status: "error", auth: { status: "unknown" } });
const unverified = provider({ status: "warning", auth: { status: "unknown" } });

describe("summarizeAgentReadiness", () => {
  it("checks until a machine answers, and while a probe is still running", () => {
    expect(summarizeAgentReadiness([{ label: "Mac", providers: null }]).kind).toBe("checking");
    const probing = provider({ installed: false, status: "warning", auth: { status: "unknown" } });
    expect(summarizeAgentReadiness([{ label: "Mac", providers: [probing] }]).kind).toBe("checking");
  });

  it("reads nothing ready when every agent is missing or signed out", () => {
    const readiness = summarizeAgentReadiness([{ label: "Mac", providers: [signedOut, missing] }]);
    expect(readiness).toEqual({ kind: "none" });
    expect(agentReadinessMessage(readiness)).toContain("chats will not start");
    expect(agentReadinessMessage(readiness)).toContain("Sign in or install one above");
  });

  it("counts a provider setup does not list and names it", () => {
    const copilot = provider({
      instanceId: ProviderInstanceId.make("copilot"),
      driver: ProviderDriverKind.make("copilot"),
      displayName: "GitHub Copilot",
    });
    const readiness = summarizeAgentReadiness([{ label: "Mac", providers: [signedOut, copilot] }]);
    expect(agentReadinessMessage(readiness)).toBe("Ready: GitHub Copilot.");
  });

  it("names machines when there are several and flags the one with nothing ready", () => {
    const readiness = summarizeAgentReadiness([
      { label: "Mac", providers: [provider()] },
      { label: "Windows PC", providers: [signedOut] },
    ]);
    expect(readiness).toMatchObject({
      kind: "ready",
      agents: ["Claude on Mac"],
      machinesWithoutAgent: ["Windows PC"],
    });
    expect(agentReadinessMessage(readiness)).toBe(
      "Ready: Claude on Mac. Nothing is ready on Windows PC, so chats there will not start.",
    );
  });

  it("does not call a machine empty before it has answered", () => {
    expect(
      summarizeAgentReadiness([
        { label: "Mac", providers: [provider()] },
        { label: "Windows PC", providers: null },
      ]),
    ).toMatchObject({ kind: "ready", machinesWithoutAgent: [] });
  });

  it("says an unread sign-in could not be confirmed instead of ready", () => {
    const readiness = summarizeAgentReadiness([{ label: "Mac", providers: [unverified] }]);
    expect(readiness.kind).toBe("unconfirmed");
    expect(agentReadinessMessage(readiness)).toContain("could not be confirmed");
  });

  it("names only confirmed agents when one is confirmed", () => {
    const codex = provider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
    });
    expect(
      agentReadinessMessage(
        summarizeAgentReadiness([{ label: "Mac", providers: [unverified, codex] }]),
      ),
    ).toBe("Ready: Codex.");
  });
});
