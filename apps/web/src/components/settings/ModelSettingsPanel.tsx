import { AuthSettingsWriteScope, type EnvironmentId } from "@specweave-studio/contracts";

import { useEnvironmentScope, useEnvironmentSessionState } from "../../state/session";
import { resolveRemoteOperateAccess } from "./ProviderSettingsPanel.logic";
import { AdversarialReviewSettings } from "./AdversarialReviewSettings";
import { DecisionModelSettings } from "./DecisionModelSettings";
import { ModelLanesSettings } from "./ModelLanesSettings";
import { ProviderModelTiersSettings } from "./ProviderModelTiersSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useNamedEnvironments } from "./useNamedEnvironments";
import type { EnvironmentPresentation } from "../../state/environments";

/**
 * Every model-policy choice for one machine in one place: worker lanes,
 * adversarial review, the decision model and per-provider tier models.
 * Providers (accounts, auth, usage sources) stay on the Providers page.
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
  return (
    <SettingsPageContainer width="wide" className="gap-8">
      <SettingsSection title="Model tiers" reach={{ kind: "machine", name: environmentLabel }}>
        <ModelLanesSettings />
      </SettingsSection>

      <SettingsSection
        id={searchableSetting("adversarial-review").id}
        title="Adversarial review"
        reach={{ kind: "machine", name: environmentLabel }}
      >
        <AdversarialReviewSettings />
      </SettingsSection>

      <SettingsSection title="Decision model" reach={{ kind: "machine", name: environmentLabel }}>
        <DecisionModelSettings
          environmentId={environmentId}
          readOnly={operateDenied || !canWriteSettings}
        />
      </SettingsSection>

      <SettingsSection
        id={searchableSetting("provider-model-tiers").id}
        title="Regular and frontier models"
        reach={{ kind: "machine", name: environmentLabel }}
      >
        <ProviderModelTiersSettings />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
