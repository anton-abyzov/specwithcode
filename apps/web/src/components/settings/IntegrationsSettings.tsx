import { Outlet, useLocation } from "@tanstack/react-router";

import { IntegrationsTabStrip } from "./integrations/IntegrationsTabStrip";
import { integrationsTabForPath } from "./integrations/integrationsTabs";
import { SettingsPageContainer } from "./settingsLayout";

/**
 * Settings > Integrations: what agents may reach on a machine and the tools
 * SpecWithCode embeds rather than owns. The page is four tabs, each a route
 * under this one, so the tab strip and the scope line stay in place while the
 * rows change.
 *
 * @module IntegrationsSettings
 */
export function IntegrationsSettingsPanel() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsPageContainer
      header={<IntegrationsTabStrip current={integrationsTabForPath(pathname)?.id ?? null} />}
    >
      <Outlet />
    </SettingsPageContainer>
  );
}

export {
  browserProfileRemovalAvailable,
  clearBrowserProfileData,
  importFailureReason,
  type ServerProfileData,
} from "./integrations/BrowserProfilesSetting";
export { DeviceIntegrationControls } from "./integrations/DevicesTab";
