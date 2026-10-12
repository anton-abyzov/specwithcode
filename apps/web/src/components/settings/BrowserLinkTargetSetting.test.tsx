import type { ExternalBrowser, ExternalBrowserTarget } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  supported: true,
  browsers: null as ReadonlyArray<ExternalBrowser> | null,
  settings: {
    browserLinkTarget: "system" as "system" | "app",
    browserExternalTarget: null as ExternalBrowserTarget | null,
  },
  update: vi.fn(),
  onValueChange: undefined as ((value: string) => void) | undefined,
}));

vi.mock("~/browser/externalBrowsers", () => ({
  canUseExternalBrowsers: () => mocks.supported,
  useExternalBrowsers: () => mocks.browsers,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
  useUpdatePrimarySettings: () => mocks.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control, resetAction }: { control: ReactNode; resetAction: ReactNode }) => (
    <div>
      {resetAction}
      {control}
    </div>
  ),
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" data-reset onClick={onClick} />
  ),
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ id: "browser-link-target", title: "Open links in" }),
}));
vi.mock("../ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value: string;
      onValueChange: (value: string) => void;
    }) => {
      mocks.onValueChange = onValueChange;
      return <div data-select={value}>{children}</div>;
    },
    SelectTrigger: ({ children }: { children?: ReactNode }) => <div data-trigger>{children}</div>,
    SelectValue: Pass,
    SelectPopup: Pass,
    SelectItem: ({ children, value }: { children?: ReactNode; value: string }) => (
      <div data-item={value}>{children}</div>
    ),
  };
});

import { BrowserLinkTargetSetting } from "./BrowserLinkTargetSetting";

const chrome: ExternalBrowser = {
  id: "chrome",
  name: "Chrome",
  profiles: [
    { directory: "Default", name: "Personal" },
    { directory: "Profile 2", name: "Work", account: "ads@work.example" },
  ],
};

function render(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<BrowserLinkTargetSetting disabled={false} />);
  });
  return renderer;
}

const textOf = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : textOf(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");

const selectedValue = (renderer: ReactTestRenderer) =>
  renderer.root.find((node) => node.props["data-select"] !== undefined).props["data-select"];
const triggerText = (renderer: ReactTestRenderer) =>
  textOf(renderer.root.find((node) => node.props["data-trigger"] === true));
const itemValues = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => node.props["data-item"] !== undefined)
    .map((node) => node.props["data-item"]);

describe("BrowserLinkTargetSetting", () => {
  beforeEach(() => {
    mocks.supported = true;
    mocks.browsers = null;
    mocks.settings = { browserLinkTarget: "system", browserExternalTarget: null };
    mocks.update.mockReset();
  });

  it("shows a saved profile, not the default browser, while the list loads", () => {
    mocks.settings.browserExternalTarget = { browserId: "chrome", profileDirectory: "Profile 2" };
    const renderer = render();
    expect(selectedValue(renderer)).toBe("external:chrome:Profile 2");
    expect(triggerText(renderer)).toBe("Chrome — Profile 2");
  });

  it("lists each profile and saves the one picked", () => {
    mocks.browsers = [chrome];
    const renderer = render();
    expect(itemValues(renderer)).toEqual([
      "system",
      "app",
      "external:chrome:Default",
      "external:chrome:Profile 2",
    ]);
    act(() => mocks.onValueChange?.("external:chrome:Profile 2"));
    expect(mocks.update).toHaveBeenCalledWith({
      browserLinkTarget: "system",
      browserExternalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
    });
  });

  it("offers only the built-in choices without the desktop app", () => {
    mocks.supported = false;
    mocks.settings.browserExternalTarget = { browserId: "chrome", profileDirectory: "Profile 2" };
    const renderer = render();
    expect(itemValues(renderer)).toEqual(["system", "app"]);
    expect(triggerText(renderer)).toBe("Your default browser");
  });

  it("resets to the default browser", () => {
    mocks.browsers = [chrome];
    mocks.settings.browserExternalTarget = { browserId: "chrome", profileDirectory: "Default" };
    const renderer = render();
    act(() => renderer.root.find((node) => node.props["data-reset"] === true).props.onClick());
    expect(mocks.update).toHaveBeenCalledWith({
      browserLinkTarget: "system",
      browserExternalTarget: null,
    });
  });
});
