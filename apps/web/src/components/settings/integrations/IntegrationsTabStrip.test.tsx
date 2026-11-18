// @vitest-environment jsdom
import { AuthSettingsWriteScope } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  access: "granted" as "granted" | "denied" | "signed-out" | "unknown",
  accessFor: vi.fn(),
  scope: { kind: "environment", environmentId: "mini", label: "Mini" } as Record<string, unknown>,
  phase: "connected",
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../../state/session", () => ({
  useEnvironmentScopeAccess: (environmentId: string | null, scope: string) => {
    if (environmentId === null) state.accessFor(null);
    else state.accessFor(environmentId, scope);
    return environmentId === null ? "unknown" : state.access;
  },
}));
vi.mock("../SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: state.scope,
    environments: [{ environmentId: "mini", connection: { phase: state.phase } }],
  }),
}));

import {
  IntegrationsMachineState,
  IntegrationsTabPanel,
  IntegrationsTabStrip,
  integrationsTabAfterKey,
} from "./IntegrationsTabStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.access = "granted";
  state.scope = { kind: "environment", environmentId: "mini", label: "Mini" };
  state.phase = "connected";
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const tabs = (view: HTMLElement) => [...view.querySelectorAll<HTMLElement>('[role="tab"]')];

describe("IntegrationsTabStrip", () => {
  it("moves with the arrow, Home and End keys and wraps at the ends", () => {
    expect(integrationsTabAfterKey("access", "ArrowRight")).toBe("mcp");
    expect(integrationsTabAfterKey("preview", "ArrowRight")).toBe("access");
    expect(integrationsTabAfterKey("access", "ArrowLeft")).toBe("preview");
    expect(integrationsTabAfterKey("devices", "Home")).toBe("access");
    expect(integrationsTabAfterKey("mcp", "End")).toBe("preview");
    expect(integrationsTabAfterKey("mcp", "Enter")).toBeNull();
  });

  it("marks the open tab and keeps one tab stop", () => {
    const view = render(<IntegrationsTabStrip current="devices" />);
    expect(tabs(view).map((tab) => tab.textContent)).toEqual([
      "Agent access",
      "MCP servers",
      "Devices",
      "Preview and recording",
    ]);
    expect(tabs(view).map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(tabs(view).map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1]);
    expect(view.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe(
      "Integrations sections",
    );
  });

  it("names each panel by its tab", () => {
    const view = render(
      <>
        <IntegrationsTabStrip current="mcp" />
        <IntegrationsTabPanel tab="mcp">rows</IntegrationsTabPanel>
      </>,
    );
    const panel = view.querySelector('[role="tabpanel"]')!;
    const tab = tabs(view)[1]!;
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
  });

  it("opens a tab as a navigation that drops the row and replaces history", () => {
    const view = render(<IntegrationsTabStrip current="access" />);
    act(() => tabs(view)[1]!.click());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/settings/integrations/mcp",
      hash: "",
      replace: true,
      hashScrollIntoView: false,
    });
  });

  it("opens the next tab from the keyboard", async () => {
    const view = render(<IntegrationsTabStrip current="preview" />);
    await act(async () => {
      tabs(view)[3]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/settings/integrations/access" }),
    );
  });
});

describe("IntegrationsMachineState", () => {
  const view = () => render(<IntegrationsMachineState>rows</IntegrationsMachineState>);

  it("shows the rows of a connected machine this sign-in may change", () => {
    const shown = view();
    expect(
      shown.querySelector('[data-testid="integrations-machine-rows"]')!.hasAttribute("inert"),
    ).toBe(false);
    expect(shown.textContent).toBe("rows");
    expect(state.accessFor).toHaveBeenLastCalledWith("mini", AuthSettingsWriteScope);
  });

  it("says a machine is down instead of showing rows it cannot read", () => {
    state.phase = "error";
    const shown = view();
    const card = shown.querySelector('[data-testid="integrations-machine-away"]')!;
    expect(card.textContent).toContain("Mini");
    expect(card.textContent).toContain(
      "Its settings show when it reconnects. Pick another machine above to set that one up.",
    );
    expect(shown.textContent).not.toContain("rows");
    // A machine that is away keeps its last grant; it says nothing about now.
    expect(state.accessFor).toHaveBeenLastCalledWith(null);
  });

  it("says a machine is connecting, without sending the reader elsewhere", () => {
    state.phase = "connecting";
    const shown = view();
    const card = shown.querySelector('[data-testid="integrations-machine-away"]')!;
    expect(card.textContent).toBe("Connecting to Mini…");
    expect(shown.textContent).not.toContain("rows");
  });

  it("keeps the rows readable for a sign-in that may not change them", () => {
    state.access = "denied";
    const shown = view();
    expect(
      shown.querySelector('[data-testid="integrations-machine-rows"]')!.hasAttribute("inert"),
    ).toBe(true);
    expect(shown.querySelector('[data-testid="integrations-machine-view-only"]')!.textContent).toBe(
      "You can look at Mini's settings from this sign-in, but not change them.",
    );
    expect(shown.textContent).toContain("rows");
  });

  it("takes the rows out of reach and leaves the links that lead elsewhere", () => {
    state.access = "denied";
    const shown = render(
      <IntegrationsMachineState links={<a href="#elsewhere">Open</a>}>
        <button type="button">Change</button>
      </IntegrationsMachineState>,
    );
    expect(shown.querySelector("button")!.closest("[inert]")).not.toBeNull();
    expect(shown.querySelector("a")!.closest("[inert]")).toBeNull();
  });

  it("leaves rows that guard themselves open, and asks for the grant the tab needs", () => {
    state.access = "denied";
    const shown = render(
      <IntegrationsMachineState changeScope={"filesystem:write" as never} disableRows={false}>
        <button type="button">Details</button>
      </IntegrationsMachineState>,
    );
    expect(shown.querySelector('[data-testid="integrations-machine-view-only"]')).not.toBeNull();
    expect(shown.querySelector("button")!.closest("[inert]")).toBeNull();
    expect(state.accessFor).toHaveBeenLastCalledWith("mini", "filesystem:write");
  });

  it.each(["unknown", "signed-out"] as const)(
    "makes no claim about permissions while the sign-in is %s",
    (access) => {
      state.access = access;
      const shown = view();
      expect(shown.querySelector('[data-testid="integrations-machine-view-only"]')).toBeNull();
      expect(shown.textContent).toBe("rows");
    },
  );

  it("explains a machine that is no longer in the list", () => {
    state.scope = { kind: "unavailable", message: "This environment is no longer available." };
    const shown = view();
    expect(shown.textContent).toBe("This environment is no longer available.");
  });

  it("shows the rows' own empty states when no machine is connected", () => {
    state.scope = { kind: "all", label: "All environments" };
    expect(view().textContent).toBe("rows");
  });
});
