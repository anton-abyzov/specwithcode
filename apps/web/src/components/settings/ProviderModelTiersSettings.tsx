import {
  PROVIDER_MODEL_TIERS,
  type ProviderModelTier,
  type ProviderModelTiers,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { tierModelFor } from "@specweave-studio/shared/modelTiers";

import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const TIER_LABELS: Record<ProviderModelTier, string> = { regular: "Regular", frontier: "Frontier" };

/** `modelTiers` with one tier of one provider instance set; the patch replaces the whole object. */
export function setProviderTierModel(
  tiers: ProviderModelTiers,
  instanceId: string,
  tier: ProviderModelTier,
  model: string,
): ProviderModelTiers {
  return { ...tiers, [instanceId]: { ...tiers[instanceId], [tier]: model } };
}

/**
 * `modelTiers` with a provider instance's own choices dropped, so it goes back
 * to its driver's or the built-in ones. The entry stays, empty, so the
 * provider shows no reset of its own; an empty entry adds nothing.
 */
export function resetProviderTierModels(
  tiers: ProviderModelTiers,
  instanceId: string,
): ProviderModelTiers {
  return { ...tiers, [instanceId]: {} };
}

function modelName(provider: ServerProvider, slug: string | undefined): string {
  if (slug === undefined) return "No model";
  return provider.models.find((model) => model.slug === slug)?.name ?? slug;
}

/**
 * Each enabled provider's regular and frontier model. Regular is the
 * everyday model; frontier is the strongest one, used for review at
 * frontier depth and for work flagged hardest.
 */
export function ProviderModelTiersSettings() {
  const { scope, target } = useSettingsScope();
  const clearSettings = useClearScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = (representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS).filter(
    (provider) => provider.enabled && provider.models.length > 0,
  );
  const tiers: ProviderModelTiers = settings.modelTiers ?? {};
  const mixed = useScopedSettingsMixed(["modelTiers"]);

  if (providers.length === 0) {
    return (
      <SettingsRow
        id="provider-model-tiers-none"
        title="Regular and frontier models"
        description="Enable a provider to choose its regular and frontier models."
      />
    );
  }

  return (
    <>
      {providers.map((provider) => {
        const name = provider.displayName ?? provider.instanceId;
        const own = tiers[provider.instanceId];
        const hasOwn = own !== undefined && Object.keys(own).length > 0;
        return (
          <SettingsRow
            key={provider.instanceId}
            serverScoped
            settingKeys={["modelTiers"]}
            mixed={mixed}
            id={`provider-model-tiers-${provider.instanceId}`}
            title={name}
            description="The regular model does everyday work; the frontier model runs when the strongest one is asked for, such as a review at frontier depth."
            resetAction={
              hasOwn ? (
                <SettingResetButton
                  label={`${name} tier models`}
                  onClick={() =>
                    updateSettings({
                      modelTiers: resetProviderTierModels(tiers, provider.instanceId),
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                {PROVIDER_MODEL_TIERS.map((tier) => {
                  const current = tierModelFor(provider, tier, tiers);
                  return (
                    <Select
                      key={tier}
                      value={mixed ? null : (current ?? null)}
                      onValueChange={(value) => {
                        if (typeof value !== "string") return;
                        updateSettings({
                          modelTiers: setProviderTierModel(tiers, provider.instanceId, tier, value),
                        });
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={`${name} ${tier} model`}>
                        <SelectValue>
                          {(value: string | null) =>
                            `${TIER_LABELS[tier]}: ${
                              mixed ? "Mixed" : modelName(provider, value ?? undefined)
                            }`
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        {provider.models.map((model) => (
                          <SelectItem key={model.slug} value={model.slug}>
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  );
                })}
              </div>
            }
          />
        );
      })}
      {Object.values(tiers).some((entry) => Object.keys(entry).length > 0) ? (
        <SettingsRow
          serverScoped
          settingKeys={["modelTiers"]}
          mixed={mixed}
          id="provider-model-tiers-reset"
          title={isProjectScope ? "Inherited tier models" : "Built-in tier models"}
          description={
            isProjectScope
              ? "Drop this project's choices and use the tier models of the machine settings."
              : "Forget every choice above and use the app's own regular and frontier models."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                // A project drops its override; the environment empties its map.
                isProjectScope ? clearSettings(["modelTiers"]) : updateSettings({ modelTiers: {} })
              }
            >
              {isProjectScope ? "Use machine settings" : "Reset to built-in"}
            </Button>
          }
        />
      ) : null}
    </>
  );
}
