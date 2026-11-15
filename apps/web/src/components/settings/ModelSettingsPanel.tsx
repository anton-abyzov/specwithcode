import { AuthSettingsWriteScope, type EnvironmentId } from "@specweave-studio/contracts";

import { useEnvironmentScope, useEnvironmentSessionState } from "../../state/session";
import { resolveRemoteOperateAccess } from "./ProviderSettingsPanel.logic";
import { AdversarialReviewSettings } from "./AdversarialReviewSettings";
import { DecisionModelSettings } from "./DecisionModelSettings";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ModelLanesSettings } from "./ModelLanesSettings";
import { ModelTracksSettings } from "./ModelTracksSettings";
import { ProviderLimitSettings } from "./ProviderLimitSettings";
import { ProviderModelTiersSettings } from "./ProviderModelTiersSettings";
import { SettingsGroup } from "./SettingsGroup";
import { searchableSetting } from "./settingsSearch";
import { TaskRoutingSettings } from "./TaskRoutingSettings";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useNamedEnvironments } from "./useNamedEnvironments";
import type { EnvironmentPresentation } from "../../state/environments";

/**
 * Every model choice for one machine on one page: the Daily, Complex and
 * Review tracks with the Sources order, the short "When a limit hits" group,
 * and everything rarer under Advanced. Providers (accounts, auth, usage
 * sources) stay on the Providers page.
 */
export function ModelSettingsPanel(props: { readonly environment: EnvironmentPresentation }) {
  const { environment } = props;
  const environmentId: EnvironmentId = environment.environmentId;
  const { environments } = useNamedEnvironments();
  const environmentLabel = settingsScopeEnvironmentLabel(environment, environments);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  // A remote session without operate access reads these, as it does on Providers.
  const sessionState = useEnvironmentSessionState(environmentId);
  const operateDenied =
    resolveRemoteOperateAccess({
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.hasError,
    }) === "denied";
  // The per-provider grid is derived from the tracks; it shows only for a saved override.
  const hasTierOverride = Object.keys(useScopedSettings().modelTiers ?? {}).length > 0;
  return (
    <SettingsPageContainer width="wide" className="gap-8">
      <SettingsSection
        id="model-tracks"
        title="Models"
        reach={{ kind: "machine", name: environmentLabel }}
        variant="plain"
      >
        <ModelTracksSettings />
      </SettingsSection>

      <SettingsSection
        id="model-limit-policy"
        title="When a limit hits"
        reach={{ kind: "machine", name: environmentLabel }}
      >
        <ProviderLimitSettings part="policy" />
        <ModelLanesSettings part="quota" />
      </SettingsSection>

      <FoldedSettingsSection
        id="model-advanced"
        title="Advanced"
        summary="Custom fallback order, exclusions, other machines, spending, review depth, routing"
      >
        <SettingsGroup>
          <ProviderLimitSettings part="advanced" />
          <div id={searchableSetting("adversarial-review").id}>
            <AdversarialReviewSettings part="depth" />
          </div>
          <TaskRoutingSettings />
          <ModelLanesSettings part="learned" />
          <DecisionModelSettings
            environmentId={environmentId}
            readOnly={operateDenied || !canWriteSettings}
          />
          {hasTierOverride ? (
            <div id={searchableSetting("provider-model-tiers").id}>
              <ProviderModelTiersSettings />
            </div>
          ) : null}
        </SettingsGroup>
      </FoldedSettingsSection>
    </SettingsPageContainer>
  );
}
