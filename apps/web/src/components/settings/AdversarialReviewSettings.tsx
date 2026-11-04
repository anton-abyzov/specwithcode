import {
  DEFAULT_ADVERSARIAL_REVIEW_SETTINGS,
  type AdversarialReviewSettings as AdversarialReviewSettingsValue,
  type AdversarialReviewSettingsPatch,
  type ModelSelection,
  type ProviderModelTier,
} from "@specweave-studio/contracts";
import { defaultReviewerChain } from "@specweave-studio/shared/adversarialReview";

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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  addFallbackEntry,
  fallbackEntryLabel,
  FallbackOrderList,
  MAX_FALLBACK_MODELS,
} from "./FallbackOrderList";
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

export const REVIEW_DEPTH_LABELS: Record<ProviderModelTier, string> = {
  regular: "Regular model",
  frontier: "Frontier model",
};

/**
 * Adversarial review: a different model family reviews finished work. Every
 * row is project-scoped and writes only the field it changes; the reviewer
 * list is replaced whole, so it can be cleared.
 */
export function AdversarialReviewSettings() {
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
  const review: AdversarialReviewSettingsValue =
    settings.adversarialReview ?? DEFAULT_ADVERSARIAL_REVIEW_SETTINGS;
  const mixed = useScopedSettingsMixed(["adversarialReview"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  // Only the changed field: every selected target keeps its other fields.
  const save = (change: AdversarialReviewSettingsPatch) =>
    updateSettings({ adversarialReview: change });
  const saveReviewers = (reviewers: ReadonlyArray<ModelSelection>) =>
    save({ reviewers: [...reviewers] });

  const pickerSelection = resolveDefaultProviderModelSelection(
    providers,
    review.reviewers[0] ?? null,
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    pickerSelection?.instanceId,
    pickerSelection?.model,
  );
  // What an empty list means on this machine, so the default is not a mystery.
  const defaultOrder =
    review.reviewers.length === 0
      ? defaultReviewerChain({ providers, tier: review.tier, tiers: settings.modelTiers })
      : [];

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["adversarialReview"]}
        mixed={mixed}
        id="adversarial-review-auto"
        title="Review finished features automatically"
        description={`When a thread finishes and every task of its increment is done, a model from a different family reviews the work in a new thread. ${
          isProjectScope
            ? "Turn it on for the projects where a second opinion is worth the usage."
            : "Off by default; projects can turn it on."
        }`}
        resetAction={
          review.autoOnFeatureComplete ? (
            <SettingResetButton
              label="automatic review"
              onClick={() => save({ autoOnFeatureComplete: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Review finished features automatically"
            checked={mixed ? false : review.autoOnFeatureComplete}
            onCheckedChange={(checked) => save({ autoOnFeatureComplete: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["adversarialReview"]}
        mixed={mixed}
        id="adversarial-review-depth"
        title="Review depth"
        description="Which of each provider's models reviews while the reviewer order is empty. A frontier model is slower and uses more of the plan; set the models under Regular and frontier models."
        resetAction={
          review.tier !== "regular" ? (
            <SettingResetButton label="review depth" onClick={() => save({ tier: "regular" })} />
          ) : null
        }
        control={
          <Select
            value={mixed ? null : review.tier}
            onValueChange={(value) => {
              if (value === "regular" || value === "frontier") save({ tier: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Review depth">
              <SelectValue>
                {(value: string | null) =>
                  value === "regular" || value === "frontier" ? REVIEW_DEPTH_LABELS[value] : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(REVIEW_DEPTH_LABELS) as ProviderModelTier[]).map((tier) => (
                <SelectItem key={tier} value={tier}>
                  {REVIEW_DEPTH_LABELS[tier]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["adversarialReview"]}
        mixed={mixed}
        id="adversarial-review-order"
        title="Reviewer order"
        description={`The models a review tries, in order. Right after each one, the same model on other providers (such as GitHub Copilot) is tried. Models from the family that did the work are skipped. An empty list uses each provider's ${
          review.tier === "frontier" ? "frontier" : "regular"
        } model, other model families first.`}
        status={
          review.reviewers.length === 0 && !mixed
            ? `Each provider's ${review.tier === "frontier" ? "frontier" : "regular"} model`
            : undefined
        }
        resetAction={
          review.reviewers.length > 0 ? (
            <SettingResetButton label="reviewer order" onClick={() => saveReviewers([])} />
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
              triggerLabel={mixed ? "Mixed" : "Add model"}
              triggerAriaLabel="Add a reviewer model"
              disabled={review.reviewers.length >= MAX_FALLBACK_MODELS}
              onInstanceModelChange={(instanceId, model) =>
                saveReviewers(addFallbackEntry(review.reviewers, instanceId, model))
              }
            />
          ) : (
            <span className="text-sm text-muted-foreground">No providers available</span>
          )
        }
      >
        <FallbackOrderList
          order={review.reviewers}
          providers={providers}
          onChange={saveReviewers}
        />
        {defaultOrder.length > 0 && !mixed ? (
          <p className="text-xs text-muted-foreground">
            On this machine now:{" "}
            {defaultOrder.map((selection) => fallbackEntryLabel(providers, selection)).join(", ")}
          </p>
        ) : null}
      </SettingsRow>
    </>
  );
}
