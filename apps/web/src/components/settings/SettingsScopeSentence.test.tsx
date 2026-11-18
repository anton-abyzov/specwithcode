// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pathname: "/settings/skills",
  search: {} as { project?: string; machine?: string },
  singleEnvironment: true,
}));

const environments = [
  { environmentId: "env-a", label: "Desk", connection: { phase: "connected" }, serverConfig: null },
  { environmentId: "env-b", label: "Mini", connection: { phase: "idle" }, serverConfig: null },
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

  it("names the picked project on Skills", () => {
    const view = render({
      pathname: "/settings/skills",
      search: { project: "p1", machine: "env-a" },
      singleEnvironment: true,
    });
    expect(view.querySelector('[aria-label="Project: notes-app"]')).not.toBeNull();
    expect(view.textContent).toContain("Changes here only affect Desk.");
  });

  it("keeps All environments on the other settings pages", () => {
    const view = render({ pathname: "/settings/storage", search: {}, singleEnvironment: false });
    expect(view.textContent).toContain("Applying settings");
    expect(view.textContent).not.toContain("Each machine keeps its own");
    expect(choices(view)).toContain("All environments");
    expect(view.querySelector('[aria-label="Environment scope: All environments"]')).not.toBeNull();
  });
});
