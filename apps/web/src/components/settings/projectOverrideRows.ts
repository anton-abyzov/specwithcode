import type {
  EnvironmentId,
  ProjectId,
  ProjectScopedServerSettingKey,
  ServerSettings,
} from "@specweave-studio/contracts";
import { PROJECT_SCOPED_SERVER_SETTING_KEYS } from "@specweave-studio/contracts";
import * as Equal from "effect/Equal";

import { formatSettingValueFor } from "./settingValueLabels";

/** The setting's name and the Settings page that holds its value for every other project. */
export const PROJECT_OVERRIDE_LABELS: Readonly<
  Record<ProjectScopedServerSettingKey, { readonly label: string; readonly page: string }>
> = {
  agentInstructions: { label: "Agent instructions", page: "Agents" },
  claudeWorkflowMode: { label: "Claude workflow mode", page: "Agents" },
  responseStyle: { label: "Response style", page: "Agents" },
  worktreeCleanup: { label: "Worktree cleanup", page: "Storage" },
  worktreeLocationMode: { label: "Worktree storage", page: "Storage" },
  worktreesDirectory: { label: "Custom worktree folder", page: "Storage" },
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
  providerLimitFallbackListOnly: { label: "Only the fallback order", page: "Providers" },
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
  modelLanes: { label: "Model tiers", page: "Providers" },
  modelTiers: { label: "Regular and frontier models", page: "Providers" },
  adversarialReview: { label: "Adversarial review", page: "Providers" },
  learnedModelPreferences: { label: "Learned model preferences", page: "Providers" },
  keepActiveThreadsPerProject: { label: "Keep active chats per project", page: "Storage" },
};

export interface ProjectOverrideMachine {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: ProjectId;
  /** The stored override, kept raw for undo and edit. */
  readonly rawValue: unknown;
}

/** Machines that share the same project value and the same app value. */
export interface ProjectOverrideLine {
  readonly machines: readonly ProjectOverrideMachine[];
  readonly rawValue: unknown;
  readonly rawAppValue: unknown;
  readonly value: string;
  readonly appValue: string;
  readonly sameAsApp: boolean;
}

/** One setting this project overrides, with its machines grouped by value. */
export interface ProjectOverrideGroup {
  readonly key: ProjectScopedServerSettingKey;
  readonly label: string;
  readonly page: string;
  readonly lines: readonly ProjectOverrideLine[];
}

interface OverrideEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

/** Names list items such as provider instance IDs, per machine. */
export type OverrideValueNamer = (environmentId: EnvironmentId, item: string) => string | undefined;

/**
 * Every value one project sets for itself, one group per setting in the app's
 * key order. Machines with the same project and app values share a line.
 * Only real overrides are listed; a project that follows the app settings has none.
 */
export function groupProjectSettingOverrides(
  checkouts: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[],
  environments: readonly OverrideEnvironment[],
  name?: OverrideValueNamer,
): ProjectOverrideGroup[] {
  const groups: ProjectOverrideGroup[] = [];
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    const lines: Array<ProjectOverrideLine & { machines: ProjectOverrideMachine[] }> = [];
    for (const checkout of checkouts) {
      const environment = environments.find(
        (candidate) => candidate.environmentId === checkout.environmentId,
      );
      const settings = environment?.serverConfig?.settings;
      const entry = settings?.projectSettingsOverrides[checkout.id];
      if (!environment || !settings || !entry || !Object.hasOwn(entry, key)) continue;
      const rawValue: unknown = entry[key];
      const rawAppValue: unknown = settings[key];
      const machine = {
        environmentId: checkout.environmentId,
        environmentLabel: environment.label,
        projectId: checkout.id,
        rawValue,
      };
      const line = lines.find(
        (candidate) =>
          Equal.equals(candidate.rawValue, rawValue) &&
          Equal.equals(candidate.rawAppValue, rawAppValue),
      );
      if (line) {
        line.machines.push(machine);
        continue;
      }
      const namer = name ? (item: string) => name(checkout.environmentId, item) : undefined;
      lines.push({
        machines: [machine],
        rawValue,
        rawAppValue,
        value: formatSettingValueFor(key, rawValue, namer),
        appValue: formatSettingValueFor(key, rawAppValue, namer),
        sameAsApp: Equal.equals(rawValue, rawAppValue),
      });
    }
    if (lines.length > 0) groups.push({ key, ...PROJECT_OVERRIDE_LABELS[key], lines });
  }
  return groups;
}
