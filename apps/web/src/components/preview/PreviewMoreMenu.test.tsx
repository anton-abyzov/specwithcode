import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const menuState = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));

// Base UI menus render their popups only while open; flatten them so the
// items can be read and clicked directly.
vi.mock("~/components/ui/menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Menu: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => {
      menuState.onOpenChange = onOpenChange;
      return <>{children}</>;
    },
    MenuTrigger: () => null,
    MenuPopup: Pass,
    MenuGroup: Pass,
    MenuGroupLabel: Pass,
    MenuRadioGroup: Pass,
    MenuRadioItem: Pass,
    MenuSeparator: () => null,
    MenuSub: Pass,
    MenuSubPopup: Pass,
    MenuSubTrigger: ({ children }: { children?: ReactNode }) => (
      <span data-sub-trigger>{children}</span>
    ),
    MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" data-menu-item onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));

import { PreviewMoreMenu } from "./PreviewMoreMenu";
import type { PreviewOpenInMenu } from "./usePreviewOpenIn";

const actions = {
  hardReload: () => undefined,
  setColorScheme: () => undefined,
  zoomIn: () => undefined,
  zoomOut: () => undefined,
  resetZoom: () => undefined,
  clearCookies: () => undefined,
  clearCache: () => undefined,
};

function render(openIn: PreviewOpenInMenu | undefined): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <PreviewMoreMenu
        enabled
        actions={actions}
        zoomFactor={1}
        colorScheme="system"
        deviceToolbarVisible={false}
        onToggleDeviceToolbar={() => undefined}
        nativePictureInPicture={false}
        profileName={undefined}
        openIn={openIn}
      />,
    );
  });
  return renderer;
}

const textOf = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : textOf(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");

const subTriggers = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => node.props["data-sub-trigger"] === true)
    .map((node) => textOf(node));

describe("PreviewMoreMenu Open in submenu", () => {
  it("lists the default browser and each profile, and opens the clicked one", () => {
    const onOpen = vi.fn();
    const renderer = render({
      choices: [
        {
          key: "external:chrome:Profile 2",
          label: "Chrome — Work (Profile 2)",
          detail: "ads@work.example",
          target: { browserId: "chrome", profileDirectory: "Profile 2" },
        },
      ],
      onOpen,
      refresh: () => undefined,
    });
    expect(subTriggers(renderer)).toContain("Open in");
    const items = renderer.root.findAll((node) => node.props["data-menu-item"] === true);
    const defaultItem = items.find((node) => textOf(node) === "Your default browser");
    const workItem = items.find((node) => textOf(node).startsWith("Chrome — Work (Profile 2)"));
    expect(workItem && textOf(workItem)).toContain("ads@work.example");
    act(() => defaultItem?.props.onClick());
    act(() => workItem?.props.onClick());
    expect(onOpen.mock.calls).toEqual([
      [null],
      [{ browserId: "chrome", profileDirectory: "Profile 2" }],
    ]);
  });

  it("re-reads installed browsers each time the menu opens", () => {
    const refresh = vi.fn();
    render({ choices: [], onOpen: () => undefined, refresh });
    act(() => menuState.onOpenChange?.(true));
    act(() => menuState.onOpenChange?.(false));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("hides the submenu without profiles or outside the desktop app", () => {
    expect(
      subTriggers(render({ choices: [], onOpen: () => undefined, refresh: () => undefined })),
    ).not.toContain("Open in");
    expect(subTriggers(render(undefined))).not.toContain("Open in");
  });
});
