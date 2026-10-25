import type {
  EnvironmentId,
  ProjectId,
  ProjectScopedServerSettingKey,
  ServerSettings,
} from "@specweave-studio/contracts";
import { PROJECT_SCOPED_SERVER_SETTING_KEYS } from "@specweave-studio/contracts";
import * as Equal from "effect/Equal";

/** The setting's name and the Settings page that holds its value for every other project. */
export const PROJECT_OVERRIDE_LABELS: Readonly<
  Record<ProjectScopedServerSettingKey, { readonly label: string; readonly page: string }>
> = {
  agentInstructions: { label: "Agent instructions", page: "Agents" },
  claudeWorkflowMode: { label: "Claude workflow mode", page: "Agents" },
  responseStyle: { label: "Response style", page: "Agents" },
  worktreeCleanup: { label: "Worktree cleanup", page: "Storage" },
  defaultModelSelection: { label: "Model for new threads", page: "General" },
  defaultModelProviders: { label: "Providers for the recommended model", page: "General" },
  defaultRuntimeMode: { label: "Permissions for new threads", page: "General" },
  defaultThreadEnvMode: { label: "Workspace for new threads", page: "General" },
  newWorktreesStartFromOrigin: { label: "New worktrees start from origin", page: "General" },
  worktreeSubmodules: { label: "Worktree submodules", page: "General" },
  defaultAutoPull: { label: "Pull before new threads", page: "General" },
  defaultProjectScripts: { label: "Project actions", page: "General" },
  enableAgentBrowserAccess: { label: "Agent browser access", page: "General" },
  agentBrowserProfileId: { label: "Browser profile for agents", page: "General" },
  enableAgentDeviceAccess: { label: "Agent device access", page: "General" },
  textGenerationModelSelection: { label: "Text generation model", page: "General" },
  sourceControlWriterModelSelection: { label: "Writer model", page: "Source Control" },
  sourceControlWritingStyle: { label: "Writing style", page: "Source Control" },
  removeAgentCreditsOnMerge: { label: "Remove agent credits on merge", page: "Source Control" },
  branchNamingMode: { label: "Branch naming", page: "Source Control" },
  branchNamePrefix: { label: "Branch name prefix", page: "Source Control" },
  branchNameInstructions: { label: "Branch name instructions", page: "Source Control" },
  pullRequestMergeMethod: { label: "Merge method", page: "Source Control" },
  threadFinishAction: { label: "When a thread finishes", page: "Source Control" },
  sidebarAutoSettleOnMerge: { label: "Resolve threads on merge", page: "General" },
  sidebarAutoSettleAfterDays: { label: "Resolve idle threads", page: "General" },
  continueThreadsAfterServerUpdate: { label: "Continue after restart", page: "General" },
  responseStreamingMode: { label: "Response streaming", page: "General" },
  providerLimitAction: { label: "When a provider runs out", page: "Providers" },
  providerLimitFallbackModelSelection: { label: "Fallback model", page: "Providers" },
  providerLimitFallbackModels: { label: "Fallback order", page: "Providers" },
  providerLimitExcludedModels: { label: "Excluded fallback models", page: "Providers" },
  providerLimitSwitchAtPercent: { label: "Switch at usage", page: "Providers" },
  providerLimitWaitUnderMinutes: { label: "Wait when reset is under", page: "Providers" },
  providerLimitRedeemResets: { label: "Redeem resets", page: "Providers" },
  autoApproveSubscriptionChange: { label: "Approve subscription changes", page: "Providers" },
  providerLimitSpendCredits: { label: "Spend credits", page: "Providers" },
  providerLimitUseApiCredits: { label: "Use API credits", page: "Providers" },
  providerLimitMachineTargets: { label: "Other machines", page: "Providers" },
  providerLimitTargetOrder: { label: "Try first", page: "Providers" },
  providerLimitUnknownUsageEligible: {
    label: "Use machines with unknown usage",
    page: "Providers",
  },
  taskRouting: { label: "Auto model routing", page: "Providers" },
  modelLanes: { label: "Model lanes", page: "Providers" },
  learnedModelPreferences: { label: "Learned model preferences", page: "Providers" },
};

const VALUE_LABELS: Readonly<Record<string, string>> = {
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Accept edits",
  auto: "Automatic",
  "full-access": "Full access",
  local: "Local",
  worktree: "New worktree",
  ask: "Ask",
  wait: "Wait",
  switch: "Switch",
  "on-request": "On request",
  automatic: "Automatic",
  disabled: "Off",
  concise: "Concise",
  detailed: "Detailed",
  turn: "Per turn",
  paragraph: "Per paragraph",
  "top-level": "Top level",
  recursive: "Recursive",
  none: "None",
  "same-machine-first": "This machine",
  "other-machine-first": "Other machines",
};

/** A short, human-readable value for a settings value of any shape. */
export function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.length === 0) return "Empty";
    const label = VALUE_LABELS[value];
    if (label) return label;
    return value.length > 40 ? `${value.slice(0, 39)}…` : value;
  }
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  if (typeof value === "object" && "model" in value && typeof value.model === "string") {
    return value.model;
  }
  if (typeof value === "object" && "mode" in value && typeof value.mode === "string") {
    return formatSettingValue(value.mode);
  }
  return "Custom";
}

export interface ProjectOverrideRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: ProjectId;
  readonly key: ProjectScopedServerSettingKey;
  readonly label: string;
  readonly page: string;
  readonly value: string;
  readonly appValue: string;
}

interface OverrideEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

/**
 * Every value one project sets for itself on any of its checkouts. Only real
 * overrides are listed; a project that follows the app settings has none.
 */
export function listProjectSettingOverrides(
  checkouts: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[],
  environments: readonly OverrideEnvironment[],
): ProjectOverrideRow[] {
  return checkouts.flatMap((checkout) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === checkout.environmentId,
    );
    const settings = environment?.serverConfig?.settings;
    const entry = settings?.projectSettingsOverrides[checkout.id];
    if (!environment || !settings || !entry) return [];
    return PROJECT_SCOPED_SERVER_SETTING_KEYS.flatMap((key) => {
      if (!Object.hasOwn(entry, key)) return [];
      const value = entry[key];
      const appValue = settings[key];
      return [
        {
          environmentId: checkout.environmentId,
          environmentLabel: environment.label,
          projectId: checkout.id,
          key,
          ...PROJECT_OVERRIDE_LABELS[key],
          value: formatSettingValue(value),
          appValue: Equal.equals(value, appValue) ? "Same" : formatSettingValue(appValue),
        },
      ];
    });
  });
}
