import { useTx } from "../../i18n";
import { ActiveThreadCapSetting } from "./ActiveThreadCapSetting";
import { InactiveThreadArchiveSetting } from "./InactiveThreadArchiveSetting";
import {
  resolveWorktreeLocationMode,
  type StorageCleanupSettings,
  type WorktreeCleanupRules,
} from "@specweave-studio/contracts";
import { resolveWorktreeCleanup } from "@specweave-studio/shared/projectSettings";
import { useRef, useState } from "react";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { AppFolderSizeWarningControl, AppFolderUsage } from "./StorageUsageBreakdown";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function WorktreesDirectoryRow() {
  const tx = useTx();
  const { connectedEnvironments, targets, scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreesDirectory", "worktreeLocationMode"]);
  const edited = useRef(false);
  const mode = resolveWorktreeLocationMode(settings);
  const oneMachine = connectedEnvironments.length === 1;
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const member = projectScope
    ? scope.members?.find((entry) => entry.environmentId === targets[0]?.environmentId)
    : null;
  const repositories = member?.workspaceSettings?.environment.repositories ?? [];
  const configuredPath = repositories.length === 1 ? repositories[0]?.localPath : null;
  // Settings cannot choose a chat's repository. Only disclose a concrete path
  // when the project has exactly one configured, absolute checkout.
  const repositoryRoot =
    configuredPath && /^(?:\/|[A-Za-z]:[\\/])/.test(configuredPath)
      ? configuredPath.replace(/[\\/]$/, "")
      : "<selected Git repository>";
  const resolved =
    mode === "project"
      ? `${repositoryRoot}/.specwithcode/worktrees`
      : mode === "custom"
        ? settings.worktreesDirectory || "Choose an absolute folder on this machine"
        : (connectedEnvironments[0]?.serverConfig?.environment.defaultWorktreesDirectory ??
          "App-managed storage on the selected machine");
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreeLocationMode !== true,
    )
  )
    return null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("storage-worktrees-location")}
        title={tx("Worktree storage")}
        description="Choose where new isolated checkouts are created. Project folder stays unchanged. Existing worktrees stay where they are."
        serverScoped
        settingKeys={["worktreeLocationMode", "worktreesDirectory"]}
        resetAction={
          <SettingResetButton
            label={tx("worktree storage")}
            onClick={() => updateSettings({ worktreeLocationMode: "managed" })}
          />
        }
        control={
          <Select
            value={mixed ? null : mode}
            onValueChange={(value) => {
              if (value === "managed" || value === "project" || (value === "custom" && oneMachine))
                updateSettings({ worktreeLocationMode: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={tx("Worktree storage")}>
              <SelectValue>
                {mixed
                  ? tx("Mixed")
                  : mode === "managed"
                    ? "App-managed"
                    : mode === "project"
                      ? tx("Inside project")
                      : tx("Custom folder")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="managed">{tx("App-managed")}</SelectItem>
              <SelectItem value="project">{tx("Inside project")}</SelectItem>
              <SelectItem value="custom" disabled={!oneMachine}>
                {tx("Custom folder")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {mode === "custom" && !mixed && (
        <SettingsRow
          title="Custom worktree folder"
          description={
            oneMachine
              ? "Absolute folder on the selected machine. Existing worktrees are kept."
              : "Select one machine to edit its custom folder."
          }
          serverScoped
          settingKeys={["worktreesDirectory"]}
          control={
            <Input
              key={`${targets.map((target) => target.environmentId).join(",")}:${settings.worktreesDirectory}`}
              aria-label={tx("Worktree location")}
              autoCapitalize="none"
              spellCheck={false}
              disabled={!oneMachine}
              placeholder="/absolute/worktrees"
              defaultValue={settings.worktreesDirectory}
              onChange={() => {
                edited.current = true;
              }}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (edited.current && value !== settings.worktreesDirectory)
                  updateSettings({ worktreesDirectory: value, worktreeLocationMode: "custom" });
                edited.current = false;
              }}
            />
          }
        />
      )}
      <p className="break-all px-4 pb-3 text-xs text-muted-foreground">
        {mixed
          ? tx("Storage differs across selected machines.")
          : connectedEnvironments.length > 1
            ? tx(
                "Each selected machine uses its own worktree storage. Select one machine to inspect its resolved path.",
              )
            : `New worktrees: ${resolved}`}
      </p>
    </>
  );
}

function RetentionControl({
  label,
  value,
  mixed = false,
  daysMixed = false,
  min = 1,
  enableWith = 8,
  onChange,
}: {
  label: string;
  value: number | null;
  mixed?: boolean;
  daysMixed?: boolean;
  /** The fewest days the setting accepts. */
  min?: number;
  /** Days set when the switch turns the rule on. */
  enableWith?: number;
  onChange: (value: number | null) => void;
}) {
  const tx = useTx();
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {mixed || daysMixed ? (
        <span className="text-xs text-muted-foreground">{tx("Mixed")}</span>
      ) : value !== null ? (
        <NumberField
          value={draft}
          min={min}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(min, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={`${label} in days`}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {tx("days")}
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{tx("Off")}</span>
      )}
      <Switch
        aria-label={label}
        mixed={mixed}
        checked={mixed ? false : value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? enableWith : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const tx = useTx();
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleValues = (key: keyof StorageCleanupSettings) =>
    targets.map(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ],
    );
  // Retention rules are mixed only when some machines have them off; machines
  // that are all on with different day counts keep the switch on.
  const ruleMixed = (key: keyof StorageCleanupSettings) =>
    ruleValues(key).some((value) =>
      typeof settings[key] === "number" || settings[key] === null
        ? (value === null) !== (settings[key] === null)
        : value !== settings[key],
    );
  const daysMixed = (key: keyof StorageCleanupSettings) =>
    !ruleMixed(key) && ruleValues(key).some((value) => value !== settings[key]);
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    ruleMixed(key)
      ? "Mixed across selected machines"
      : daysMixed(key)
        ? "Day counts differ across selected machines"
        : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        {tx("Update the selected machines to configure project worktree cleanup.")}
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        {tx(
          "Update the selected environments to use storage cleanup, or choose a machine that supports it.",
        )}
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-archive" title="Chat history">
        {!isProjectScope && <InactiveThreadArchiveSetting />}
        <ActiveThreadCapSetting />
        {!isProjectScope &&
          connectedEnvironments.every(
            (environment) =>
              environment.serverConfig?.environment.capabilities.threadHistoryRetention === true,
          ) && (
            <>
              <SettingsRow
                title={tx("Purge deleted chats")}
                status={ruleStatus("deletedThreadHistoryAfterDays")}
                mixed={ruleMixed("deletedThreadHistoryAfterDays")}
                description="Permanently remove the messages, steps and attachments of chats deleted this many days ago, to keep the database small. 7 days by default; it cannot be undone."
                serverScoped
                control={
                  <RetentionControl
                    label={tx("Purge deleted chats")}
                    value={settings.deletedThreadHistoryAfterDays}
                    mixed={ruleMixed("deletedThreadHistoryAfterDays")}
                    daysMixed={daysMixed("deletedThreadHistoryAfterDays")}
                    enableWith={7}
                    onChange={(deletedThreadHistoryAfterDays) =>
                      update({ deletedThreadHistoryAfterDays })
                    }
                  />
                }
              />
              <SettingsRow
                title={tx("Compact archived chats")}
                status={ruleStatus("archivedThreadHistoryAfterDays")}
                mixed={ruleMixed("archivedThreadHistoryAfterDays")}
                description="Drop the raw event log of chats archived and untouched this many days. Their messages, steps, titles and pull request links stay readable. 2 days by default."
                serverScoped
                control={
                  <RetentionControl
                    label={tx("Compact archived chats")}
                    value={settings.archivedThreadHistoryAfterDays}
                    mixed={ruleMixed("archivedThreadHistoryAfterDays")}
                    daysMixed={daysMixed("archivedThreadHistoryAfterDays")}
                    enableWith={2}
                    onChange={(archivedThreadHistoryAfterDays) =>
                      update({ archivedThreadHistoryAfterDays })
                    }
                  />
                }
              />
              {connectedEnvironments.every(
                (environment) =>
                  environment.serverConfig?.environment.capabilities.threadHistoryHorizon === true,
              ) && (
                <SettingsRow
                  title={tx("Detailed history")}
                  status={ruleStatus("threadHistoryDays")}
                  mixed={ruleMixed("threadHistoryDays")}
                  description="Keep every chat's raw event log (replay detail) this many days. Older activity folds into the chat itself: messages, steps, titles and pull request links stay readable. Chats linked to another machine or still working are never folded. 7 days by default."
                  serverScoped
                  control={
                    <RetentionControl
                      label={tx("Detailed history")}
                      value={settings.threadHistoryDays}
                      mixed={ruleMixed("threadHistoryDays")}
                      daysMixed={daysMixed("threadHistoryDays")}
                      enableWith={7}
                      onChange={(threadHistoryDays) => update({ threadHistoryDays })}
                    />
                  }
                />
              )}
            </>
          )}
      </SettingsSection>
      <SettingsSection id="storage-worktrees" title={tx("Worktrees")}>
        <WorktreesDirectoryRow />
        {isProjectScope && (
          <SettingsRow
            title="Automatic worktree cleanup"
            description={
              mode === "off"
                ? "Keep this project's worktrees until you delete them manually."
                : mode === "custom"
                  ? "Use these rules for this project."
                  : "Use each machine's worktree cleanup settings."
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <SelectTrigger size="sm" aria-label={tx("Automatic worktree cleanup")}>
                  <SelectValue>
                    {mixedModes
                      ? tx("Mixed")
                      : mode === "inherit"
                        ? tx("Inherit")
                        : mode === "off"
                          ? tx("Off")
                          : tx("Custom")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">{tx("Inherit")}</SelectItem>
                  <SelectItem value="off">{tx("Off")}</SelectItem>
                  <SelectItem value="custom">{tx("Custom")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title={tx("Delete worktrees with deleted threads")}
              status={ruleStatus("worktreeOnDelete")}
              mixed={ruleMixed("worktreeOnDelete")}
              description="Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={tx("Delete worktrees with deleted threads")}
                  mixed={ruleMixed("worktreeOnDelete")}
                  checked={ruleMixed("worktreeOnDelete") ? false : settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title={tx("Delete inactive worktrees")}
              status={ruleStatus("worktreeAfterDays")}
              mixed={ruleMixed("worktreeAfterDays")}
              description="Remove worktrees after their threads have been inactive for this many days. Folders of open threads are always kept. Branches and thread history are kept."
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label={tx("Delete inactive worktrees")}
                  value={settings.worktreeAfterDays}
                  mixed={ruleMixed("worktreeAfterDays")}
                  daysMixed={daysMixed("worktreeAfterDays")}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title={tx("Delete merged worktrees")}
              status={ruleStatus("worktreeOnMerge")}
              mixed={ruleMixed("worktreeOnMerge")}
              description="Remove worktrees whose pull request is merged and whose commits are included in the default branch, or closed without merging with every commit pushed. Also removes clean, pushed worktrees agents made without a thread once their pull request is merged or closed and they have been idle for a day. Folders of open threads are always kept."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={tx("Delete merged worktrees")}
                  mixed={ruleMixed("worktreeOnMerge")}
                  checked={ruleMixed("worktreeOnMerge") ? false : settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title={tx("Delete unchanged worktrees")}
              status={ruleStatus("worktreeUnchanged")}
              mixed={ruleMixed("worktreeUnchanged")}
              description="Remove worktrees with no commits beyond the default branch. Folders of open threads are always kept."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={tx("Delete unchanged worktrees")}
                  mixed={ruleMixed("worktreeUnchanged")}
                  checked={ruleMixed("worktreeUnchanged") ? false : settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
          </>
        )}
      </SettingsSection>

      {!isProjectScope && (
        <SettingsSection id="storage-app-folder" title="App folder">
          <AppFolderUsage />
          <SettingsRow
            title={tx("Warn when the app folder is large")}
            status={ruleStatus("homeSizeWarningGb")}
            mixed={ruleMixed("homeSizeWarningGb")}
            description="Mark the app folder here when it passes this size, or when a part of it grows by 10 GB or more between checks. The size is checked every six hours. A notice appears only when the disk itself runs low."
            serverScoped
            control={
              <AppFolderSizeWarningControl
                value={settings.homeSizeWarningGb}
                mixed={ruleMixed("homeSizeWarningGb") || daysMixed("homeSizeWarningGb")}
                onChange={(homeSizeWarningGb) => update({ homeSizeWarningGb })}
              />
            }
          />
          <SettingsRow
            title={tx("Delete old scratch folders")}
            status={ruleStatus("scratchAfterDays")}
            mixed={ruleMixed("scratchAfterDays")}
            description="Delete folders in the scratch folder that nothing changed in for this many days. Folders a thread, project, agent session, terminal or running process uses are always kept. Deleted folders are not copied anywhere. Off unless you turn it on."
            serverScoped
            control={
              <RetentionControl
                label={tx("Delete old scratch folders")}
                value={settings.scratchAfterDays}
                mixed={ruleMixed("scratchAfterDays")}
                daysMixed={daysMixed("scratchAfterDays")}
                min={7}
                enableWith={14}
                onChange={(scratchAfterDays) => update({ scratchAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}

      {!isProjectScope && (
        <SettingsSection id="storage-artifacts" title="Artifacts and logs">
          <SettingsRow
            title={tx("Delete old browser artifacts")}
            status={ruleStatus("browserArtifactsAfterDays")}
            mixed={ruleMixed("browserArtifactsAfterDays")}
            description="Delete saved browser captures after this many days. Older capture links will no longer open."
            serverScoped
            control={
              <RetentionControl
                label={tx("Delete old browser artifacts")}
                value={settings.browserArtifactsAfterDays}
                mixed={ruleMixed("browserArtifactsAfterDays")}
                daysMixed={daysMixed("browserArtifactsAfterDays")}
                onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
              />
            }
          />
          <SettingsRow
            title={tx("Delete old rotated logs")}
            status={ruleStatus("logsAfterDays")}
            mixed={ruleMixed("logsAfterDays")}
            description="Delete inactive rotated log files after this many days. Current logs are kept."
            serverScoped
            control={
              <RetentionControl
                label={tx("Delete old rotated logs")}
                value={settings.logsAfterDays}
                mixed={ruleMixed("logsAfterDays")}
                daysMixed={daysMixed("logsAfterDays")}
                onChange={(logsAfterDays) => update({ logsAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
