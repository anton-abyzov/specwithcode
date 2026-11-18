// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  desktop: true,
  pathname: "/settings/skills",
  search: {} as { project?: string; machine?: string },
  singleEnvironment: true,
}));

const primaryAt = (httpBaseUrl: string) => ({
  target: { _tag: "PrimaryConnectionTarget", httpBaseUrl },
});
const environments = [
  {
    environmentId: "env-a",
    label: "Desk",
    connection: { phase: "connected" },
    serverConfig: null,
    entry: primaryAt("http://127.0.0.1:3773"),
  },
  {
    environmentId: "env-b",
    label: "Mini",
    connection: { phase: "offline" },
    serverConfig: null,
    entry: { target: { _tag: "RemoteConnectionTarget" } },
  },
];
const groups = [{ projectKey: "p1", displayName: "notes-app", memberProjects: [] }];

vi.mock("@tanstack/react-router", () => ({
  useLocation: (input: { select: (location: { pathname: string }) => unknown }) =>
    input.select({ pathname: state.pathname }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => ({
    search: state.search,
    singleEnvironment: state.singleEnvironment,
    groups,
    scope: { kind: state.search.machine ? "environment" : "all" },
    selectScope: () => {},
  }),
}));
vi.mock("../../env", () => ({
  get isElectron() {
    return state.desktop;
  },
}));
vi.mock("./useNamedEnvironments", () => ({ useNamedEnvironments: () => ({ environments }) }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
// Render every menu open, so its choices are in the document.
vi.mock("../ui/menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Menu: Pass,
    MenuPopup: Pass,
    MenuRadioGroup: Pass,
    MenuRadioItem: ({ children, value }: { children?: ReactNode; value: string }) => (
      <div role="menuitemradio" data-value={value}>
        {children}
      </div>
    ),
    MenuRadioItemIndicator: () => null,
    MenuSeparator: () => null,
    MenuTrigger: ({ children, ...props }: { children?: ReactNode; "aria-label"?: string }) => (
      <button type="button" aria-label={props["aria-label"]}>
        {children}
      </button>
    ),
  };
});

import { SettingsScopeSentence } from "./SettingsScopeSentence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
function render(next: Partial<typeof state>) {
  Object.assign(state, next);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SettingsScopeSentence />));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
const choices = (view: HTMLElement) =>
  [...view.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent);

describe("SettingsScopeSentence", () => {
  it("reads 'Set up for All projects on <machine>' on Skills, with the caption", () => {
    const view = render({
      pathname: "/settings/skills",
      search: { machine: "env-a" },
      singleEnvironment: true,
    });
    expect(view.textContent).toContain("Set up for");
    expect(view.textContent).toContain("All projects");
    expect(view.textContent).toContain(
      "Each machine keeps its own. Changes here only affect Desk.",
    );
    expect(view.textContent).not.toMatch(/environment/i);
    expect(view.querySelector('[aria-label="Machine: Desk"]')).not.toBeNull();
    expect(view.querySelector('[aria-label="Project: All projects"]')).not.toBeNull();
    expect(choices(view)).not.toContain("All environments");
    expect(choices(view)).toEqual(expect.arrayContaining(["Desk", "MiniOffline"]));
  });

  it("says which machine you are on when setting up another one", () => {
    const here = render({
      pathname: "/settings/skills",
      search: { machine: "env-a" },
      singleEnvironment: true,
    });
    expect(here.querySelector('[data-testid="settings-scope-seat"]')).toBeNull();
    act(() => root?.unmount());
    const other = render({
      pathname: "/settings/skills",
      search: { machine: "env-b" },
      singleEnvironment: true,
    });
    expect(other.querySelector('[data-testid="settings-scope-seat"]')!.textContent).toBe(
      "You are on Desk",
    );
    expect(other.textContent).toContain("Changes here only affect Mini.");
  });

  it("makes no claim about your device when this page came from another machine", () => {
    const local = environments[0]!.entry;
    environments[0]!.entry = primaryAt("https://desk.example.ts.net");
    try {
      const view = render({
        pathname: "/settings/skills",
        search: { machine: "env-b" },
        singleEnvironment: true,
      });
      expect(view.querySelector('[data-testid="settings-scope-seat"]')).toBeNull();
      expect(view.textContent).toContain("Changes here only affect Mini.");
    } finally {
      environments[0]!.entry = local;
    }
  });

  it("names the picked project on Skills", () => {
    const view = render({
      pathname: "/settings/skills",
      search: { project: "p1", machine: "env-a" },
      singleEnvironment: true,
    });
    expect(view.querySelector('[aria-label="Project: notes-app"]')).not.toBeNull();
    expect(view.textContent).toContain("Changes here only affect Desk.");
  });

  it("reads 'Set up on <machine>' with its status on the per-machine Integrations tabs", () => {
    for (const tab of ["access", "mcp", "devices"]) {
      const view = render({
        pathname: `/settings/integrations/${tab}`,
        search: { machine: "env-a" },
        singleEnvironment: true,
      });
      expect(view.textContent).toContain("Set up on");
      expect(view.textContent).not.toContain("Set up for");
      expect(view.querySelector('[aria-label="Machine: Desk"]')).not.toBeNull();
      expect(view.querySelector('[aria-label^="Project"]')).toBeNull();
      expect(view.querySelector('[data-testid="settings-scope-status"]')!.textContent).toBe(
        "Connected",
      );
      expect(view.querySelector('[data-testid="settings-scope-caption"]')!.textContent).toBe(
        "Each machine keeps its own. Changes here only affect Desk.",
      );
      expect(choices(view)).not.toContain("All environments");
      expect(view.textContent).not.toMatch(/environment/i);
      act(() => root?.unmount());
    }
  });

  it("names your seat when an Integrations tab sets up another machine", () => {
    const view = render({
      pathname: "/settings/integrations/mcp",
      search: { machine: "env-b" },
      singleEnvironment: true,
    });
    expect(view.querySelector('[data-testid="settings-scope-seat"]')!.textContent).toBe(
      "You are on Desk",
    );
    // The phase this device reports when it has no network of its own.
    expect(view.querySelector('[data-testid="settings-scope-status"]')!.textContent).toBe(
      "No network",
    );
    expect(view.textContent).toContain("Changes here only affect Mini.");
  });

  it("names a lone machine in plain text, with nothing to pick", () => {
    const other = environments.pop()!;
    try {
      const view = render({
        pathname: "/settings/integrations/devices",
        search: { machine: "env-a" },
        singleEnvironment: true,
      });
      expect(view.textContent).toContain("Set up on Desk");
      expect(view.querySelector("button")).toBeNull();
      expect(choices(view)).toEqual([]);
      expect(view.querySelector('[data-testid="settings-scope-status"]')!.textContent).toBe(
        "Connected",
      );
      // The other machine pages stay silent while there is one machine.
      act(() => root?.unmount());
      expect(
        render({ pathname: "/settings/providers", search: {}, singleEnvironment: true })
          .textContent,
      ).toBe("");
    } finally {
      environments.push(other);
    }
  });

  it("says the preview tab is saved in this app window and offers no machine", () => {
    const view = render({
      pathname: "/settings/integrations/preview",
      search: { machine: "env-b" },
      singleEnvironment: false,
    });
    expect(view.querySelector('[data-testid="settings-scope-app-window"]')!.textContent).toBe(
      "Only in this app windowSaved in the app on this computer. Other machines and your phone keep their own.",
    );
    expect(view.querySelector("button")).toBeNull();
    expect(choices(view)).toEqual([]);
    // The browser client has no such settings, so it claims nothing about them.
    act(() => root?.unmount());
    try {
      const browser = render({ desktop: false });
      expect(browser.textContent).toBe("");
    } finally {
      state.desktop = true;
    }
  });

  it("leaves the Providers and Models sentence as it was", () => {
    for (const page of ["providers", "models"]) {
      const view = render({
        pathname: `/settings/${page}`,
        search: { machine: "env-a" },
        singleEnvironment: true,
      });
      expect(view.textContent).toContain("Applying settings on");
      expect(view.textContent).not.toContain("Set up");
      expect(view.querySelector('[data-testid="settings-scope-status"]')).toBeNull();
      act(() => root?.unmount());
    }
  });

  it("keeps All environments on the other settings pages", () => {
    const view = render({ pathname: "/settings/storage", search: {}, singleEnvironment: false });
    expect(view.textContent).toContain("Applying settings");
    expect(view.textContent).not.toContain("Each machine keeps its own");
    expect(choices(view)).toContain("All environments");
    expect(view.querySelector('[aria-label="Environment scope: All environments"]')).not.toBeNull();
  });
});
