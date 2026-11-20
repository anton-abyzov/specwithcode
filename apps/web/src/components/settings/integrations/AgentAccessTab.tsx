import { Link } from "@tanstack/react-router";

import { useTx } from "../../../i18n";
import { Button } from "../../ui/button";
import { ProjectDefaultsSettings } from "../ProjectDefaultsSettings";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { IntegrationsMachineState, IntegrationsTabPanel } from "./IntegrationsTabStrip";

/**
 * Chrome has a page of its own. The row keeps it findable beside the other
 * ways an agent reaches a browser or the screen. Settings navigation keeps the
 * machine, so the Chrome page opens on the one being set up.
 */
function ChromeForAgentsRow() {
  const tx = useTx();
  return (
    <SettingsSection id="agent-chrome" title="Chrome">
      <SettingsRow
        title="Chrome for agents"
        description="Agents use your signed-in Chrome through the SpecWithCode extension. It has its own settings page."
        control={
          <Button size="sm" variant="outline" render={<Link to="/settings/chrome" hash="" />}>
            {tx("Open Chrome settings")}
          </Button>
        }
      />
    </SettingsSection>
  );
}

/** What agents may open on the selected machine: the in-app browser, the screen, Chrome. */
export function AgentAccessTab() {
  return (
    <IntegrationsTabPanel tab="access">
      <IntegrationsMachineState links={<ChromeForAgentsRow />}>
        <ProjectDefaultsSettings category="integrations" />
      </IntegrationsMachineState>
    </IntegrationsTabPanel>
  );
}
