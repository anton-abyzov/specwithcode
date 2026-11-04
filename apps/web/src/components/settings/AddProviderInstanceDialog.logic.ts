export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;
const ACP_REGISTRY_IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Provider", "Identity", "Config"] as const;
export const ACP_REGISTRY_WIZARD_STEPS = ["Provider", "Identity", "Sign in"] as const;
export const LOCAL_ACP_WIZARD_STEPS = ["Provider", "Identity"] as const;

export interface ProviderIdentityDraft {
  readonly label: string;
  readonly accentColor: string;
  readonly instanceIdOverride: string | null;
}

const EMPTY_PROVIDER_IDENTITY_DRAFT: ProviderIdentityDraft = {
  label: "",
  accentColor: "",
  instanceIdOverride: null,
};

export function getProviderIdentityDraft(
  drafts: Readonly<Record<string, ProviderIdentityDraft>>,
  driver: string,
): ProviderIdentityDraft {
  return drafts[driver] ?? EMPTY_PROVIDER_IDENTITY_DRAFT;
}

export function updateProviderIdentityDraft(
  drafts: Readonly<Record<string, ProviderIdentityDraft>>,
  driver: string,
  update: Partial<ProviderIdentityDraft>,
): Record<string, ProviderIdentityDraft> {
  return {
    ...drafts,
    [driver]: { ...getProviderIdentityDraft(drafts, driver), ...update },
  };
}

/**
 * ACP Registry agents that repeat a built-in provider shown in the dialog's
 * provider grid, keyed by registry ID with the built-in label. The registry
 * list hides them so each provider is offered once.
 */
export const BUILT_IN_ACP_REGISTRY_AGENTS: Readonly<Record<string, string>> = {
  "codex-acp": "Codex",
  "claude-acp": "Claude",
  cursor: "Cursor",
  "grok-build": "Grok",
  opencode: "OpenCode",
  "opencode-v2": "OpenCode",
  "antigravity-acp": "Antigravity",
  "pi-acp": "Pi",
};

/** Split registry results into agents to list and built-in providers they repeat. */
export function partitionAcpRegistryResults<T extends { readonly id: string }>(
  agents: ReadonlyArray<T>,
  hiddenIds: ReadonlyArray<string>,
): { readonly listed: ReadonlyArray<T>; readonly builtInMatches: ReadonlyArray<string> } {
  const listed: T[] = [];
  const builtInMatches: string[] = [];
  for (const agent of agents) {
    const builtIn = BUILT_IN_ACP_REGISTRY_AGENTS[agent.id];
    if (builtIn !== undefined) {
      if (!builtInMatches.includes(builtIn)) builtInMatches.push(builtIn);
    } else if (!hiddenIds.includes(agent.id)) {
      listed.push(agent);
    }
  }
  return { listed, builtInMatches };
}

export function deriveAvailableInstanceId(
  derive: (label: string) => string,
  label: string,
  existing: ReadonlySet<string>,
): string {
  const base = derive(label);
  if (!base || !existing.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return candidate;
  }
}

type ConfiguredInstances = Readonly<
  Record<
    string,
    {
      readonly driver: string;
      readonly displayName?: string | undefined;
      readonly config?: unknown;
    }
  >
>;

export function isConfiguredAcpRegistryAgent(
  instances: ConfiguredInstances,
  agentId: string,
): boolean {
  return configuredAcpRegistryAgentIds(instances, agentId).length > 0;
}

/** Instance ids of the registry (not local) instances that run `agentId`. */
export function configuredAcpRegistryAgentIds(
  instances: ConfiguredInstances,
  agentId: string,
): ReadonlyArray<string> {
  return Object.keys(instances).filter((instanceId) => {
    const instance = instances[instanceId]!;
    if (
      instance.driver !== "acpRegistry" ||
      !instance.config ||
      typeof instance.config !== "object"
    ) {
      return false;
    }
    const config = instance.config as Record<string, unknown>;
    return config.source !== "local" && config.agentId === agentId;
  });
}

/** The ACP Registry id of GitHub Copilot, which can run several GitHub accounts. */
export const COPILOT_ACP_AGENT_ID = "github-copilot-cli";

/**
 * Name of one more Copilot account, such as "GitHub Copilot (2)". The number
 * skips names already in use.
 */
export function nextCopilotAccountLabel(instances: ConfiguredInstances): string {
  const usedLabels = new Set(
    Object.values(instances).map((instance) => instance.displayName?.trim() ?? ""),
  );
  for (
    let number = configuredAcpRegistryAgentIds(instances, COPILOT_ACP_AGENT_ID).length + 1;
    ;
    number += 1
  ) {
    const label = `GitHub Copilot (${number})`;
    if (!usedLabels.has(label)) return label;
  }
}

/**
 * The folder where one more Copilot account keeps its sign-in, so it never
 * touches the first account's `~/.copilot`. The server expands `~` on the
 * machine that runs Copilot, which may not be this one.
 */
export function additionalCopilotHome(instanceId: string): string {
  return `~/.copilot-${instanceId}`;
}

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: {
    readonly instanceIdError: string | null;
    readonly identityStep?: number;
    readonly prerequisite?: {
      readonly step: number;
      readonly error: string | null;
    };
  },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const identityStep = validation.identityStep ?? IDENTITY_STEP;
  const prerequisite = validation.prerequisite;

  if (prerequisite?.error && currentStep <= prerequisite.step && targetStep > prerequisite.step) {
    return {
      kind: "blocked",
      step: Math.min(prerequisite.step, lastStep),
      error: prerequisite.error,
    };
  }

  const movesForwardPastIdentity = currentStep <= identityStep && targetStep > identityStep;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(identityStep, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}

export function resolveAcpRegistryWizardNavigation(
  currentStep: number,
  requestedStep: number,
  validation: {
    readonly instanceIdError: string | null;
    readonly selectionError: string | null;
  },
): WizardNavigation {
  return resolveWizardNavigation(currentStep, requestedStep, ACP_REGISTRY_WIZARD_STEPS.length, {
    instanceIdError: validation.instanceIdError,
    identityStep: ACP_REGISTRY_IDENTITY_STEP,
    prerequisite: { step: 0, error: validation.selectionError },
  });
}
