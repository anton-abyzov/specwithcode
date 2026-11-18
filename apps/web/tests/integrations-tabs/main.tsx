import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { IntegrationsSettingsPanel } from "../../src/components/settings/IntegrationsSettings";
import {
  IntegrationsMachineState,
  IntegrationsTabPanel,
} from "../../src/components/settings/integrations/IntegrationsTabStrip";
import {
  INTEGRATIONS_TABS,
  type IntegrationsTabId,
} from "../../src/components/settings/integrations/integrationsTabs";
import { McpServersTab } from "../../src/components/settings/integrations/McpServersTab";
import { SettingsRow, SettingsSection } from "../../src/components/settings/settingsLayout";
import { Button } from "../../src/components/ui/button";
import { Switch } from "../../src/components/ui/switch";
import { setLocalePreference } from "../../src/i18n/locale";
import { Route as IntegrationsIndexRoute } from "../../src/routes/settings.integrations.index";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
// The theme hook paints the page once at import, before the palette above is
// known; hand the background back to the palette.
for (const element of [document.documentElement, document.body])
  element.style.backgroundColor = "var(--background)";
const locale = params.get("locale");
if (locale) setLocalePreference(locale as never);

/** Stand-in rows: the tab's real rows need a server, the shell around them does not. */
function FixtureRows({ tab }: { tab: Exclude<IntegrationsTabId, "mcp"> }) {
  const [on, setOn] = useState(true);
  const rows = (
    <SettingsSection id={`fixture-${tab}`} title="Fixture rows" literal>
      <SettingsRow
        literal
        title="A setting on this machine"
        description="Stands in for the tab's rows, which need a running server."
        control={
          <Switch aria-label="A setting on this machine" checked={on} onCheckedChange={setOn} />
        }
      />
      <SettingsRow
        literal
        title="An action on this machine"
        control={
          <Button size="sm" variant="outline">
            Change
          </Button>
        }
      />
    </SettingsSection>
  );
  return (
    <IntegrationsTabPanel tab={tab}>
      {tab === "preview" ? rows : <IntegrationsMachineState>{rows}</IntegrationsMachineState>}
    </IntegrationsTabPanel>
  );
}

const root = createRootRoute({ component: Outlet });
const settings = createRoute({ getParentRoute: () => root, path: "settings" });
const integrations = createRoute({
  getParentRoute: () => settings,
  path: "integrations",
  component: IntegrationsSettingsPanel,
});
const index = createRoute({
  getParentRoute: () => integrations,
  path: "/",
  beforeLoad: (context) =>
    (IntegrationsIndexRoute.options.beforeLoad as unknown as (context: unknown) => void)(context),
});
const tabs = INTEGRATIONS_TABS.map((tab) =>
  createRoute({
    getParentRoute: () => integrations,
    path: tab.id,
    component: tab.id === "mcp" ? McpServersTab : () => <FixtureRows tab={tab.id as "access"} />,
  }),
);
const chrome = createRoute({
  getParentRoute: () => settings,
  path: "chrome",
  component: () => <p>Chrome settings</p>,
});
const router = createRouter({
  routeTree: root.addChildren([
    settings.addChildren([integrations.addChildren([index, ...tabs]), chrome]),
  ]),
  history: createMemoryHistory({
    initialEntries: [params.get("open") ?? "/settings/integrations"],
  }),
});
// The verifier reads where the page is; the fixture keeps its own URL for its parameters.
(window as unknown as { fixtureRouter: typeof router }).fixtureRouter = router;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex h-full min-h-0 flex-col">
      <RouterProvider router={router} />
    </div>
  </StrictMode>,
);
