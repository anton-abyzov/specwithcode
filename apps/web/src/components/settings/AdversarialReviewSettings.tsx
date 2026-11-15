import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import {
  DEFAULT_ADVERSARIAL_REVIEW_SETTINGS,
  type AdversarialReviewSettings as AdversarialReviewSettingsValue,
  type AdversarialReviewSettingsPatch,
  type ModelSelection,
  type ProviderModelTier,
} from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironments } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ModelTracksSettings } from "./ModelTracksSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { PolicyTooltip, SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const REVIEW_TRACK = ["review"] as const;

const REVIEWER_ORDER_DETAILS =
  "Each model is tried on its sources in the order its row lists them. Models from the family that did the work are skipped at review time, so Claude never reviews Claude's work. Sign-in, usage and exclusions follow the same rules as the fallback order.";

export const REVIEW_DEPTH_LABELS: Record<ProviderModelTier, string> = {
  regular: "Regular model",
  frontier: "Frontier model",
};

/**
 * Adversarial review: a different model family reviews finished work. Every
 * row is project-scoped and writes only the field it changes; the reviewer
 * list is replaced whole, so it can be cleared.
 */
/** `part="depth"` renders only the review depth row; the Review track owns the rest. */
export function AdversarialReviewSettings({ part }: { readonly part?: "depth" } = {}) {
  const tx = useTx();
  const { scope, target } = useSettingsScope();
  const navigate = useNavigate();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
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

  // A project without its own list shows the machine's: say so rather than "this project's".
  const machineReviewers =
    representative?.serverConfig?.settings?.adversarialReview?.reviewers ?? [];
  const ownProjectOrder =
    isProjectScope &&
    (reviewers.length !== machineReviewers.length ||
      reviewers.some(
        (entry, index) =>
          entry.instanceId !== machineReviewers[index]?.instanceId ||
          entry.model !== machineReviewers[index]?.model,
      ));
  // Fallback order: the same page in project settings, else the machine's General settings.
  const openFallbackOrder = () => {
    const row = document.getElementById("provider-limit-fallback");
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    void navigate({
      to: "/settings/models",
      search: target ? { environmentId: target.environmentId } : {},
      hash: "model-advanced",
      state: { settingsTargetHighlight: true },
    });
  };
  const openAppWideOrder = () =>
    void navigate({
      to: "/settings/models",
      search: target ? { environmentId: target.environmentId } : {},
      hash: "model-track-review",
      state: { settingsTargetHighlight: true },
    });
  const linkClassName =
    "font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";

  return (
    <>
      {part === undefined ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["adversarialReview"]}
            mixed={mixed}
            id="adversarial-review-auto"
            title={tx("Review finished features automatically")}
            description={tx(
              isProjectScope
                ? "When a thread finishes and every task of its increment is done, a model from a different family reviews the work in a new thread. Turn it on for the projects where a second opinion is worth the usage."
                : "When a thread finishes and every task of its increment is done, a model from a different family reviews the work in a new thread. Off by default; projects can turn it on.",
            )}
            resetAction={
              review.autoOnFeatureComplete ? (
                <SettingResetButton
                  label={tx("automatic review")}
                  onClick={() => save({ autoOnFeatureComplete: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={tx("Review finished features automatically")}
                checked={mixed ? false : review.autoOnFeatureComplete}
                onCheckedChange={(checked) => save({ autoOnFeatureComplete: Boolean(checked) })}
              />
            }
          />
        </>
      ) : null}
      <SettingsRow
        serverScoped
        settingKeys={["adversarialReview"]}
        mixed={mixed}
        id="adversarial-review-depth"
        title={tx("Review depth")}
        description="Which of each provider's models reviews while the reviewer order is empty. A frontier model is slower and uses more of the plan; set the models under Regular and frontier models."
        resetAction={
          review.tier !== "regular" ? (
            <SettingResetButton
              label={tx("review depth")}
              onClick={() => save({ tier: "regular" })}
            />
          ) : null
        }
        control={
          <Select
            value={mixed ? null : review.tier}
            onValueChange={(value) => {
              if (value === "regular" || value === "frontier") save({ tier: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={tx("Review depth")}>
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
      {part === undefined ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["adversarialReview"]}
            mixed={mixed}
            id="adversarial-review-order"
            title="Reviewer order"
            description={
              <span className="inline-flex items-center gap-1">
                {renderRich(
                  tx(
                    "Tried top to bottom; the first ready model outside the author's family reviews.{policyTooltip}",
                  ),
                  { policyTooltip: <PolicyTooltip>{REVIEWER_ORDER_DETAILS}</PolicyTooltip> },
                )}
              </span>
            }
            resetAction={
              reviewers.length > 0 ? (
                <SettingResetButton
                  label={tx("reviewer order")}
                  onClick={() => saveReviewers([])}
                />
              ) : null
            }
          >
            {mixed ? null : (
              <div className="mt-3 mb-2 flex flex-col gap-2" data-reviewer-order>
                <ModelTracksSettings tracks={REVIEW_TRACK} reviewSwitch={false} />
                <p className="text-xs text-muted-foreground">
                  {renderRich(tx("{value}Availability follows the {button} rules."), {
                    value: isProjectScope ? (
                      ownProjectOrder ? (
                        <>
                          {renderRich(
                            tx("This project's own order; reset it to use the {button}."),
                            {
                              button: (
                                <button
                                  type="button"
                                  className={linkClassName}
                                  onClick={openAppWideOrder}
                                >
                                  {tx("app-wide reviewer order")}
                                </button>
                              ),
                            },
                          )}{" "}
                        </>
                      ) : (
                        <>
                          {renderRich(
                            tx("Uses the {button}; change it here to give this project its own."),
                            {
                              button: (
                                <button
                                  type="button"
                                  className={linkClassName}
                                  onClick={openAppWideOrder}
                                >
                                  {tx("app-wide reviewer order")}
                                </button>
                              ),
                            },
                          )}{" "}
                        </>
                      )
                    ) : (
                      <>
                        {tx(
                          "App-wide for this machine; a project can set its own in its settings.",
                        )}{" "}
                      </>
                    ),
                    button: (
                      <button type="button" className={linkClassName} onClick={openFallbackOrder}>
                        {tx("fallback order")}
                      </button>
                    ),
                  })}
                </p>
              </div>
            )}
          </SettingsRow>
        </>
      ) : null}
    </>
  );
}
