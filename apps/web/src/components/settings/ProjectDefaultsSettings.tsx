import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import {
  DEFAULT_SERVER_SETTINGS,
  INCOGNITO_BROWSER_PROFILE_ID,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type WorktreeSubmodules,
} from "@specweave-studio/contracts";
import { createModelSelection, resolveSelectableModel } from "@specweave-studio/shared/model";
import {
  carryModelOptions,
  heldModelOptions,
  describeCarriedOptions,
  joinLabels,
  missingCommonOptions,
} from "@specweave-studio/shared/modelOptionCarry";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useNamedEnvironments } from "./useNamedEnvironments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderLimitSettings } from "./ProviderLimitSettings";
import { ModelLanesSettings } from "./ModelLanesSettings";
import { TaskRoutingSettings } from "./TaskRoutingSettings";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { THREAD_FINISH_ACTION_LABELS } from "./threadFinishAction";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useBrowserDefaults } from "../../browser/browserDefaults";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { ComputerUsePermissionSetup } from "../computerUse/ComputerUsePermissions";
import { AccessGrantsList } from "./AccessGrantsList";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { projectWorktreesAgreement, projectWorktreesSummary } from "./newProjectWorktrees";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import {
  worktreesCutFromLayout,
  worktreesSettingRecommendation,
} from "../../lib/folderLayoutGuidance";
import { useProjectFolderCheck } from "../../studio/useProjectFolderHealth";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  TeamRulesLabel,
} from "./settingsLayout";
import {
  teamRulesClampMode,
  teamRulesModeAllowed,
  teamRulesSetByLabel,
} from "@specweave-studio/shared/teamRules";
import {
  TEAM_RULES_ABOVE_LIMIT,
  TEAM_RULES_REPOSITORY_LABEL,
  teamRulesFromSummary,
  teamRulesToolLock,
} from "../../teamRules/teamRulesView";
import { useFolderTeamRulesSummary } from "../../teamRules/useFolderTeamRules";
import { TeamRulesInert } from "./TeamRulesLock";
import { useMemo, useRef } from "react";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Rows for the settings a project may override. The same rows edit
 * environment defaults at an environment scope and project overrides at a
 * project or checkout scope; the scoped hooks route the write.
 */
const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

export function ProjectDefaultsSettings({
  category,
  onProjectPage = false,
}: {
  category: ProjectSettingsCategory;
  /** Rendered on the Project page, where a picked project edits every category. */
  onProjectPage?: boolean;
}) {
  const tx = useTx();
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useNamedEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const teamRulesSummary = useFolderTeamRulesSummary(
    target?.environmentId,
    scope.kind === "project" || scope.kind === "checkout" || onProjectPage
      ? target?.projectId
      : null,
  );
  const teamRules = useMemo(() => teamRulesFromSummary(teamRulesSummary), [teamRulesSummary]);
  const computerUseLock = teamRulesToolLock(teamRulesSummary, "computerUse");
  // What a new thread would get: a default from before the rules is lowered at use, never rewritten.
  const effectiveRuntimeMode = teamRulesClampMode(teamRules.state, settings.defaultRuntimeMode);
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = useScopedSettingsMixed(["defaultModelSelection"]);
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);
  const mixedBrowser = useScopedSettingsMixed(["enableAgentBrowserAccess"]);
  const mixedComputer = useScopedSettingsMixed(["enableAgentComputerAccess"]);
  const mixedBrowserProfile = useScopedSettingsMixed(["agentBrowserProfileId"]);
  const browserProfileSource = useScopedSettingSource(["agentBrowserProfileId"]);
  const browserProfiles = useBrowserDefaults().profiles.filter(
    (profile) => profile.id !== INCOGNITO_BROWSER_PROFILE_ID,
  );
  const browserProfileSupported = targets.some((member) => {
    const capabilities = environments.find(
      (environment) => environment.environmentId === member.environmentId,
    )?.serverConfig?.environment?.capabilities;
    return scope.kind === "project" || scope.kind === "checkout"
      ? capabilities?.projectAgentBrowserProfile === true
      : capabilities?.agentBrowserProfile === true;
  });
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedAgentCredits = useScopedSettingsMixed(["removeAgentCreditsOnMerge"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const mixedFinishAction = useScopedSettingsMixed(["threadFinishAction"]);
  const mixedStartFromOrigin = useScopedSettingsMixed(["newWorktreesStartFromOrigin"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  // File-backed submodule settings show the effective value.
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const config = environment?.serverConfig;
      if (!config) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        candidate.settings,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        { ...settings, ...candidate.settings },
        config.providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  }

  const setModel = (value: ModelSelection | null): boolean => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return false;
    }
    updateSettings({ defaultModelSelection: value });
    return true;
  };

  const catalogModel = (instanceId: ProviderInstanceId | undefined, model: string | undefined) => {
    const entry = entries.find((candidate) => candidate.instanceId === instanceId);
    // Aliases and older slugs resolve the way the pickers resolve them.
    const slug = entry ? resolveSelectableModel(entry.driverKind, model, entry.models) : null;
    const listed = entry?.models.find((candidate) => candidate.slug === slug);
    return entry && listed ? { entry, listed } : undefined;
  };
  // Undefined for a custom or not yet listed model: its options are unknown, not missing.
  const descriptorsFor = (
    instanceId: ProviderInstanceId | undefined,
    model: string | undefined,
  ) => {
    const found = catalogModel(instanceId, model);
    return found && model
      ? getProviderModelCapabilities(
          found.entry.models,
          model,
          found.entry.driverKind,
          settings.planModeEnabled,
        ).optionDescriptors
      : undefined;
  };
  // "Claude Sonnet 5.5", or "Claude Opus 5.5 on GitHub Copilot" when the provider is not its maker's.
  const modelLabel = (instanceId: ProviderInstanceId, model: string) => {
    const found = catalogModel(instanceId, model);
    const name = found?.listed.name || model;
    const provider = found?.entry.displayName;
    return provider && !name.toLowerCase().startsWith(provider.split(" ")[0]!.toLowerCase())
      ? `${name} on ${provider}`
      : name;
  };
  // Options left off on the way through a model without them, until a model can run them again.
  const heldOptions = useRef<ReadonlyArray<ProviderOptionSelection>>([]);
  // A new provider or model keeps the options it can run; the rest are named, not lost.
  const changeModel = (instanceId: ProviderInstanceId, model: string) => {
    // Several machines with different defaults: no one machine's options speak for the rest.
    if (mixedModel) {
      setModel(createModelSelection(instanceId, model));
      return;
    }
    const previousDescriptors = descriptorsFor(selection?.instanceId, selection?.model);
    const current = selection?.options ?? [];
    const previous = [
      ...current,
      ...heldModelOptions(heldOptions.current, current, previousDescriptors),
    ];
    const carried = carryModelOptions({
      previous,
      previousDescriptors,
      nextDescriptors: descriptorsFor(instanceId, model),
    });
    if (!setModel(createModelSelection(instanceId, model, carried.options))) return;
    heldOptions.current = previous;
    const note = describeCarriedOptions(carried, modelLabel(instanceId, model));
    if (note) toastManager.add({ type: "info", title: "Default model options", description: note });
  };
  const selectionDescriptors =
    selection && !mixedModel ? descriptorsFor(selection.instanceId, selection.model) : undefined;
  const missingOptions = selectionDescriptors ? missingCommonOptions(selectionDescriptors) : [];

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      mixed={mixedModel}
      id="default-model"
      title={isProjectScope ? "Thread and worker model" : "Model"}
      description={
        <>
          {isProjectScope
            ? tx(
                "New threads in this project, and every worker started here without a named model. Model lanes and Auto apply only when this is unset; a worker moved off it at a usage limit is marked on its thread.",
              )
            : tx("Default model for new threads. Projects can override it.")}
          {missingOptions.length > 0 && selection ? (
            <span className="block" data-default-model-unsupported>
              {`${modelLabel(selection.instanceId, selection.model)} has no ${joinLabels(missingOptions)}.`}
            </span>
          ) : null}
        </>
      }
      status={
        unavailable || mixedModel || modelSource === "project"
          ? undefined
          : settings.defaultModelSelection === null
            ? "Automatic"
            : undefined
      }
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton label={tx("default model")} onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection && activeEntry ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={changeModel}
            />
            {!mixedModel ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                models={activeEntry.models}
                model={selection.model}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{tx("No providers available")}</span>
        )
      }
    />
  );
  const useWorktreesRow = <UseWorktreesSetting />;
  // Where new threads start is each project's own choice. The environment page
  // holds only what new projects start with, and points at the per-project switch.
  const environmentWorkspaceRow = <NewProjectWorktreesSetting />;

  const sectionTitle =
    category === "general" || category === "project"
      ? "New threads"
      : category === "integrations"
        ? "Browser"
        : "Repositories";
  const sectionId =
    category === "general" || category === "project"
      ? "project-defaults"
      : category === "integrations"
        ? "browser-access"
        : "source-control-defaults";

  // A picked project edits these on its Project page; the category pages keep
  // the defaults every project inherits.
  if (isProjectScope && category !== "project" && !onProjectPage) {
    return (
      <SettingsSection id={sectionId} title={sectionTitle}>
        <SettingsRow
          title="Set on the Project page"
          description={`${sectionTitle} settings for ${
            scope.kind === "project" || scope.kind === "checkout"
              ? scope.group.displayName
              : "this project"
          } are on its Project page, with the rest of its settings.`}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/settings/projects",
                  hash: sectionId,
                  hashScrollIntoView: false,
                  state: { settingsTargetHighlight: true },
                })
              }
            >
              {tx("Open project settings")}
            </Button>
          }
        />
      </SettingsSection>
    );
  }

  const startFromOriginRow = (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description="Creates this project's worktrees from the latest matching branch on origin instead of the local branch."
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            label={tx("new worktrees start from origin")}
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label={tx("Start new worktrees from origin by default")}
          mixed={mixedStartFromOrigin}
          checked={mixedStartFromOrigin ? false : settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
        />
      }
    />
  );

  return (
    <SettingsSection id={sectionId} title={sectionTitle}>
      {category === "general" || category === "project" ? (
        <>
          {isProjectScope
            ? (teamRulesSummary?.sources ?? []).map((source, index) => (
                <SettingsRow
                  key={`${source.source}:${index}`}
                  title={source.source === "repository" ? "Repository rules" : "Zone"}
                  status={<TeamRulesLabel>{teamRulesSetByLabel(source.owner)}</TeamRulesLabel>}
                  description={
                    source.source === "repository"
                      ? `Committed in this repository and applied on top of this machine's rules. ${TEAM_RULES_REPOSITORY_LABEL}`
                      : "Limits for this repository, set in this machine's rules."
                  }
                />
              ))
            : null}
          {modelRow}
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            description={
              isProjectScope
                ? tx(
                    "Permissions for all existing and future chats in this project. Active provider turns finish before restarting. App approvals remain separate.",
                  )
                : tx("Default permissions for new threads. Projects can override them.")
            }
            status={
              teamRules.summary?.ceiling !== undefined ? (
                <TeamRulesLabel>{teamRules.setBy}</TeamRulesLabel>
              ) : undefined
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode &&
              teamRulesModeAllowed(teamRules.state, DEFAULT_SERVER_SETTINGS.defaultRuntimeMode) ? (
                <SettingResetButton
                  label={tx("default permissions")}
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : effectiveRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={tx("Default permissions")}>
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions ? tx("Mixed") : runtimeModeConfig[effectiveRuntimeMode].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    const allowed = teamRulesModeAllowed(teamRules.state, mode);
                    return (
                      <SelectItem key={mode} value={mode} disabled={!allowed} className="min-w-64">
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {option.label}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {allowed ? option.description : TEAM_RULES_ABOVE_LIMIT}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          {isProjectScope ? useWorktreesRow : environmentWorkspaceRow}
          <SettingsRow
            serverScoped
            settingKeys={["worktreeSubmodules"]}
            mixed={mixedSubmodules}
            {...searchableSetting("worktree-submodules")}
            description={
              isProjectScope
                ? tx("How new worktrees in this project populate git submodules.")
                : tx(
                    "How new worktrees populate git submodules. Projects and their specweave-studio.json can override it.",
                  )
            }
            resetAction={
              !isProjectScope && settings.worktreeSubmodules !== null ? (
                <SettingResetButton
                  label={tx("worktree submodules")}
                  onClick={() => updateSettings({ worktreeSubmodules: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedSubmodules ? null : (effective?.worktreeSubmodules ?? null)}
                onValueChange={(value) => {
                  if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={tx("Worktree submodules")}>
                  <SelectValue>
                    {(value: string | null) =>
                      isWorktreeSubmodules(value)
                        ? WORKTREE_SUBMODULES_LABELS[value]
                        : unavailable
                          ? "Unavailable"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {WORKTREE_SUBMODULES_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {WORKTREE_SUBMODULES_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {category === "project" ? startFromOriginRow : null}
          <ProviderLimitSettings />
          <ModelLanesSettings />
          <TaskRoutingSettings />
        </>
      ) : category === "source-control" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title={tx("Refresh upstreams at startup")}
            description={
              isProjectScope
                ? tx(
                    "Fetches this project's upstream refs when SpecWithCode starts. Use Pull to update the checkout.",
                  )
                : tx(
                    "Fetches upstream refs when SpecWithCode starts. Use Pull to update checkouts. Projects can override it.",
                  )
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label={tx("startup upstream refresh")}
                  tooltip={tx("Reset startup upstream refresh to off")}
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={tx("Refresh upstreams at startup")}
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["removeAgentCreditsOnMerge"]}
            mixed={mixedAgentCredits}
            {...searchableSetting("remove-agent-credits-on-merge")}
            description="Remove recognized agent credit lines from GitHub merge and squash messages, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits."
            resetAction={
              settings.removeAgentCreditsOnMerge ? (
                <SettingResetButton
                  label={tx("agent credit removal")}
                  tooltip={tx("Keep agent credits")}
                  onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={tx("Remove agent credits when merging")}
                mixed={mixedAgentCredits}
                checked={mixedAgentCredits ? false : settings.removeAgentCreditsOnMerge}
                onCheckedChange={(enabled) =>
                  updateSettings({ removeAgentCreditsOnMerge: enabled })
                }
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["threadFinishAction"]}
            mixed={mixedFinishAction}
            {...searchableSetting("thread-finish-action")}
            description={
              isProjectScope
                ? tx(
                    "When a thread in its own worktree finishes, with nothing queued, its branch targets this repository's default branch. Merging waits for required checks and branch protection; nothing is force-pushed.",
                  )
                : tx(
                    "When a thread in its own worktree finishes, with nothing queued, its branch targets the repository's default branch. Merging waits for required checks and branch protection; nothing is force-pushed. New projects start on Open PR and auto-merge.",
                  )
            }
            control={
              <Select
                value={mixedFinishAction ? null : settings.threadFinishAction}
                onValueChange={(value) => {
                  if (value === "leave" || value === "pull_request" || value === "auto_merge")
                    updateSettings({ threadFinishAction: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={tx("When a thread finishes")}>
                  <SelectValue>
                    {(value: string | null) =>
                      value === "leave" || value === "pull_request" || value === "auto_merge"
                        ? THREAD_FINISH_ACTION_LABELS[value]
                        : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="leave">{THREAD_FINISH_ACTION_LABELS.leave}</SelectItem>
                  <SelectItem value="pull_request">
                    {THREAD_FINISH_ACTION_LABELS.pull_request}
                  </SelectItem>
                  <SelectItem value="auto_merge">
                    {THREAD_FINISH_ACTION_LABELS.auto_merge}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? tx("Pull requests in this project start with this method.")
                : tx(
                    "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
                  )
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label={tx("default merge method")}
                  tooltip={tx("Reset to last selected")}
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={tx("Default pull request merge method")}>
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                        : value === "last"
                          ? "Last selected"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">{tx("Last selected")}</SelectItem>
                  <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                  <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                  <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["enableAgentBrowserAccess"]}
            mixed={mixedBrowser}
            id={searchableSetting("agent-browser-access").id}
            title={tx("Agent browser access")}
            description={
              isProjectScope
                ? tx(
                    "Allow agents in this project to use the shared browser. Applies when the agent session next starts.",
                  )
                : tx("Allow agents to use the shared browser. Projects can override it.")
            }
            resetAction={
              settings.enableAgentBrowserAccess !==
              DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
                <SettingResetButton
                  label={tx("default browser access")}
                  onClick={() =>
                    updateSettings({
                      enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                aria-label={tx("Agent browser access")}
                mixed={mixedBrowser}
                checked={mixedBrowser ? false : settings.enableAgentBrowserAccess}
                onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
              />
            }
          />
          {/* Computer use belongs to the machine: no project overrides it. */}
          {isProjectScope ? null : (
            <SettingsRow
              serverScoped
              settingKeys={["enableAgentComputerAccess"]}
              mixed={mixedComputer}
              id={searchableSetting("agent-computer-access").id}
              title={tx("Agent computer access")}
              description={
                computerUseLock?.message ??
                tx(
                  "Let agents on this machine, in every project and with every provider, see and control its desktop through the SpecWithCode app, for System Settings and other native apps. Available on macOS only for now; Windows and Linux are not supported yet. macOS needs Screen Recording and Accessibility for SpecWithCode; allow them below. Applies when an agent session next starts.",
                )
              }
              status={
                computerUseLock ? (
                  <TeamRulesLabel>{computerUseLock.setBy}</TeamRulesLabel>
                ) : undefined
              }
              resetAction={
                computerUseLock === null &&
                settings.enableAgentComputerAccess !==
                  DEFAULT_SERVER_SETTINGS.enableAgentComputerAccess ? (
                  <SettingResetButton
                    label={tx("default computer access")}
                    onClick={() =>
                      updateSettings({
                        enableAgentComputerAccess:
                          DEFAULT_SERVER_SETTINGS.enableAgentComputerAccess,
                      })
                    }
                  />
                ) : null
              }
              control={
                <TeamRulesInert lock={computerUseLock}>
                  <Switch
                    aria-label={tx("Agent computer access")}
                    mixed={mixedComputer}
                    checked={
                      mixedComputer || computerUseLock ? false : settings.enableAgentComputerAccess
                    }
                    onCheckedChange={(enabled) =>
                      updateSettings({ enableAgentComputerAccess: enabled })
                    }
                  />
                </TeamRulesInert>
              }
            >
              {settings.enableAgentComputerAccess && !mixedComputer && computerUseLock === null ? (
                <ComputerUsePermissionSetup environmentId={target?.environmentId ?? null} />
              ) : null}
              {target ? <AccessGrantsList kind="app" environmentId={target.environmentId} /> : null}
            </SettingsRow>
          )}
          {browserProfileSupported ? (
            <SettingsRow
              serverScoped
              settingKeys={["agentBrowserProfileId"]}
              mixed={mixedBrowserProfile}
              id={searchableSetting("agent-browser-profile").id}
              title={tx("Browser profile for agents")}
              description={
                isProjectScope
                  ? tx(
                      "The SpecWithCode browser profile this project's agents open pages in, with its saved logins. Isolated tabs keep no logins.",
                    )
                  : tx(
                      "The SpecWithCode browser profile agents open pages in, with its saved logins. Projects can choose their own.",
                    )
              }
              resetAction={
                isProjectScope && browserProfileSource === "project" ? (
                  <SettingResetButton
                    label={tx("browser profile")}
                    onClick={() => updateSettings({ agentBrowserProfileId: null })}
                  />
                ) : null
              }
              control={
                <Select
                  value={
                    mixedBrowserProfile
                      ? ""
                      : (settings.agentBrowserProfileId ?? INCOGNITO_BROWSER_PROFILE_ID)
                  }
                  onValueChange={(value) => {
                    if (typeof value !== "string" || value === "") return;
                    // The environment stores isolation as no profile; a project stores it explicitly.
                    updateSettings({
                      agentBrowserProfileId:
                        value === INCOGNITO_BROWSER_PROFILE_ID && !isProjectScope ? null : value,
                    });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={tx("Browser profile for agents")}>
                    <SelectValue>
                      {(value: string | null) =>
                        mixedBrowserProfile
                          ? "Mixed"
                          : value === INCOGNITO_BROWSER_PROFILE_ID
                            ? "Isolated, no logins"
                            : (browserProfiles.find((profile) => profile.id === value)?.name ??
                              "Removed profile")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={INCOGNITO_BROWSER_PROFILE_ID}>
                      {tx("Isolated, no logins")}
                    </SelectItem>
                    {browserProfiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

/**
 * Use worktrees for new projects: each project created from now on starts with
 * its own switch set this way. It never changes an existing project's switch,
 * and lists the projects that have it on when they differ.
 */
export function NewProjectWorktreesSetting() {
  const tx = useTx();
  const navigate = useNavigate();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["newProjectThreadEnvMode"]);
  const groups = useSettingsProjectGroups();
  const { environments } = useNamedEnvironments();
  const summary = useMemo(
    () => projectWorktreesSummary(groups, environments),
    [environments, groups],
  );
  const agreement = projectWorktreesAgreement(summary);
  const summaryText =
    agreement === "all-off"
      ? tx("Every project has it off.")
      : agreement === "all-on"
        ? tx("Every project has it on.")
        : agreement === "differ"
          ? renderRich(tx("On in {projects}; off in the other {count}."), {
              projects: summary.on.join(", "),
              count: String(summary.total - summary.on.length),
            })
          : null;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newProjectThreadEnvMode"]}
      mixed={mixed}
      id={searchableSetting("new-threads").id}
      title="Use worktrees for new projects"
      description={
        <>
          {tx(
            "Each project has its own Use worktrees switch, on its General tab. This sets the switch for projects added from now on; existing projects keep theirs.",
          )}
          {summaryText ? (
            <span className="mt-1 block text-foreground" data-project-worktrees-summary="">
              {summaryText}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/projects" })}
          >
            {tx("Open Projects")}
          </Button>
          <Switch
            aria-label={tx("Use worktrees for new projects")}
            mixed={mixed}
            checked={mixed ? false : settings.newProjectThreadEnvMode === "worktree"}
            onCheckedChange={(checked) =>
              updateSettings({ newProjectThreadEnvMode: checked ? "worktree" : "local" })
            }
          />
        </div>
      }
    />
  );
}

/**
 * The project's Use worktrees switch. Settings > Projects and the project's
 * own General tab both render this row, over the same project-scoped setting.
 */
export function UseWorktreesSetting({
  onOpenRepositories,
}: {
  /** Opens Environment > Repositories, where the project's repositories are listed. */
  onOpenRepositories?: (() => void) | undefined;
} = {}) {
  const tx = useTx();
  const { scope, target } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  // What the project's folder holds, for the Use worktrees recommendation.
  const folderProject = isProjectScope
    ? (scope.members.find(
        (member) =>
          member.id === target?.projectId && member.environmentId === target.environmentId,
      ) ?? null)
    : null;
  const folderLayout = useProjectFolderCheck(folderProject)?.layout;
  const worktreesRecommendation = folderLayout
    ? worktreesSettingRecommendation(folderLayout)
    : null;
  // A project's switch is its own choice: on gives every new thread, including
  // ones the coordinator starts, its own worktree; off keeps them in the project folder.
  const projectUsesWorktrees =
    target?.sources.defaultThreadEnvMode === "project" &&
    target.settings.defaultThreadEnvMode === "worktree";
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title="Use worktrees"
      description={
        <>
          {tx(
            "Each new thread gets its own branch and worktree, so parallel threads never share a checkout. Off: threads work in the project folder.",
          )}
          {folderLayout ? (
            <span className="mt-1 block" data-worktrees-cut-from="">
              {worktreesCutFromLayout(folderLayout)}{" "}
              {onOpenRepositories ? (
                <button type="button" className="underline" onClick={onOpenRepositories}>
                  Repositories
                </button>
              ) : null}
            </span>
          ) : null}
          {worktreesRecommendation ? (
            <span className="mt-1 block text-foreground" data-workspace-recommendation="">
              {worktreesRecommendation.text}{" "}
              {/* The only prompt when the switch and the folder disagree: no toast, badge or banner. */}
              {!mixedWorkspace && worktreesRecommendation.on !== projectUsesWorktrees ? (
                <button
                  type="button"
                  className="underline"
                  data-use-recommended=""
                  onClick={() =>
                    updateSettings({
                      defaultThreadEnvMode: worktreesRecommendation.on ? "worktree" : "local",
                    })
                  }
                >
                  Use recommended
                </button>
              ) : null}
            </span>
          ) : null}
        </>
      }
      resetAction={
        target?.sources.defaultThreadEnvMode === "project" ? (
          <SettingResetButton
            label={tx("Use worktrees")}
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Switch
          aria-label={tx("Use worktrees")}
          mixed={mixedWorkspace}
          checked={mixedWorkspace ? false : projectUsesWorktrees}
          onCheckedChange={(checked) =>
            updateSettings({ defaultThreadEnvMode: checked ? "worktree" : "local" })
          }
        />
      }
    />
  );
}

/**
 * The project's Use worktrees switch for a host that offers to flip it (the
 * folder Check) or names it (Environment). Must render under the project's
 * settings scope. `on` is null while the selected checkouts disagree.
 */
export function useProjectWorktreesSwitch(): {
  readonly on: boolean | null;
  readonly set: (on: boolean) => void;
} {
  const { target } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  return {
    on: mixed
      ? null
      : target?.sources.defaultThreadEnvMode === "project" &&
        target.settings.defaultThreadEnvMode === "worktree",
    set: (on) => updateSettings({ defaultThreadEnvMode: on ? "worktree" : "local" }),
  };
}

/** Renders `children` with the project's switch; see `useProjectWorktreesSwitch`. */
export function WithProjectWorktreesSwitch({
  children,
}: {
  children: (state: ReturnType<typeof useProjectWorktreesSwitch>) => React.ReactNode;
}) {
  return children(useProjectWorktreesSwitch());
}
