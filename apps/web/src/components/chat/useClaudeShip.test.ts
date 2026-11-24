import type { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudeShipContextValues } from "./useClaudeShip";

const instance = "claude-main" as ProviderInstanceId;
const projection = {
  thread: { activeProviderThreadId: "pt-1" },
  providerThreads: [
    {
      id: "pt-0",
      driver: "claudeAgent",
      providerInstanceId: "claude-main",
      nativeThreadRef: { nativeId: "old-session" },
    },
    {
      id: "pt-1",
      driver: "claudeAgent",
      providerInstanceId: "claude-main",
      nativeThreadRef: { nativeId: "0f6c8a5e-1111-4222-8333-444455556666" },
    },
  ],
};

describe("claudeShipContextValues", () => {
  it("reads the active Claude session, version and configured program", () => {
    expect(
      claudeShipContextValues({
        projection,
        driverKind: "claudeAgent",
        providerInstanceId: instance,
        providerStatus: { version: "2.1.331" },
        providerInstances: { "claude-main": { config: { binaryPath: " ~/.local/bin/claude " } } },
        platformOs: "darwin",
      }),
    ).toEqual({
      providerInstanceId: instance,
      sessionId: "0f6c8a5e-1111-4222-8333-444455556666",
      cliVersion: "2.1.331",
      binaryPath: "~/.local/bin/claude",
      platformOs: "darwin",
    });
  });

  it("starts fresh when the session belongs to another account or the thread has none", () => {
    const other = claudeShipContextValues({
      projection,
      driverKind: "claudeAgent",
      providerInstanceId: "claude-work" as ProviderInstanceId,
      providerStatus: null,
      providerInstances: undefined,
      platformOs: null,
    });
    expect(other.sessionId).toBeNull();
    expect(other.binaryPath).toBe("claude");
    expect(
      claudeShipContextValues({
        projection: null,
        driverKind: "claudeAgent",
        providerInstanceId: instance,
        providerStatus: null,
        providerInstances: undefined,
        platformOs: null,
      }).sessionId,
    ).toBeNull();
  });

  it("carries nothing over from a thread that is not on Claude", () => {
    const codex = claudeShipContextValues({
      projection,
      driverKind: "codex",
      providerInstanceId: instance,
      providerStatus: { version: "0.80.0" },
      providerInstances: undefined,
      platformOs: "darwin",
    });
    expect(codex).toMatchObject({ providerInstanceId: null, sessionId: null, cliVersion: null });
  });
});
