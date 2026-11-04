import {
  DEFAULT_ADVERSARIAL_REVIEW_SETTINGS,
  type AdversarialReviewSettings as AdversarialReviewSettingsValue,
  type AdversarialReviewSettingsPatch,
  type ModelSelection,
  type ProviderModelTier,
} from "@specweave-studio/contracts";
import { describeReviewerOrder } from "@specweave-studio/shared/adversarialReview";
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
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { addFallbackEntry, MAX_FALLBACK_MODELS, ModelOrderList } from "./FallbackOrderList";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  PolicyTooltip,
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

/** The model picker trigger, drawn as an outline button so "Add model" reads as an action. */
const ADD_MODEL_TRIGGER_CLASSNAME = `${SETTINGS_PICKER_TRIGGER_CLASSNAME} h-7 rounded-md border border-input bg-background px-2.5 shadow-xs/5 hover:bg-accent/50 dark:bg-input/32`;

const REVIEWER_ORDER_DETAILS =
  "Right after each model, the same model on other providers (such as GitHub Copilot) is tried. Models from the family that did the work are skipped at review time. Sign-in, usage and exclusions follow the same rules as the fallback order.";

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
  const navigate = useNavigate();
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
  // A stored list may repeat a model (hand edits, older clients); rows and saves use it once.
  const reviewers = review.reviewers.filter(
    (entry, index, all) =>
      all.findIndex(
        (other) => other.instanceId === entry.instanceId && other.model === entry.model,
      ) === index,
  );
  const saveReviewers = (next: ReadonlyArray<ModelSelection>) => save({ reviewers: [...next] });

  const pickerSelection = resolveDefaultProviderModelSelection(providers, reviewers[0] ?? null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    pickerSelection?.instanceId,
    pickerSelection?.model,
  );
  // The order a review walks on this machine now, with each step's state.
  const nowMs = useRelativeTimeTick(60_000);
  const view = describeReviewerOrder({
    providers,
    reviewers,
    tier: review.tier,
    tiers: settings.modelTiers,
    excludedModels: settings.providerLimitExcludedModels,
    nowMs,
  });
  const steps = view.groups.map((group) => ({ ...group.primary, alternates: group.alternates }));
  const tierWord = review.tier === "frontier" ? "frontier" : "regular";
  // Listing a model is consent to use it, so an agent of unknown billing that
  // the default order passes over stays out of the customized order too.
  const customized = view.groups
    .filter((group) => !group.primary.unconsented)
    .map((group) => group.primary.selection)
    .slice(0, MAX_FALLBACK_MODELS);
  const customize = () => saveReviewers(customized);
  // Fallback order: the same page in project settings, else the machine's General settings.
  const openFallbackOrder = () => {
    const row = document.getElementById("provider-limit-fallback");
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    void navigate({
      to: "/settings/general",
      search: target ? { machine: target.environmentId } : {},
      hash: "provider-limit-fallback",
      state: { settingsTargetHighlight: true },
    });
  };
  const openAppWideOrder = () =>
    void navigate({
      to: "/settings/providers",
      search: target ? { environmentId: target.environmentId } : {},
      hash: "adversarial-review-order",
      state: { settingsTargetHighlight: true },
    });
  const linkClassName =
    "font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";

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
        description={
          <span className="inline-flex items-center gap-1">
            Tried top to bottom; the first ready model outside the author&apos;s family reviews.
            <PolicyTooltip>{REVIEWER_ORDER_DETAILS}</PolicyTooltip>
          </span>
        }
        resetAction={
          reviewers.length > 0 ? (
            <SettingResetButton label="reviewer order" onClick={() => saveReviewers([])} />
          ) : null
        }
        control={
          mixed ? (
            <span className="text-sm text-muted-foreground">Mixed</span>
          ) : view.isDefault ? (
            <Button
              size="sm"
              variant="outline"
              aria-label="Customize reviewer order"
              disabled={customized.length === 0}
              onClick={customize}
            >
              Customize
            </Button>
          ) : pickerSelection ? (
            <ProviderModelPicker
              activeInstanceId={pickerSelection.instanceId}
              model={pickerSelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={ADD_MODEL_TRIGGER_CLASSNAME}
              triggerLabel="Add model"
              triggerAriaLabel="Add a reviewer model"
              disabled={reviewers.length >= MAX_FALLBACK_MODELS}
              onInstanceModelChange={(instanceId, model) =>
                saveReviewers(addFallbackEntry(reviewers, instanceId, model))
              }
            />
          ) : (
            <span className="text-sm text-muted-foreground">No providers available</span>
          )
        }
      >
        {mixed ? null : (
          <div
            className="mt-3 mb-2 flex flex-col gap-2"
            data-reviewer-order={view.isDefault ? "default" : "custom"}
          >
            {view.isDefault ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary">Default</Badge>
                Each provider&apos;s {tierWord} model, other families first. Customize to reorder,
                add or remove models.
              </p>
            ) : null}
            {steps.length > 0 ? (
              <ModelOrderList
                label="Reviewer order steps"
                steps={steps}
                providers={providers}
                order={view.isDefault ? undefined : reviewers}
                onChange={view.isDefault ? undefined : saveReviewers}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                No provider on this machine has a {tierWord} model to review with.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {isProjectScope ? (
                <>
                  This project&apos;s order. Projects without one use the{" "}
                  <button type="button" className={linkClassName} onClick={openAppWideOrder}>
                    app-wide reviewer order
                  </button>
                  .{" "}
                </>
              ) : (
                <>App-wide for this machine; a project can set its own in its settings. </>
              )}
              Availability follows the{" "}
              <button type="button" className={linkClassName} onClick={openFallbackOrder}>
                fallback order
              </button>{" "}
              rules.
            </p>
          </div>
        )}
      </SettingsRow>
    </>
  );
}
