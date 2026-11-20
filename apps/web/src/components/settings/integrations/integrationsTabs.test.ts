// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route as IntegrationsIndexRoute } from "../../../routes/settings.integrations.index";
import { settingsBreadcrumbLabel } from "../SettingsBreadcrumb";
import { retainSettingsScope, validateSettingsRouteSearch } from "../settingsScopeNavigation";
import { SETTINGS_SEARCH_ITEMS } from "../settingsSearch";
import {
  INTEGRATIONS_TABS,
  integrationsTabForAnchor,
  integrationsTabForPath,
  isIntegrationsPath,
  type IntegrationsTabId,
} from "./integrationsTabs";

const SETTINGS_DIR = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

/** The files that render each tab's rows. */
const TAB_SOURCES: Readonly<Record<IntegrationsTabId, readonly string[]>> = {
  access: ["integrations/AgentAccessTab.tsx", "ProjectDefaultsSettings.tsx"],
  mcp: ["integrations/McpServersTab.tsx", "ConnectionsLibrarySettings.tsx"],
  devices: ["integrations/DevicesTab.tsx", "DeviceHostsSettings.tsx"],
  preview: [
    "integrations/PreviewRecordingTab.tsx",
    "integrations/BrowserProfilesSetting.tsx",
    "BrowserLinkTargetSetting.tsx",
  ],
};

const sourceOf = (tab: IntegrationsTabId) =>
  TAB_SOURCES[tab]
    .map((file) => NodeFS.readFileSync(NodePath.join(SETTINGS_DIR, file), "utf8"))
    .join("\n");

const shippedRedirect = IntegrationsIndexRoute.options.beforeLoad as unknown as (context: {
  readonly location: { readonly hash: string; readonly search: object };
}) => void;

function createIntegrationsRouter(initialEntry: string) {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const integrations = createRoute({ getParentRoute: () => settings, path: "integrations" });
  const index = createRoute({
    getParentRoute: () => integrations,
    path: "/",
    // The shipped redirect, on a tree small enough to load in a unit test.
    beforeLoad: (context) => shippedRedirect(context),
  });
  const tabs = INTEGRATIONS_TABS.map((tab) =>
    createRoute({ getParentRoute: () => integrations, path: tab.id }),
  );
  return createRouter({
    routeTree: root.addChildren([
      settings.addChildren([integrations.addChildren([index, ...tabs])]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

type TestRouter = ReturnType<typeof createIntegrationsRouter>;

/** The test router records a redirect instead of following it. */
async function follow(router: TestRouter) {
  let followed: unknown = null;
  for (let hops = 0; router.state.redirect && router.state.redirect !== followed; hops += 1) {
    if (hops > 3) throw new Error("redirect loop");
    followed = router.state.redirect;
    await router.navigate(router.state.redirect.options);
  }
}

describe("Integrations tabs", () => {
  it("opens the tab that renders each settings-search result", () => {
    const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.to === "/settings/integrations");
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      const anchor = "targetId" in item ? item.targetId : item.id;
      const tab = integrationsTabForAnchor(`#${anchor}`);
      expect(sourceOf(tab), `${item.id} should be on the ${tab} tab`).toContain(`"${anchor}"`);
    }
  });

  it("sends the old section anchors to their tabs and anything else to the first", () => {
    expect(integrationsTabForAnchor("#mcp-connections")).toBe("mcp");
    expect(integrationsTabForAnchor("#browser-access")).toBe("access");
    expect(integrationsTabForAnchor("#agent-browser-profile")).toBe("access");
    expect(integrationsTabForAnchor("#devices")).toBe("devices");
    expect(integrationsTabForAnchor("#device-hosts")).toBe("devices");
    expect(integrationsTabForAnchor("#browser")).toBe("preview");
    expect(integrationsTabForAnchor("#browser-default-zoom")).toBe("preview");
    expect(integrationsTabForAnchor("")).toBe("access");
    expect(integrationsTabForAnchor("#no-such-row")).toBe("access");
  });

  it("recognises the page and its tabs by path", () => {
    expect(isIntegrationsPath("/settings/integrations")).toBe(true);
    expect(isIntegrationsPath("/settings/integrations/mcp/")).toBe(true);
    expect(isIntegrationsPath("/settings/integrations-old")).toBe(false);
    expect(integrationsTabForPath("/settings/integrations/devices")?.id).toBe("devices");
    expect(integrationsTabForPath("/settings/integrations")).toBeNull();
    for (const tab of INTEGRATIONS_TABS)
      expect(settingsBreadcrumbLabel(tab.path)).toBe("Integrations");
  });

  it("redirects the bare page to the first tab", async () => {
    const router = createIntegrationsRouter("/settings/integrations");
    await router.load();
    await follow(router);
    expect(router.state.location.pathname).toBe("/settings/integrations/access");
  });

  it("redirects an old row link to its tab and keeps the machine and the row", async () => {
    const router = createIntegrationsRouter("/settings/integrations?machine=mini#mcp-connections");
    await router.load();
    await follow(router);
    expect(router.state.location.pathname).toBe("/settings/integrations/mcp");
    expect(router.state.location.search).toEqual({ machine: "mini" });
    expect(router.state.location.hash).toBe("mcp-connections");
  });

  it("moves a settings-search result between tabs without dropping the machine", async () => {
    const router = createIntegrationsRouter("/settings/integrations/mcp?machine=mini");
    await router.load();
    // Settings search still navigates to the page with the row as the hash.
    await router.navigate({
      to: "/settings/integrations",
      hash: "browser-recording-frame-rate",
      replace: true,
    } as never);
    await follow(router);
    expect(router.state.location.pathname).toBe("/settings/integrations/preview");
    expect(router.state.location.search).toEqual({ machine: "mini" });
    expect(router.state.location.hash).toBe("browser-recording-frame-rate");
  });

  it("opens a tab by its own link", async () => {
    for (const tab of INTEGRATIONS_TABS) {
      const router = createIntegrationsRouter(`${tab.path}?machine=mini`);
      await router.load();
      expect(router.state.location.pathname).toBe(tab.path);
      expect(router.state.location.search).toEqual({ machine: "mini" });
    }
  });
});
