import {
  DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT,
  DEFAULT_PROVIDER_LIMIT_WAIT_UNDER_MINUTES,
  PROVIDER_LIMIT_SWITCH_AT_PERCENT_MAX,
  PROVIDER_LIMIT_SWITCH_AT_PERCENT_MIN,
  type ModelSelection,
  type ProviderLimitAction,
} from "@specweave-studio/contracts";
import {
  canTakeTurn,
  describeFallbackOrder,
  fallbackModelOrder,
  isDirectClaudeApiKeyProvider,
} from "@specweave-studio/shared/providerFallback";
import {
  describeFallbackOptions,
  toggleExcludedModel,
} from "@specweave-studio/shared/fallbackOptions";
import { useId, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { type Translate, useT, useTx } from "../../i18n";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { AddApiCreditAccountDialog } from "./AddApiCreditAccountDialog";
import { FallbackOptionsPanel } from "./FallbackOptionsPanel";
import {
  addFallbackEntry,
  FallbackOrderList,
  MAX_FALLBACK_MODELS,
  type ModelOrderStep,
} from "./FallbackOrderList";
import { MachineFallbackSettings } from "./MachineFallbackSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  useRelativeTimeTick,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Settings describe the order with no thread running, so no instance is "the thread's own". */
const NO_THREAD_INSTANCE = "__fallback-order__" as ModelSelection["instanceId"];

const PROVIDER_LIMIT_ACTIONS: ReadonlyArray<ProviderLimitAction> = ["ask", "wait", "switch"];
const actionLabel = (t: Translate, action: ProviderLimitAction) =>
  action === "ask"
    ? t("limitSettings.action.ask")
    : action === "wait"
      ? t("limitSettings.action.wait")
      : t("limitSettings.action.switch");
const SWITCH_AT_OPTIONS = [
  "off",
  "50",
  "60",
  "70",
  "75",
  "80",
  "85",
  "90",
  "95",
  "98",
  "99",
] as const;
const SWITCH_AT_CUSTOM = "custom";
const isSwitchAtPreset = (value: string) =>
  (SWITCH_AT_OPTIONS as readonly string[]).includes(value);
/** The stored threshold is a used share; everything a person reads or types is the share left. */
const percentLeft = (used: number) => Math.round((100 - used) * 100) / 100;
const SWITCH_AT_LEFT_MIN = percentLeft(PROVIDER_LIMIT_SWITCH_AT_PERCENT_MAX);
const SWITCH_AT_LEFT_MAX = percentLeft(PROVIDER_LIMIT_SWITCH_AT_PERCENT_MIN);
const switchAtLabel = (t: Translate, value: string) =>
  t("limitSettings.switchAtOption", { percent: percentLeft(Number(value)) });
/** A typed threshold: a whole number of percent left, returned as the stored percent used. */
function parseSwitchAtPercentLeft(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const left = Number(trimmed);
  return left >= SWITCH_AT_LEFT_MIN && left <= SWITCH_AT_LEFT_MAX ? 100 - left : null;
}
const WAIT_UNDER_OPTIONS = ["0", "15", "30", "60", "120"] as const;
const waitUnderLabel = (t: Translate, value: string) =>
  value === "0"
    ? t("limitSettings.waitOption.never")
    : value === "60"
      ? t("limitSettings.waitOption.hour")
      : value === "120"
        ? t("limitSettings.waitOption.twoHours")
        : t("limitSettings.waitOption.minutes", { minutes: value });

/**
 * What a thread does when its provider runs out of usage. Every row is
 * project-scoped, so a project can keep Claude and fall back to Codex while
 * another waits for the reset.
 */
export function ProviderLimitSettings() {
  const tx = useTx();
  const t = useT();
  const { scope, search, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const fallbackOrder = fallbackModelOrder(settings);
  // With no order set, the ranked model tiers are where a limited thread continues.
  const tierCount =
    (settings.modelLanes?.complex?.length ?? 0) + (settings.modelLanes?.routine?.length ?? 0);
  const usesTiers = fallbackOrder.length === 0 && tierCount > 0;
  const chainSet = fallbackOrder.length > 0 || tierCount > 0;
  // The list is the setting; its first entry keeps older clients' single fallback in step.
  const saveFallbackOrder = (order: ReadonlyArray<ModelSelection>) =>
    updateSettings({
      providerLimitFallbackModels: [...order],
      providerLimitFallbackModelSelection: order[0] ?? null,
    });
  const pickerSelection = resolveDefaultProviderModelSelection(providers, fallbackOrder[0] ?? null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    pickerSelection?.instanceId,
    pickerSelection?.model,
  );
  const mixedAction = useScopedSettingsMixed(["providerLimitAction"]);
  const mixedFallback = useScopedSettingsMixed([
    "providerLimitFallbackModels",
    "providerLimitFallbackModelSelection",
  ]);
  const mixedListOnly = useScopedSettingsMixed(["providerLimitFallbackListOnly"]);
  const mixedSwitchAt = useScopedSettingsMixed(["providerLimitSwitchAtPercent"]);
  const mixedExcluded = useScopedSettingsMixed(["providerLimitExcludedModels"]);
  const excludedModels = settings.providerLimitExcludedModels;
  const nowMs = useRelativeTimeTick(60_000);
  const fallbackOptions = describeFallbackOptions({
    providers,
    rule: settings,
    nowMs,
    belowPercent: settings.providerLimitSwitchAtPercent ?? 100,
  });
  // Each listed model's state on this machine now, by the rules a limited thread is walked by.
  const fallbackStatuses = new Map<string, Pick<ModelOrderStep, "status" | "resetAt">>(
    describeFallbackOrder({
      providers,
      currentInstanceId: NO_THREAD_INSTANCE,
      rule: {
        providerLimitFallbackModels: fallbackOrder,
        providerLimitFallbackModelSelection: null,
        providerLimitExcludedModels: excludedModels,
      },
      nowMs,
      belowPercent: settings.providerLimitSwitchAtPercent ?? 100,
    }).map((entry) => [
      `${entry.selection.instanceId}:${entry.selection.model}`,
      {
        status:
          entry.unavailable === null || entry.unavailable === "current"
            ? "ready"
            : entry.unavailable,
        resetAt: entry.resetAt,
      },
    ]),
  );
  const mixedWaitUnder = useScopedSettingsMixed(["providerLimitWaitUnderMinutes"]);
  const mixedRedeem = useScopedSettingsMixed(["providerLimitRedeemResets"]);
  const mixedSubscriptionChange = useScopedSettingsMixed(["autoApproveSubscriptionChange"]);
  const mixedSpend = useScopedSettingsMixed(["providerLimitSpendCredits"]);
  const mixedApiCredits = useScopedSettingsMixed(["providerLimitUseApiCredits"]);
  // The server takes the first ready one that lists the thread's model.
  const apiKeyInstances = providers.filter(
    (provider) => provider.enabled && isDirectClaudeApiKeyProvider(provider),
  );
  const readyApiKeyInstances = apiKeyInstances.filter((provider) => canTakeTurn(provider));
  const apiKeyInstance = readyApiKeyInstances[0];
  const instanceName = (provider: (typeof providers)[number]) =>
    provider.displayName ?? provider.instanceId;
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const switchAt = settings.providerLimitSwitchAtPercent;
  // "Custom…" opens the field before anything is typed; a stored value outside the presets keeps it open.
  const [customSwitchAt, setCustomSwitchAt] = useState(false);
  const [switchAtDraft, setSwitchAtDraft] = useState<string | null>(null);
  const [switchAtInvalid, setSwitchAtInvalid] = useState(false);
  // A draft belongs to one scope and one stored value: another scope, or a value saved
  // anywhere (here, another window or a cleared override), starts the field over.
  const switchAtStateKey = `${search.machine ?? ""}|${search.project ?? ""}|${search.checkout ?? ""}|${mixedSwitchAt ? "mixed" : String(switchAt)}`;
  const [switchAtStateFor, setSwitchAtStateFor] = useState(switchAtStateKey);
  if (switchAtStateFor !== switchAtStateKey) {
    setSwitchAtStateFor(switchAtStateKey);
    setCustomSwitchAt(false);
    setSwitchAtDraft(null);
    setSwitchAtInvalid(false);
  }
  const switchAtErrorId = useId();
  const switchAtIsCustom =
    customSwitchAt || (!mixedSwitchAt && switchAt !== null && !isSwitchAtPreset(String(switchAt)));
  const switchAtMode = switchAtIsCustom
    ? SWITCH_AT_CUSTOM
    : mixedSwitchAt
      ? null
      : switchAt === null
        ? "off"
        : String(switchAt);
  const leaveCustomSwitchAt = () => {
    setCustomSwitchAt(false);
    setSwitchAtDraft(null);
    setSwitchAtInvalid(false);
  };
  const commitSwitchAtDraft = () => {
    if (switchAtDraft === null) return;
    const value = parseSwitchAtPercentLeft(switchAtDraft);
    if (value === null) {
      setSwitchAtInvalid(true);
      return;
    }
    setSwitchAtInvalid(false);
    setSwitchAtDraft(null);
    if (value !== switchAt || mixedSwitchAt)
      updateSettings({ providerLimitSwitchAtPercent: value });
  };
  // Spending a banked reset or paid credits is consent a person gives once, in so many words.
  const [confirmingRedeem, setConfirmingRedeem] = useState(false);
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [confirmingApiCredits, setConfirmingApiCredits] = useState(false);
  const [addingApiAccount, setAddingApiAccount] = useState(false);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitAction"]}
        mixed={mixedAction}
        id="provider-limit-action"
        title={t("limitSettings.action.title")}
        description={
          isProjectScope
            ? t("limitSettings.action.descriptionProject")
            : t("limitSettings.action.description")
        }
        resetAction={
          settings.providerLimitAction !== "switch" ? (
            <SettingResetButton
              label={tx("usage limit rule")}
              onClick={() => updateSettings({ providerLimitAction: "switch" })}
            />
          ) : null
        }
        control={
          <Select
            value={mixedAction ? null : settings.providerLimitAction}
            onValueChange={(value) => {
              if (value === "ask" || value === "wait" || value === "switch")
                updateSettings({ providerLimitAction: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={t("limitSettings.action.title")}>
              <SelectValue>
                {(value: string | null) =>
                  value === "ask" || value === "wait" || value === "switch"
                    ? actionLabel(t, value)
                    : t("limitSettings.mixed")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {PROVIDER_LIMIT_ACTIONS.map((action) => (
                <SelectItem key={action} value={action}>
                  {actionLabel(t, action)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitFallbackModels", "providerLimitFallbackModelSelection"]}
        mixed={mixedFallback}
        id="provider-limit-fallback"
        title={t("limitSettings.order.title")}
        description={[
          t("limitSettings.order.description"),
          tierCount > 0 ? t("limitSettings.order.descriptionTiers") : null,
          settings.providerLimitFallbackListOnly && chainSet
            ? t("limitSettings.order.descriptionWaits")
            : t("limitSettings.order.descriptionAny"),
        ]
          .filter((part) => part !== null)
          .join(t("common.sentenceSpace"))}
        status={
          fallbackOrder.length === 0 && !mixedFallback
            ? usesTiers
              ? t("limitSettings.order.statusTiers")
              : t("limitSettings.order.statusAny")
            : undefined
        }
        resetAction={
          fallbackOrder.length > 0 ? (
            <SettingResetButton
              label={tx("fallback order")}
              onClick={() => saveFallbackOrder([])}
            />
          ) : null
        }
        control={
          pickerSelection ? (
            <ProviderModelPicker
              activeInstanceId={pickerSelection.instanceId}
              model={pickerSelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerLabel={
                mixedFallback ? t("limitSettings.mixed") : t("limitSettings.order.addModel")
              }
              triggerAriaLabel={t("limitSettings.order.addAria")}
              disabled={fallbackOrder.length >= MAX_FALLBACK_MODELS}
              onInstanceModelChange={(instanceId, model) =>
                saveFallbackOrder(addFallbackEntry(fallbackOrder, instanceId, model))
              }
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("limitSettings.order.noProviders")}
            </span>
          )
        }
      >
        <FallbackOrderList
          order={fallbackOrder}
          providers={providers}
          onChange={saveFallbackOrder}
          statuses={fallbackStatuses}
        />
      </SettingsRow>
      {chainSet ? (
        <SettingsRow
          serverScoped
          settingKeys={["providerLimitFallbackListOnly"]}
          mixed={mixedListOnly}
          id="provider-limit-fallback-list-only"
          title={t("limitSettings.listOnly.title")}
          description={
            usesTiers
              ? t("limitSettings.listOnly.descriptionTiers")
              : t("limitSettings.listOnly.descriptionOrder")
          }
          resetAction={
            settings.providerLimitFallbackListOnly ? (
              <SettingResetButton
                label={tx("only these models")}
                onClick={() => updateSettings({ providerLimitFallbackListOnly: false })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.providerLimitFallbackListOnly}
              onCheckedChange={(checked) =>
                updateSettings({ providerLimitFallbackListOnly: Boolean(checked) })
              }
              aria-label={t("limitSettings.listOnly.title")}
            />
          }
        />
      ) : null}
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitExcludedModels"]}
        mixed={mixedExcluded}
        id="provider-limit-options"
        title={t("limitSettings.options.title")}
        description={t("limitSettings.options.description")}
        status={
          excludedModels.length === 0 && !mixedExcluded
            ? t("limitSettings.options.none")
            : t("limitSettings.options.count", { count: excludedModels.length })
        }
        resetAction={
          excludedModels.length > 0 ? (
            <SettingResetButton
              label={tx("excluded models")}
              onClick={() => updateSettings({ providerLimitExcludedModels: [] })}
            />
          ) : null
        }
      >
        <FallbackOptionsPanel
          groups={fallbackOptions}
          disabled={mixedExcluded}
          onToggleExcluded={(model, instanceId) =>
            updateSettings({
              providerLimitExcludedModels: [
                ...toggleExcludedModel(excludedModels, model, instanceId),
              ],
            })
          }
        />
      </SettingsRow>
      <MachineFallbackSettings />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitSwitchAtPercent"]}
        mixed={mixedSwitchAt}
        id="provider-limit-switch-at"
        title={t("limitSettings.switchAt.title")}
        description={t("limitSettings.switchAt.description")}
        resetAction={
          mixedSwitchAt || switchAt !== DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT ? (
            <SettingResetButton
              label={tx("switch threshold")}
              onClick={() => {
                leaveCustomSwitchAt();
                updateSettings({
                  providerLimitSwitchAtPercent: DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT,
                });
              }}
            />
          ) : null
        }
        control={
          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Select
                value={switchAtMode}
                onValueChange={(value) => {
                  if (value === SWITCH_AT_CUSTOM) {
                    setCustomSwitchAt(true);
                    setSwitchAtInvalid(false);
                  } else if (value === "off") {
                    leaveCustomSwitchAt();
                    updateSettings({ providerLimitSwitchAtPercent: null });
                  } else if (value !== null && isSwitchAtPreset(value)) {
                    leaveCustomSwitchAt();
                    updateSettings({ providerLimitSwitchAtPercent: Number(value) });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={t("limitSettings.switchAt.title")}>
                  <SelectValue>
                    {(value: string | null) =>
                      value === "off"
                        ? t("limitSettings.switchAt.off")
                        : value === null
                          ? t("limitSettings.mixed")
                          : value === SWITCH_AT_CUSTOM
                            ? switchAt === null || mixedSwitchAt
                              ? t("limitSettings.switchAt.custom")
                              : switchAtLabel(t, String(switchAt))
                            : switchAtLabel(t, value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SWITCH_AT_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === "off"
                        ? t("limitSettings.switchAt.off")
                        : option === String(DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT)
                          ? t("limitSettings.switchAtOptionDefault", {
                              percent: percentLeft(Number(option)),
                            })
                          : switchAtLabel(t, option)}
                    </SelectItem>
                  ))}
                  <SelectItem value={SWITCH_AT_CUSTOM}>
                    {t("limitSettings.switchAt.custom")}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {switchAtMode === SWITCH_AT_CUSTOM ? (
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Input
                    size="sm"
                    className="w-16"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label={t("limitSettings.switchAt.customLabel")}
                    aria-invalid={switchAtInvalid || undefined}
                    aria-describedby={switchAtInvalid ? switchAtErrorId : undefined}
                    placeholder={String(percentLeft(DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT))}
                    value={
                      switchAtDraft ??
                      (switchAt === null || mixedSwitchAt ? "" : String(percentLeft(switchAt)))
                    }
                    onChange={(event) => {
                      setSwitchAtDraft(event.currentTarget.value);
                      setSwitchAtInvalid(false);
                    }}
                    onBlur={commitSwitchAtDraft}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitSwitchAtDraft();
                      }
                    }}
                  />
                  {t("limitSettings.switchAt.customUnit")}
                </label>
              ) : null}
            </div>
            {switchAtInvalid ? (
              <p id={switchAtErrorId} role="alert" className="text-xs text-destructive-foreground">
                {t("limitSettings.switchAt.customError", {
                  min: SWITCH_AT_LEFT_MIN,
                  max: SWITCH_AT_LEFT_MAX,
                })}
              </p>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitWaitUnderMinutes"]}
        mixed={mixedWaitUnder}
        id="provider-limit-wait-under"
        title={t("limitSettings.waitUnder.title")}
        description={t("limitSettings.waitUnder.description")}
        resetAction={
          settings.providerLimitWaitUnderMinutes !== DEFAULT_PROVIDER_LIMIT_WAIT_UNDER_MINUTES ? (
            <SettingResetButton
              label={tx("reset wait")}
              onClick={() =>
                updateSettings({
                  providerLimitWaitUnderMinutes: DEFAULT_PROVIDER_LIMIT_WAIT_UNDER_MINUTES,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixedWaitUnder ? null : String(settings.providerLimitWaitUnderMinutes)}
            onValueChange={(value) => {
              if (value !== null && (WAIT_UNDER_OPTIONS as readonly string[]).includes(value))
                updateSettings({ providerLimitWaitUnderMinutes: Number(value) });
            }}
          >
            <SelectTrigger size="sm" aria-label={t("limitSettings.waitUnder.title")}>
              <SelectValue>
                {(value: string | null) =>
                  value === null ? t("limitSettings.mixed") : waitUnderLabel(t, value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WAIT_UNDER_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {waitUnderLabel(t, option)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["autoApproveSubscriptionChange"]}
        mixed={mixedSubscriptionChange}
        id="provider-limit-auto-approve-subscription-change"
        title={t("limitSettings.subscription.title")}
        description={t("limitSettings.subscription.description")}
        resetAction={
          settings.autoApproveSubscriptionChange === false ? (
            <SettingResetButton
              label={tx("subscription change approval")}
              tooltip={tx("Continue on a new subscription automatically")}
              onClick={() => updateSettings({ autoApproveSubscriptionChange: true })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label={t("limitSettings.subscription.title")}
            mixed={mixedSubscriptionChange}
            checked={
              mixedSubscriptionChange ? false : settings.autoApproveSubscriptionChange !== false
            }
            onCheckedChange={(enabled) =>
              updateSettings({ autoApproveSubscriptionChange: Boolean(enabled) })
            }
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitRedeemResets"]}
        mixed={mixedRedeem}
        id="provider-limit-redeem-resets"
        title={t("limitSettings.redeem.title")}
        description={t("limitSettings.redeem.description")}
        resetAction={
          settings.providerLimitRedeemResets ? (
            <SettingResetButton
              label={tx("banked reset use")}
              tooltip={tx("Keep banked resets for manual use")}
              onClick={() => updateSettings({ providerLimitRedeemResets: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label={t("limitSettings.redeem.title")}
            mixed={mixedRedeem}
            checked={mixedRedeem ? false : settings.providerLimitRedeemResets}
            onCheckedChange={(enabled) => {
              if (enabled) setConfirmingRedeem(true);
              else updateSettings({ providerLimitRedeemResets: false });
            }}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitSpendCredits"]}
        mixed={mixedSpend}
        id="provider-limit-spend-credits"
        title={t("limitSettings.spend.title")}
        description={t("limitSettings.spend.description")}
        resetAction={
          settings.providerLimitSpendCredits ? (
            <SettingResetButton
              label={tx("credit spending")}
              tooltip={tx("Stop spending credits automatically")}
              onClick={() => updateSettings({ providerLimitSpendCredits: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label={t("limitSettings.spend.title")}
            mixed={mixedSpend}
            checked={mixedSpend ? false : settings.providerLimitSpendCredits}
            onCheckedChange={(enabled) => {
              if (enabled) setConfirmingSpend(true);
              else updateSettings({ providerLimitSpendCredits: false });
            }}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitUseApiCredits"]}
        mixed={mixedApiCredits}
        id="provider-limit-use-api-credits"
        title={t("limitSettings.api.title")}
        description={t("limitSettings.api.description")}
        status={
          mixedApiCredits
            ? undefined
            : apiKeyInstance
              ? readyApiKeyInstances.length > 1
                ? t("limitSettings.api.statusNext", {
                    name: instanceName(apiKeyInstance),
                    count: readyApiKeyInstances.length,
                  })
                : t("limitSettings.api.statusOne", { name: instanceName(apiKeyInstance) })
              : apiKeyInstances[0]
                ? t("limitSettings.api.statusNotReady", { name: instanceName(apiKeyInstances[0]) })
                : t("limitSettings.api.statusNeeds")
        }
        resetAction={
          settings.providerLimitUseApiCredits ? (
            <SettingResetButton
              label={tx("API credit use")}
              tooltip={tx("Stop using API credits automatically")}
              onClick={() => updateSettings({ providerLimitUseApiCredits: false })}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            {target ? (
              <Button size="xs" variant="ghost" onClick={() => setAddingApiAccount(true)}>
                {apiKeyInstances.length === 0
                  ? t("limitSettings.api.addKey")
                  : t("limitSettings.api.addAnother")}
              </Button>
            ) : null}
            <Switch
              aria-label={t("limitSettings.api.title")}
              mixed={mixedApiCredits}
              checked={mixedApiCredits ? false : settings.providerLimitUseApiCredits}
              onCheckedChange={(enabled) => {
                if (enabled) setConfirmingApiCredits(true);
                else updateSettings({ providerLimitUseApiCredits: false });
              }}
            />
          </div>
        }
      />
      {target ? (
        <AddApiCreditAccountDialog
          open={addingApiAccount}
          onOpenChange={setAddingApiAccount}
          environmentId={target.environmentId}
          driver="claudeAgent"
        />
      ) : null}
      <AlertDialog open={confirmingRedeem} onOpenChange={setConfirmingRedeem}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("limitSettings.redeem.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? t("limitSettings.redeem.confirmProject")
                : t("limitSettings.redeem.confirmGlobal")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("limitSettings.cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                updateSettings({ providerLimitRedeemResets: true });
                setConfirmingRedeem(false);
              }}
            >
              {t("limitSettings.redeem.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmingSpend} onOpenChange={setConfirmingSpend}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("limitSettings.spend.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? t("limitSettings.spend.confirmProject")
                : t("limitSettings.spend.confirmGlobal")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("limitSettings.cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                updateSettings({ providerLimitSpendCredits: true });
                setConfirmingSpend(false);
              }}
            >
              {t("limitSettings.spend.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmingApiCredits} onOpenChange={setConfirmingApiCredits}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("limitSettings.api.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? t("limitSettings.api.confirmProject")
                : t("limitSettings.api.confirmGlobal")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("limitSettings.cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                updateSettings({ providerLimitUseApiCredits: true });
                setConfirmingApiCredits(false);
              }}
            >
              {t("limitSettings.api.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
