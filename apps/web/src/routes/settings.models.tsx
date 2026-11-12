import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@specweave-studio/contracts";

import { ModelSettingsPanel } from "../components/settings/ModelSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * Model policy is machine state, like Providers: the page shows the chosen
 * environment from the settings scope selector.
 */
function SettingsModelsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its models.`
          : "Connect an environment to set up its models."}
      </p>
    );
  }
  return <ModelSettingsPanel environment={environment} />;
}

export const Route = createFileRoute("/settings/models")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
  }),
  component: SettingsModelsRoute,
});
