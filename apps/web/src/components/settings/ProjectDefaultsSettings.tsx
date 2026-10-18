import {
  DEFAULT_SERVER_SETTINGS,
  INCOGNITO_BROWSER_PROFILE_ID,
  type ModelSelection,
  type ProviderInstanceId,
  type WorktreeSubmodules,
} from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderLimitSettings } from "./ProviderLimitSettings";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { THREAD_FINISH_ACTION_LABELS } from "./threadFinishAction";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useBrowserDefaults } from "../../browser/browserDefaults";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
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
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
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
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
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
  // File-backed submodule settings show the effective value. Workspace also
  // exposes Automatic so an inherited Git-aware choice is never shown as an
  // explicit current-checkout preference.
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;
  const workspaceMode =
    target?.sources.defaultThreadEnvMode === "environment"
      ? representative?.serverConfig?.settings.defaultThreadEnvMode
      : target?.settings.defaultThreadEnvMode;

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

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      mixed={mixedModel}
      id="default-model"
      title="Model"
      description={
        isProjectScope
          ? "Model for new threads in this project."
          : "Default model for new threads. Projects can override it."
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
          <SettingResetButton label="default model" onClick={() => setModel(null)} />
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
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
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
          <span className="text-sm text-muted-foreground">No providers available</span>
        )
      }
    />
  );
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title="Workspace"
      description={
        isProjectScope
          ? "Automatic starts Git threads in a new worktree and non-Git folders in the current checkout."
          : "Automatic uses a new worktree for Git projects and the current checkout otherwise. Explicit project and specweave-studio.json choices win."
      }
      resetAction={
        !isProjectScope && settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label="default workspace"
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedWorkspace ? null : (workspaceMode ?? "automatic")}
          onValueChange={(value) => {
            if (value === "automatic" || value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value === "automatic" ? null : value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Default workspace">
            <SelectValue>
              {(value: string | null) =>
                value === "local" || value === "worktree"
                  ? resolveEnvModeLabel(value)
                  : unavailable
                    ? "Unavailable"
                    : value === "automatic"
                      ? "Automatic (Git worktree)"
                      : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="automatic">Automatic (Git worktree)</SelectItem>
            <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
            <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

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
              Open project settings
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
            label="new worktrees start from origin"
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
          aria-label="Start new worktrees from origin by default"
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
          {modelRow}
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            description={
              isProjectScope
                ? "Permissions for all existing and future chats in this project. Active provider turns finish before restarting. App approvals remain separate."
                : "Default permissions for new threads. Projects can override them."
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label="default permissions"
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
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default permissions">
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? "Mixed"
                      : runtimeModeConfig[settings.defaultRuntimeMode].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    return (
                      <SelectItem key={mode} value={mode} className="min-w-64">
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {option.label}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {option.description}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          {workspaceRow}
          <SettingsRow
            serverScoped
            settingKeys={["worktreeSubmodules"]}
            mixed={mixedSubmodules}
            {...searchableSetting("worktree-submodules")}
            description={
              isProjectScope
                ? "How new worktrees in this project populate git submodules."
                : "How new worktrees populate git submodules. Projects and their specweave-studio.json can override it."
            }
            resetAction={
              !isProjectScope && settings.worktreeSubmodules !== null ? (
                <SettingResetButton
                  label="worktree submodules"
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
                <SelectTrigger size="sm" aria-label="Worktree submodules">
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
        </>
      ) : category === "source-control" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title="Refresh upstreams at startup"
            description={
              isProjectScope
                ? "Fetches this project's upstream refs when SpecWithCode starts. Use Pull to update the checkout."
                : "Fetches upstream refs when SpecWithCode starts. Use Pull to update checkouts. Projects can override it."
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label="startup upstream refresh"
                  tooltip="Reset startup upstream refresh to off"
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Refresh upstreams at startup"
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
                  label="agent credit removal"
                  tooltip="Keep agent credits"
                  onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Remove agent credits when merging"
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
                ? "When a thread in its own worktree finishes, with nothing queued, its branch targets this repository's default branch. Merging waits for required checks and branch protection; nothing is force-pushed."
                : "When a thread in its own worktree finishes, with nothing queued, its branch targets the repository's default branch. Merging waits for required checks and branch protection; nothing is force-pushed. New projects start on Open PR and auto-merge."
            }
            control={
              <Select
                value={mixedFinishAction ? null : settings.threadFinishAction}
                onValueChange={(value) => {
                  if (value === "leave" || value === "pull_request" || value === "auto_merge")
                    updateSettings({ threadFinishAction: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="When a thread finishes">
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
                ? "Pull requests in this project start with this method."
                : "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device."
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label="default merge method"
                  tooltip="Reset to last selected"
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
                <SelectTrigger size="sm" aria-label="Default pull request merge method">
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
                  <SelectItem value="last">Last selected</SelectItem>
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
            title="Agent browser access"
            description={
              isProjectScope
                ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts."
                : "Allow agents to use the shared browser. Projects can override it."
            }
            resetAction={
              settings.enableAgentBrowserAccess !==
              DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
                <SettingResetButton
                  label="default browser access"
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
                aria-label="Agent browser access"
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
              title="Agent computer access"
              description="Let agents on this machine, in every project and with every provider, see and control its desktop through the SpecWithCode app, for System Settings and other native apps. macOS asks for Screen Recording and Accessibility the first time. Applies when an agent session next starts."
              resetAction={
                settings.enableAgentComputerAccess !==
                DEFAULT_SERVER_SETTINGS.enableAgentComputerAccess ? (
                  <SettingResetButton
                    label="default computer access"
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
                <Switch
                  aria-label="Agent computer access"
                  mixed={mixedComputer}
                  checked={mixedComputer ? false : settings.enableAgentComputerAccess}
                  onCheckedChange={(enabled) =>
                    updateSettings({ enableAgentComputerAccess: enabled })
                  }
                />
              }
            />
          )}
          {browserProfileSupported ? (
            <SettingsRow
              serverScoped
              settingKeys={["agentBrowserProfileId"]}
              mixed={mixedBrowserProfile}
              id={searchableSetting("agent-browser-profile").id}
              title="Browser profile for agents"
              description={
                isProjectScope
                  ? "The SpecWithCode browser profile this project's agents open pages in, with its saved logins. Isolated tabs keep no logins."
                  : "The SpecWithCode browser profile agents open pages in, with its saved logins. Projects can choose their own."
              }
              resetAction={
                isProjectScope && browserProfileSource === "project" ? (
                  <SettingResetButton
                    label="browser profile"
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
                  <SelectTrigger size="sm" aria-label="Browser profile for agents">
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
                      Isolated, no logins
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
