import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { environmentsNeedingChatSetup, hasChatReadyProvider } from "./usageChatSetup";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", email: "me@example.com" },
    checkedAt: "2026-10-15T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const quotaOnly = provider({
  status: "error",
  auth: { status: "unauthenticated" },
  usageLimits: { checkedAt: "2026-10-15T00:00:00.000Z", windows: [] },
});

function machine(
  label: string,
  providers: ReadonlyArray<ServerProvider> | undefined,
  phase = "connected",
) {
  return {
    entry: { target: { label } },
    connection: { phase },
    serverConfig: providers === undefined ? {} : { providers },
  };
}

describe("hasChatReadyProvider", () => {
  it("accepts a ready, signed-in provider of any driver", () => {
    expect(hasChatReadyProvider([provider()])).toBe(true);
    expect(
      hasChatReadyProvider([
        quotaOnly,
        provider({
          instanceId: ProviderInstanceId.make("copilot"),
          driver: ProviderDriverKind.make("acpRegistry"),
          auth: { status: "unknown" },
        }),
      ]),
    ).toBe(true);
  });

  it("rejects providers the model picker would not offer", () => {
    expect(hasChatReadyProvider([])).toBe(false);
    expect(hasChatReadyProvider([quotaOnly])).toBe(false);
    expect(hasChatReadyProvider([provider({ enabled: false })])).toBe(false);
    expect(hasChatReadyProvider([provider({ installed: false })])).toBe(false);
    expect(hasChatReadyProvider([provider({ availability: "unavailable" })])).toBe(false);
    expect(hasChatReadyProvider([provider({ status: "warning" })])).toBe(false);
    expect(hasChatReadyProvider([provider({ auth: { status: "unauthenticated" } })])).toBe(false);
  });
});

describe("environmentsNeedingChatSetup", () => {
  it("offers setup only on connected machines with no ready chat provider", () => {
    const m1 = EnvironmentId.make("m1");
    const m4 = EnvironmentId.make("m4");
    const fresh = EnvironmentId.make("fresh");
    const offline = EnvironmentId.make("offline");
    const loading = EnvironmentId.make("loading");
    const presentations = new Map([
      [m1, machine("MacBook Pro M1Max (190)", [provider()])],
      // The M4 regression: ready Codex, Claude and Copilot used to get a chip anyway.
      [
        m4,
        machine("MacBook M4MAX (149)", [
          provider(),
          provider({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
          }),
        ]),
      ],
      [fresh, machine("Fresh Mac", [quotaOnly])],
      [offline, machine("Offline Mac", [], "disconnected")],
      [loading, machine("Loading Mac", undefined)],
    ]);
    expect(environmentsNeedingChatSetup(presentations)).toEqual([
      { environmentId: fresh, label: "Fresh Mac" },
    ]);
  });

  it("is empty when every machine is ready", () => {
    expect(
      environmentsNeedingChatSetup(
        new Map([
          [EnvironmentId.make("a"), machine("A", [provider()])],
          [EnvironmentId.make("b"), machine("B", [provider()])],
        ]),
      ),
    ).toEqual([]);
  });
});
