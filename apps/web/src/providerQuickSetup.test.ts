import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProviderInstanceSettings, deriveProviderInstanceEntries } from "./providerInstances";
import {
  oneClickInstallAgentId,
  planEnableHere,
  providersOnOtherMachines,
} from "./providerQuickSetup";

type Settings = Pick<ServerSettings, "providerInstances" | "providers">;

function snapshot(input: {
  instanceId: string;
  driver: string;
  installed?: boolean;
  status?: ServerProvider["status"];
  displayName?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-16T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

const copilotInstance = (enabled = true) => ({
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled,
  displayName: "GitHub Copilot",
  config: { agentId: "github-copilot-cli", distribution: "auto" },
});

function entries(providers: ServerProvider[], settings: Settings) {
  return applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings);
}

const m4Settings = {
  providers: { grok: { enabled: true } },
  providerInstances: { copilot: copilotInstance() },
} as unknown as Settings;
const m4 = {
  environmentId: EnvironmentId.make("m4"),
  label: "M4 Max",
  entries: entries(
    [
      snapshot({ instanceId: "codex", driver: "codex" }),
      snapshot({ instanceId: "grok", driver: "grok", displayName: "Grok" }),
      snapshot({ instanceId: "copilot", driver: "acpRegistry", displayName: "GitHub Copilot" }),
    ],
    m4Settings,
  ),
};

describe("providersOnOtherMachines", () => {
  it("offers what another machine runs and this one does not", () => {
    // A fresh laptop: Grok defaults off, Copilot never added.
    const laptopSettings = { providers: { grok: { enabled: false } }, providerInstances: {} };
    const here = entries(
      [
        snapshot({ instanceId: "codex", driver: "codex" }),
        snapshot({ instanceId: "grok", driver: "grok", status: "disabled" }),
      ],
      laptopSettings as unknown as Settings,
    );
    const offered = providersOnOtherMachines({ here, others: [m4] });
    expect(offered.map((provider) => [provider.identity, provider.machineLabels])).toEqual([
      ["driver:grok", ["M4 Max"]],
      ["acp:github-copilot-cli", ["M4 Max"]],
    ]);
  });

  it("offers nothing that is already on here, and skips providers not ready elsewhere", () => {
    const here = m4.entries;
    const broken = {
      ...m4,
      label: "M1",
      entries: entries([snapshot({ instanceId: "pi", driver: "pi", status: "error" })], {
        providers: { pi: { enabled: true } },
        providerInstances: {},
      } as unknown as Settings),
    };
    expect(providersOnOtherMachines({ here, others: [m4, broken] })).toEqual([]);
  });
});

describe("oneClickInstallAgentId", () => {
  it("offers Install for an enabled, unprepared featured registry agent only", () => {
    const settings = { providers: {}, providerInstances: { copilot: copilotInstance() } };
    const [unprepared] = entries(
      [
        snapshot({
          instanceId: "copilot",
          driver: "acpRegistry",
          installed: false,
          status: "warning",
        }),
      ],
      settings as unknown as Settings,
    );
    expect(oneClickInstallAgentId(unprepared!)).toBe("github-copilot-cli");
    const [installed] = entries(
      [snapshot({ instanceId: "copilot", driver: "acpRegistry" })],
      settings as unknown as Settings,
    );
    expect(oneClickInstallAgentId(installed!)).toBeNull();
  });
});

describe("planEnableHere", () => {
  const [grok, copilot] = providersOnOtherMachines({
    here: [],
    others: [m4],
  }).filter((provider) => provider.identity !== "driver:codex");

  it("turns on the default instance without copying the legacy off switch", () => {
    const plan = planEnableHere(grok!, {
      providers: { grok: { enabled: false, binaryPath: "grok" } },
      providerInstances: {},
    } as unknown as Settings);
    expect(plan.mutation).toEqual({
      operation: "upsert",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, config: { binaryPath: "grok" } },
    });
    expect(plan.prepareAgentId).toBeNull();
  });

  it("reuses a disabled registry instance, then prepares its agent", () => {
    const plan = planEnableHere(copilot!, {
      providers: {},
      providerInstances: { mine: copilotInstance(false) },
    } as unknown as Settings);
    expect(plan.mutation.operation).toBe("upsert");
    expect(plan.instanceId).toBe("mine");
    expect(plan.prepareAgentId).toBe("github-copilot-cli");
  });

  it("creates a registry instance with no machine paths or environment", () => {
    const plan = planEnableHere(copilot!, {
      providers: {},
      providerInstances: { acpRegistry_github_copilot_cli: { driver: "codex" } },
    } as unknown as Settings);
    expect(plan.mutation).toEqual({
      operation: "create",
      instanceId: "acpRegistry_github_copilot_cli_2",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "GitHub Copilot",
        config: { agentId: "github-copilot-cli", distribution: "auto" },
      },
    });
  });
});
