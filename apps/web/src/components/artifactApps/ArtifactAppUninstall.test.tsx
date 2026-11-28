import type { DesktopArtifactAppUninstallInput } from "@specweave-studio/contracts";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  addToast: vi.fn(),
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: state.addToast } }));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div data-menu>{children}</div>,
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, { "data-trigger": true } as object, children),
  MenuPopup: ({ children }: { children: ReactNode }) => <div data-popup>{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" data-item onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => {
    state.onOpenChange = onOpenChange;
    return open ? <div data-dialog>{children}</div> : null;
  },
  AlertDialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogClose: ({ children }: { children: ReactNode }) => (
    <button type="button" data-close onClick={() => state.onOpenChange?.(false)}>
      {children}
    </button>
  ),
}));

import { ArtifactAppFrame } from "./ArtifactAppView";

const INSTALL_ID = "0123456789abcdef0123456789abcdef";

let renderer: ReactTestRenderer | undefined;

function stubShell(options: { removed?: boolean; withRequest?: boolean } = {}) {
  const uninstallArtifactApp = vi.fn(
    async (_input: DesktopArtifactAppUninstallInput) => options.removed ?? true,
  );
  const request = { listener: undefined as (() => void) | undefined };
  const unsubscribe = vi.fn();
  const onArtifactAppUninstallRequest =
    options.withRequest === false
      ? undefined
      : vi.fn((listener: () => void) => {
          request.listener = listener;
          return unsubscribe;
        });
  const close = vi.fn();
  vi.stubGlobal("window", {
    close,
    desktopBridge: { uninstallArtifactApp, onArtifactAppUninstallRequest },
  });
  vi.stubGlobal("document", { title: "" });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  return { uninstallArtifactApp, request, unsubscribe, close };
}

async function render() {
  await act(async () => {
    renderer = create(
      <ArtifactAppFrame name="Work that keeps going" installId={INSTALL_ID}>
        <main />
      </ArtifactAppFrame>,
    );
  });
  return renderer!.root;
}

const text = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : text(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");

const buttons = (root: ReactTestRenderer["root"]) => root.findAllByType("button");
const byText = (root: ReactTestRenderer["root"], label: string) =>
  buttons(root).find((button) => text(button) === label);
const dialog = (root: ReactTestRenderer["root"]) => root.findAllByProps({ "data-dialog": true });

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  state.addToast.mockReset();
  state.onOpenChange = undefined;
});

describe("ArtifactAppFrame uninstall", () => {
  it("shows no Uninstall button in the header, only an icon-only More menu", async () => {
    stubShell();
    const root = await render();
    const header = root.findByType("header");
    const trigger = header.findByProps({ "data-trigger": true });
    expect(trigger.props["aria-label"]).toBe("More");
    expect(text(trigger)).toBe("");
    // Outside the menu's popup the header's only button is the unlabeled More trigger.
    const popupItems = header.findAllByProps({ "data-item": true });
    const visible = buttons(header).filter((button) => !popupItems.includes(button));
    expect(visible.map((button) => text(button))).toEqual([""]);
    expect(popupItems.map((item) => text(item))).toEqual(["Uninstall Work that keeps going…"]);
    expect(dialog(root)).toHaveLength(0);
  });

  it("opens the confirm from the menu item; Cancel never uninstalls", async () => {
    const shell = stubShell();
    const root = await render();
    await act(async () => byText(root, "Uninstall Work that keeps going…")!.props.onClick());
    expect(dialog(root)).toHaveLength(1);
    expect(text(root.findByType("h2"))).toBe("Uninstall Work that keeps going?");
    expect(text(root.findByType("p"))).toBe(
      "Its launcher is removed from this computer. The page stays in its thread, and you can install it again.",
    );
    await act(async () => byText(root, "Cancel")!.props.onClick());
    expect(dialog(root)).toHaveLength(0);
    expect(shell.uninstallArtifactApp).not.toHaveBeenCalled();
    expect(shell.close).not.toHaveBeenCalled();
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("uninstalls once on confirm and closes the window", async () => {
    const shell = stubShell();
    const root = await render();
    await act(async () => byText(root, "Uninstall Work that keeps going…")!.props.onClick());
    await act(async () => byText(root, "Uninstall")!.props.onClick());
    expect(shell.uninstallArtifactApp).toHaveBeenCalledTimes(1);
    expect(shell.uninstallArtifactApp).toHaveBeenCalledWith({ installId: INSTALL_ID });
    expect(shell.close).toHaveBeenCalledTimes(1);
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("says so when the shell could not uninstall, and keeps the window", async () => {
    const shell = stubShell({ removed: false });
    const root = await render();
    await act(async () => byText(root, "Uninstall Work that keeps going…")!.props.onClick());
    await act(async () => byText(root, "Uninstall")!.props.onClick());
    expect(shell.uninstallArtifactApp).toHaveBeenCalledTimes(1);
    expect(shell.close).not.toHaveBeenCalled();
    expect(state.addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not uninstall the app",
    });
    expect(dialog(root)).toHaveLength(0);
  });

  it("opens the same confirm when the page's app menu asks, and unsubscribes on unmount", async () => {
    const shell = stubShell();
    const root = await render();
    expect(shell.request.listener).toBeTypeOf("function");
    await act(async () => shell.request.listener!());
    expect(dialog(root)).toHaveLength(1);
    expect(text(root.findByType("h2"))).toBe("Uninstall Work that keeps going?");
    expect(shell.uninstallArtifactApp).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(shell.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("still offers the menu on a shell without app menu requests", async () => {
    stubShell({ withRequest: false });
    const root = await render();
    expect(byText(root, "Uninstall Work that keeps going…")).toBeDefined();
  });

  it("offers no menu when the shell cannot uninstall", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    vi.stubGlobal("document", { title: "" });
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const root = await render();
    expect(root.findAllByProps({ "data-trigger": true })).toHaveLength(0);
  });
});
