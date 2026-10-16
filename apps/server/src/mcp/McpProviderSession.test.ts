import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  clearMcpProviderSession,
  clearMcpProviderSessionCredential,
  isLiveMcpProviderSession,
  readMcpProviderCredentials,
  readMcpProviderSession,
  setMcpProviderSession,
  withAgentDeviceEnvironment,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/studio/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/studio/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("credential refresh", () => {
  const threadId = ThreadId.make("thread-switch");
  const session = (providerInstanceId: string, authorizationHeader: string) => ({
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: `session-${providerInstanceId}`,
    providerInstanceId: ProviderInstanceId.make(providerInstanceId),
    endpoint: "http://127.0.0.1:8319/mcp",
    authorizationHeader,
    browserToolsAvailable: false,
  });
  const grok = ProviderInstanceId.make("grok");
  const codex = ProviderInstanceId.make("codex");

  it("hands a thread's credential only to the provider instance it was issued for", () => {
    try {
      setMcpProviderSession(session("grok", "Bearer grok-token"));
      expect(readMcpProviderCredentials(threadId, grok)).toEqual({
        endpoint: "http://127.0.0.1:8319/mcp",
        authorization: "Bearer grok-token",
      });
      // The thread switches to codex. A lingering grok runtime keeps its own
      // credential and never adopts codex's.
      setMcpProviderSession(session("codex", "Bearer codex-token"));
      expect(readMcpProviderCredentials(threadId, grok)?.authorization).toBe("Bearer grok-token");
      expect(readMcpProviderCredentials(threadId, codex)?.authorization).toBe("Bearer codex-token");
      expect(readMcpProviderCredentials(threadId, undefined)).toBeUndefined();
      expect(
        readMcpProviderCredentials(threadId, ProviderInstanceId.make("cursor")),
      ).toBeUndefined();
    } finally {
      clearMcpProviderSession(threadId);
    }
  });

  it("keeps each instance's session apart and points instance-less lookups at the last one prepared", () => {
    try {
      setMcpProviderSession(session("grok", "Bearer grok-token"));
      setMcpProviderSession(session("codex", "Bearer codex-token"));
      expect(readMcpProviderSession(threadId)?.providerInstanceId).toBe(codex);
      expect(readMcpProviderSession(threadId, grok)?.authorizationHeader).toBe("Bearer grok-token");
      expect(
        isLiveMcpProviderSession({
          threadId,
          providerInstanceId: grok,
          providerSessionId: "session-grok",
        }),
      ).toBe(true);
      // Another session id of the same instance is not the attached one.
      expect(
        isLiveMcpProviderSession({
          threadId,
          providerInstanceId: grok,
          providerSessionId: "stale",
        }),
      ).toBe(false);

      // Releasing codex's credential leaves grok's, which instance-less lookups now get.
      clearMcpProviderSessionCredential(threadId, "session-codex");
      expect(readMcpProviderSession(threadId, codex)).toBeUndefined();
      expect(readMcpProviderSession(threadId)?.providerInstanceId).toBe(grok);
      clearMcpProviderSession(threadId, grok);
      expect(readMcpProviderSession(threadId)).toBeUndefined();
      expect(
        isLiveMcpProviderSession({
          threadId,
          providerInstanceId: grok,
          providerSessionId: "session-grok",
        }),
      ).toBe(false);
    } finally {
      clearMcpProviderSession(threadId);
    }
  });
});
