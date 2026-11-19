/**
 * The tabs of Settings > Integrations. Each tab is a page of its own under
 * `/settings/integrations/`, so a link can open one, while the sidebar keeps a
 * single "Integrations" entry.
 */
export const INTEGRATIONS_PATH = "/settings/integrations";

export const INTEGRATIONS_TABS = [
  { id: "access", path: "/settings/integrations/access", label: "Agent access" },
  { id: "mcp", path: "/settings/integrations/mcp", label: "MCP servers" },
  { id: "devices", path: "/settings/integrations/devices", label: "Devices" },
  { id: "preview", path: "/settings/integrations/preview", label: "Preview and recording" },
] as const;

export type IntegrationsTab = (typeof INTEGRATIONS_TABS)[number];
export type IntegrationsTabId = IntegrationsTab["id"];
export type IntegrationsTabPath = IntegrationsTab["path"];

/** Tabs whose rows are saved on one machine; the preview tab is saved in this app window. */
export const INTEGRATIONS_MACHINE_TAB_PATHS: ReadonlyArray<IntegrationsTabPath> = [
  "/settings/integrations/access",
  "/settings/integrations/mcp",
  "/settings/integrations/devices",
];

export const INTEGRATIONS_PREVIEW_TAB_PATH: IntegrationsTabPath = "/settings/integrations/preview";

const normalize = (pathname: string) => pathname.replace(/\/+$/, "");

export function isIntegrationsPath(pathname: string): boolean {
  const path = normalize(pathname);
  return path === INTEGRATIONS_PATH || path.startsWith(`${INTEGRATIONS_PATH}/`);
}

export function integrationsTabForPath(pathname: string): IntegrationsTab | null {
  const path = normalize(pathname);
  return INTEGRATIONS_TABS.find((tab) => tab.path === path) ?? null;
}

/** Anchors that name a row by something other than their tab's prefix. */
const TAB_BY_ANCHOR: Readonly<Record<string, IntegrationsTabId>> = {
  "mcp-connections": "mcp",
  "agent-browser-access": "access",
  "agent-computer-access": "access",
  "agent-browser-profile": "access",
  // The section that holds those rows; its "browser-" prefix is not the preview tab's.
  "browser-access": "access",
  "agent-device-access": "devices",
  "max-booted-devices": "devices",
  devices: "devices",
  browser: "preview",
};

/**
 * The tab that holds a row, from the anchor an older link or a settings-search
 * result names. Links written before the tabs existed point at
 * `/settings/integrations#<anchor>`.
 */
export function integrationsTabForAnchor(hash: string): IntegrationsTabId {
  const anchor = hash.replace(/^#/, "");
  const named = TAB_BY_ANCHOR[anchor];
  if (named) return named;
  if (anchor.startsWith("device-")) return "devices";
  if (anchor.startsWith("browser-")) return "preview";
  if (anchor.startsWith("mcp-")) return "mcp";
  return "access";
}

export function integrationsTabPath(id: IntegrationsTabId): IntegrationsTabPath {
  return INTEGRATIONS_TABS.find((tab) => tab.id === id)!.path;
}
