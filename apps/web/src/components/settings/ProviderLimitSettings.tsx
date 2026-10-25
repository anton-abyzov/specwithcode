import {
  DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT,
  DEFAULT_PROVIDER_LIMIT_WAIT_UNDER_MINUTES,
  type ModelSelection,
  type ProviderLimitAction,
} from "@specweave-studio/contracts";
import {
  canTakeTurn,
  fallbackModelOrder,
  isDirectClaudeApiKeyProvider,
} from "@specweave-studio/shared/providerFallback";
import { useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { AddApiCreditAccountDialog } from "./AddApiCreditAccountDialog";
import { addFallbackEntry, FallbackOrderList, MAX_FALLBACK_MODELS } from "./FallbackOrderList";
import { MachineFallbackSettings } from "./MachineFallbackSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const ACTION_LABELS: Record<ProviderLimitAction, string> = {
  ask: "Offer the fallback",
  wait: "Wait for the reset",
  switch: "Switch automatically",
};
const SWITCH_AT_OPTIONS = ["off", "50", "60", "70", "75", "80", "85", "90", "95"] as const;
/** The stored threshold is a used share; the label names what is left at that point. */
const switchAtLabel = (value: string) => `At ${100 - Number(value)}% left`;
const WAIT_UNDER_OPTIONS = ["0", "15", "30", "60", "120"] as const;
const waitUnderLabel = (value: string) =>
  value === "0"
    ? "Never wait"
    : value === "60"
      ? "Under 1 hour"
      : value === "120"
        ? "Under 2 hours"
        : `Under ${value} min`;

/**
 * What a thread does when its provider runs out of usage. Every row is
 * project-scoped, so a project can keep Claude and fall back to Codex while
 * another waits for the reset.
 */
export function ProviderLimitSettings() {
  const { scope, target } = useSettingsScope();
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
  const mixedSwitchAt = useScopedSettingsMixed(["providerLimitSwitchAtPercent"]);
  const mixedWaitUnder = useScopedSettingsMixed(["providerLimitWaitUnderMinutes"]);
  const mixedRedeem = useScopedSettingsMixed(["providerLimitRedeemResets"]);
  const mixedSubscriptionChange = useScopedSettingsMixed(["autoApproveSubscriptionChange"]);
  const mixedSpend = useScopedSettingsMixed(["providerLimitSpendCredits"]);
  const mixedApiCredits = useScopedSettingsMixed(["providerLimitUseApiCredits"]);
  // The server takes the first ready one that lists the thread's model.
  const apiKeyInstances = providers.filter(
    (provider) => provider.enabled && isDirectClaudeApiKeyProvider(provider),
  );
  const readyApiKeyInstances = apiKeyInstances.filter(canTakeTurn);
  const apiKeyInstance = readyApiKeyInstances[0];
  const instanceName = (provider: (typeof providers)[number]) =>
    provider.displayName ?? provider.instanceId;
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const switchAt = settings.providerLimitSwitchAtPercent;
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
        title="When a provider runs out"
        description={
          isProjectScope
            ? "What this project's threads do when their provider hits a usage limit. Switching hands the thread over with its context, in the same worktree."
            : "What threads do when their provider hits a usage limit. Projects can override it."
        }
        resetAction={
          settings.providerLimitAction !== "switch" ? (
            <SettingResetButton
              label="usage limit rule"
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
            <SelectTrigger size="sm" aria-label="When a provider runs out">
              <SelectValue>
                {(value: string | null) =>
                  value === "ask" || value === "wait" || value === "switch"
                    ? ACTION_LABELS[value]
                    : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(ACTION_LABELS) as ProviderLimitAction[]).map((action) => (
                <SelectItem key={action} value={action}>
                  {ACTION_LABELS[action]}
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
        title="Fallback order"
        description="The models a limited thread continues on, best first. The first one that is signed in and has room takes the thread; a thread already on one skips it, so Codex threads can fall back to Claude from the same list. After these, SpecWithCode tries any other ready provider."
        status={fallbackOrder.length === 0 && !mixedFallback ? "Any ready provider" : undefined}
        resetAction={
          fallbackOrder.length > 0 ? (
            <SettingResetButton label="fallback order" onClick={() => saveFallbackOrder([])} />
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
              triggerLabel={mixedFallback ? "Mixed" : "Add model"}
              triggerAriaLabel="Add a fallback model"
              disabled={fallbackOrder.length >= MAX_FALLBACK_MODELS}
              onInstanceModelChange={(instanceId, model) =>
                saveFallbackOrder(addFallbackEntry(fallbackOrder, instanceId, model))
              }
            />
          ) : (
            <span className="text-sm text-muted-foreground">No providers available</span>
          )
        }
      >
        <FallbackOrderList
          order={fallbackOrder}
          providers={providers}
          onChange={saveFallbackOrder}
        />
      </SettingsRow>
      <MachineFallbackSettings />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitSwitchAtPercent"]}
        mixed={mixedSwitchAt}
        id="provider-limit-switch-at"
        title="Switch before the limit"
        description="With Switch automatically, the next turn starts on the fallback once the provider's lowest usage window has only this much left. With Offer the fallback, the thread suggests the switch at this point instead. Never mid-turn, and only to a provider with more left."
        resetAction={
          switchAt !== DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT ? (
            <SettingResetButton
              label="switch threshold"
              onClick={() =>
                updateSettings({
                  providerLimitSwitchAtPercent: DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixedSwitchAt ? null : switchAt === null ? "off" : String(switchAt)}
            onValueChange={(value) => {
              if (value === "off") updateSettings({ providerLimitSwitchAtPercent: null });
              else if (value !== null && (SWITCH_AT_OPTIONS as readonly string[]).includes(value))
                updateSettings({ providerLimitSwitchAtPercent: Number(value) });
            }}
          >
            <SelectTrigger size="sm" aria-label="Switch before the limit">
              <SelectValue>
                {(value: string | null) =>
                  value === "off"
                    ? "Only when it stops"
                    : value === null
                      ? "Mixed"
                      : switchAtLabel(value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {SWITCH_AT_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option === "off" ? "Only when it stops" : switchAtLabel(option)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitWaitUnderMinutes"]}
        mixed={mixedWaitUnder}
        id="provider-limit-wait-under"
        title="Wait when the reset is close"
        description="When the usage that reached the limit or the threshold resets within this time, nothing switches, redeems or spends: the thread waits and resumes on the same provider at the reset. A weekly window that is also full keeps the wait from applying."
        resetAction={
          settings.providerLimitWaitUnderMinutes !== DEFAULT_PROVIDER_LIMIT_WAIT_UNDER_MINUTES ? (
            <SettingResetButton
              label="reset wait"
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
            <SelectTrigger size="sm" aria-label="Wait when the reset is close">
              <SelectValue>
                {(value: string | null) => (value === null ? "Mixed" : waitUnderLabel(value))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WAIT_UNDER_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {waitUnderLabel(option)}
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
        title="Continue on a new subscription automatically"
        description="When a thread with auto-continue on is waiting on a limit and its CLI is signed in to another subscription that has room, continue the thread there without asking. Off, or with auto-continue off: the thread shows the change and waits for you to confirm it. The provider and model stay the same."
        resetAction={
          settings.autoApproveSubscriptionChange === false ? (
            <SettingResetButton
              label="subscription change approval"
              tooltip="Continue on a new subscription automatically"
              onClick={() => updateSettings({ autoApproveSubscriptionChange: true })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Continue on a new subscription automatically"
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
        title="Redeem a banked reset first"
        description="When a turn stops on the limit and a fresh usage read confirms the account is at it, use one of the account's banked resets (Claude and Codex grant them) and continue on the same provider before any fallback. At most one per limit window, never while limits are simulated."
        resetAction={
          settings.providerLimitRedeemResets ? (
            <SettingResetButton
              label="banked reset use"
              tooltip="Keep banked resets for manual use"
              onClick={() => updateSettings({ providerLimitRedeemResets: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Redeem a banked reset first"
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
        title="Spend Codex credits first"
        description="When a Codex turn stops on the plan limit and the account holds paid credits, continue that turn on credits before any fallback. SpecWithCode never buys credits or changes automatic reload."
        resetAction={
          settings.providerLimitSpendCredits ? (
            <SettingResetButton
              label="credit spending"
              tooltip="Stop spending credits automatically"
              onClick={() => updateSettings({ providerLimitSpendCredits: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Spend Codex credits first"
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
        title="Use API credits first"
        description="When a Claude subscription turn stops on the limit and a new usage read confirms it, continue that turn on the same model on a Claude instance billed to Anthropic API credits (its own API key or a Claude Console sign-in), before any fallback. With several API accounts, a turn that one refuses for lack of credits moves on to the next. The thread goes back to the subscription when the limit resets, or as soon as this is turned off. Never while limits are simulated. Without this, the limit banner still offers each account as a button."
        status={
          mixedApiCredits
            ? undefined
            : apiKeyInstance
              ? readyApiKeyInstances.length > 1
                ? `Continues on ${instanceName(apiKeyInstance)}, then the next of ${readyApiKeyInstances.length} API accounts`
                : `Continues on ${instanceName(apiKeyInstance)} when it lists the thread's model`
              : apiKeyInstances[0]
                ? `${instanceName(apiKeyInstances[0])} is not ready, so nothing moves`
                : "Needs a Claude API account: add one with its key"
        }
        resetAction={
          settings.providerLimitUseApiCredits ? (
            <SettingResetButton
              label="API credit use"
              tooltip="Stop using API credits automatically"
              onClick={() => updateSettings({ providerLimitUseApiCredits: false })}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            {target ? (
              <Button size="xs" variant="ghost" onClick={() => setAddingApiAccount(true)}>
                {apiKeyInstances.length === 0 ? "Add an API key" : "Add another"}
              </Button>
            ) : null}
            <Switch
              aria-label="Use API credits first"
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
            <AlertDialogTitle>Redeem banked resets automatically?</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? "Turns in this project that stop on a confirmed usage limit will redeem one of the account's banked resets without asking, at most one per limit window. A redeemed reset is gone."
                : "Turns that stop on a confirmed usage limit will redeem one of the account's banked resets without asking, at most one per limit window, in every project that does not override this. A redeemed reset is gone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                updateSettings({ providerLimitRedeemResets: true });
                setConfirmingRedeem(false);
              }}
            >
              Redeem resets
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmingSpend} onOpenChange={setConfirmingSpend}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Spend paid Codex credits automatically?</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? "Turns in this project that stop on the Codex plan limit will continue on the account's paid credits without asking. Credits cost money and are not refunded."
                : "Turns that stop on the Codex plan limit will continue on the account's paid credits without asking, in every project that does not override this. Credits cost money and are not refunded."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                updateSettings({ providerLimitSpendCredits: true });
                setConfirmingSpend(false);
              }}
            >
              Spend credits
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmingApiCredits} onOpenChange={setConfirmingApiCredits}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use Claude API credits automatically?</AlertDialogTitle>
            <AlertDialogDescription>
              {isProjectScope
                ? "Turns in this project that stop on a confirmed Claude subscription limit will continue on your Claude API-key instance without asking, moving on to your next API account if one runs out of credits, and the thread stays there until the limit resets. Every turn it runs there, and any thread it starts from there, is billed to the key's API organization at API rates. SpecWithCode cannot read or cap that balance; set a spend limit in the Claude Console."
                : "Turns that stop on a confirmed Claude subscription limit will continue on your Claude API-key instance without asking, moving on to your next API account if one runs out of credits, in every project that does not override this, and the thread stays there until the limit resets. Every turn it runs there, and any thread it starts from there, is billed to the key's API organization at API rates. SpecWithCode cannot read or cap that balance; set a spend limit in the Claude Console."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                updateSettings({ providerLimitUseApiCredits: true });
                setConfirmingApiCredits(false);
              }}
            >
              Use API credits
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
