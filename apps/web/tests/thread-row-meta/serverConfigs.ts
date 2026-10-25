// The host's provider config, as ModelBadge reads it; synthetic Claude Code and Codex.
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";

export * from "../../src/state/entities";

const base = {
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-23T00:00:00.000Z",
  slashCommands: [],
  skills: [],
} as const;
const providers = [
  {
    ...base,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: {} }],
  },
  {
    ...base,
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    models: [
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isCustom: false, capabilities: {} },
      { slug: "gpt-6-astra", name: "GPT-6-Astra", isCustom: false, capabilities: {} },
    ],
  },
  {
    ...base,
    instanceId: ProviderInstanceId.make("acpRegistry_devin"),
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: "Devin",
    acpRegistryAgentId: "devin",
    models: [
      { slug: "gpt-6-1-sol-medium", name: "GPT-6.1 Sol", isCustom: false, capabilities: {} },
    ],
  },
] as unknown as ServerProvider[];
const configs = new Map([["env-m4", { providers, settings: DEFAULT_UNIFIED_SETTINGS }]]);

export function useServerConfigs() {
  return configs as never;
}
