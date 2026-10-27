/**
 * One-click provider setup from the model picker.
 *
 * Provider instances are settings of each machine and do not sync, so a chat
 * on one machine can miss a provider that another machine already runs. This
 * module finds those gaps and builds the settings change that closes them.
 *
 * @module providerQuickSetup
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";

import type { ProviderInstanceEntry } from "./providerInstances";

/** Registry agents SpecWithCode can install and update itself. */
export const FEATURED_ACP_AGENT_IDS = ["github-copilot-cli", "grok-build", "gemini"] as const;

const ACP_REGISTRY = ProviderDriverKind.make("acpRegistry");

/**
 * The plain name a featured agent gets on a new machine. Another machine's
 * label can name settings that are not copied, such as "Gemini CLI (Vertex AI)".
 */
const FEATURED_AGENT_NAMES: Readonly<Record<(typeof FEATURED_ACP_AGENT_IDS)[number], string>> = {
  "github-copilot-cli": "GitHub Copilot",
  "grok-build": "Grok",
  gemini: "Gemini CLI",
};

/**
 * Built-in drivers whose CLI SpecWithCode can install from a registry package
 * when the machine does not have it. The package installs the same `grok`
 * command the built-in driver runs.
 */
export const REGISTRY_INSTALLER_BY_DRIVER: Readonly<Record<string, string>> = {
  grok: "grok-build",
};

function featuredAgentId(entry: ProviderInstanceEntry): string | null {
  if (entry.driverKind !== ACP_REGISTRY) return null;
  const agentId = entry.acpRegistryAgentId;
  return FEATURED_ACP_AGENT_IDS.find((id) => id === agentId) ?? null;
}

/** An enabled registry agent that one prepare call would make usable here. */
export function oneClickInstallAgentId(entry: ProviderInstanceEntry): string | null {
  if (!entry.enabled || entry.installed || entry.acpSource === "local") return null;
  return featuredAgentId(entry);
}

/**
 * What counts as "the same provider" on two machines. Custom built-in
 * instances carry machine paths and homes, so only default instances and
 * featured registry agents are offered across machines. A local Copilot
 * command maps to the registry agent, which this machine can install.
 */
export function providerIdentity(entry: ProviderInstanceEntry): string | null {
  if (entry.driverKind === ACP_REGISTRY) {
    const agentId = featuredAgentId(entry);
    return agentId ? `acp:${agentId}` : null;
  }
  return entry.isDefault ? `driver:${entry.driverKind}` : null;
}

export interface MachineProviders {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}

export interface ProviderElsewhere {
  readonly identity: string;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly agentId: string | null;
  /** The ready instance on the other machine, used for its icon. */
  readonly entry: ProviderInstanceEntry;
  readonly machineLabels: ReadonlyArray<string>;
}

/** Providers ready on another machine and not enabled on this one. */
export function providersOnOtherMachines(input: {
  readonly here: ReadonlyArray<ProviderInstanceEntry>;
  readonly others: ReadonlyArray<MachineProviders>;
}): ReadonlyArray<ProviderElsewhere> {
  const enabledHere = new Set(
    input.here.filter((entry) => entry.enabled).flatMap((entry) => providerIdentity(entry) ?? []),
  );
  const found = new Map<string, ProviderElsewhere>();
  for (const machine of input.others) {
    for (const entry of machine.entries) {
      if (!entry.enabled || entry.status !== "ready") continue;
      const identity = providerIdentity(entry);
      if (!identity || enabledHere.has(identity)) continue;
      const existing = found.get(identity);
      if (existing) {
        if (!existing.machineLabels.includes(machine.label))
          found.set(identity, {
            ...existing,
            machineLabels: [...existing.machineLabels, machine.label],
          });
        continue;
      }
      found.set(identity, {
        identity,
        driverKind: entry.driverKind,
        displayName: entry.displayName,
        agentId: featuredAgentId(entry),
        entry,
        machineLabels: [machine.label],
      });
    }
  }
  return [...found.values()];
}

export interface EnableHerePlan {
  readonly instanceId: ProviderInstanceId;
  readonly mutation: ProviderInstanceMutation;
  readonly isDefault: boolean;
  readonly instance: ProviderInstanceConfig;
  /** Registry agent to prepare after the settings change, if any. */
  readonly prepareAgentId: string | null;
}

function registryAgentIdOf(instance: ProviderInstanceConfig): string | null {
  if (instance.driver !== ACP_REGISTRY) return null;
  const config =
    instance.config !== null && typeof instance.config === "object"
      ? (instance.config as Record<string, unknown>)
      : {};
  if (config.source === "local" || typeof config.commandPath === "string") return null;
  return typeof config.agentId === "string" ? config.agentId : null;
}

function availableInstanceId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * The settings change that turns a provider on for this machine. It reuses a
 * disabled instance when one exists, and never copies another machine's
 * paths, environment or credentials.
 */
export function planEnableHere(
  provider: ProviderElsewhere,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): EnableHerePlan {
  const instances = settings.providerInstances;
  if (provider.agentId) {
    const agentId = provider.agentId;
    const reuse = Object.entries(instances).find(
      ([, instance]) => registryAgentIdOf(instance) === agentId,
    );
    if (reuse) {
      const instanceId = ProviderInstanceId.make(reuse[0]);
      const instance = { ...reuse[1], enabled: true };
      return {
        instanceId,
        isDefault: false,
        instance,
        mutation: { operation: "upsert", instanceId, instance },
        prepareAgentId: agentId,
      };
    }
    const instanceId = ProviderInstanceId.make(
      availableInstanceId(
        `acpRegistry_${agentId.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        new Set(Object.keys(instances)),
      ),
    );
    const instance: ProviderInstanceConfig = {
      driver: ACP_REGISTRY,
      enabled: true,
      displayName:
        FEATURED_AGENT_NAMES[agentId as keyof typeof FEATURED_AGENT_NAMES] ?? provider.displayName,
      config: { agentId, distribution: "auto" },
    };
    return {
      instanceId,
      isDefault: false,
      instance,
      mutation: { operation: "create", instanceId, instance },
      prepareAgentId: agentId,
    };
  }
  const instanceId = defaultInstanceIdForDriver(provider.driverKind);
  const explicit = Object.hasOwn(instances, instanceId) ? instances[instanceId] : undefined;
  const legacy = (settings.providers as Record<string, Record<string, unknown> | undefined>)[
    provider.driverKind
  ];
  // The envelope owns the enabled flag; a legacy in-config `enabled: false`
  // would otherwise keep the provider off.
  const { enabled: _legacyEnabled, ...legacyConfig } = legacy ?? {};
  const instance: ProviderInstanceConfig = explicit
    ? { ...explicit, enabled: true }
    : { driver: provider.driverKind, enabled: true, config: legacyConfig };
  return {
    instanceId,
    isDefault: true,
    instance,
    mutation: { operation: "upsert", instanceId, instance },
    prepareAgentId: null,
  };
}

/**
 * The same instance, run from the command a registry package installed on
 * this machine. Only a built-in driver with no binary path of its own gets one.
 */
export function withInstalledBinary(
  instance: ProviderInstanceConfig,
  executablePath: string,
): ProviderInstanceConfig {
  const config =
    instance.config !== null && typeof instance.config === "object"
      ? (instance.config as Record<string, unknown>)
      : {};
  return { ...instance, config: { ...config, binaryPath: executablePath } };
}

/** Where a provider stands after Turn on here, read from this machine's snapshot. */
export type TurnOnOutcome =
  | { readonly kind: "checking" }
  | { readonly kind: "ready" }
  | { readonly kind: "sign-in"; readonly step: string }
  | { readonly kind: "not-installed"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export function turnOnOutcome(
  snapshot: ServerProvider | undefined,
  machineLabel: string,
): TurnOnOutcome {
  if (!snapshot || !snapshot.enabled) return { kind: "checking" };
  const name = snapshot.displayName?.trim() || "This provider";
  if (!snapshot.installed) {
    return {
      kind: "not-installed",
      message: snapshot.message ?? `${name} is not installed on ${machineLabel}.`,
    };
  }
  if (snapshot.auth.status === "unauthenticated") {
    const method = snapshot.auth.label ? `"${snapshot.auth.label}"` : "its sign-in";
    return {
      kind: "sign-in",
      step: `Sign in on ${machineLabel}: open ${name} setup and choose ${method}. Credentials stay on each machine.`,
    };
  }
  if (snapshot.status === "ready" && snapshot.models.length > 0) return { kind: "ready" };
  return {
    kind: "unavailable",
    message: snapshot.message ?? `${name} is not ready on ${machineLabel} yet.`,
  };
}
