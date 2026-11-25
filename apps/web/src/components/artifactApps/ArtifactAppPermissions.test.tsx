import type {
  DesktopArtifactAppPermissions,
  DesktopArtifactAppPermissionsInput,
} from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock("../ui/toast", () => ({ toastManager: { add: state.addToast } }));
vi.mock("../ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div data-menu>{children}</div>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <div data-trigger>{children}</div>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div data-popup>{children}</div>,
  MenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuGroupLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  MenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" data-item onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { ArtifactAppPermissions } from "./ArtifactAppPermissions";

let renderer: ReactTestRenderer | undefined;

const permissions = (
  overrides: Partial<DesktopArtifactAppPermissions> = {},
): DesktopArtifactAppPermissions => ({
  attachmentId: "version-1",
  declared: ["notifications", "tray"],
  granted: ["notifications", "tray"],
  ...overrides,
});

function stubShell(
  answer: (input: DesktopArtifactAppPermissionsInput) => Promise<DesktopArtifactAppPermissions>,
) {
  const artifactAppPermissions = vi.fn(answer);
  vi.stubGlobal("window", { desktopBridge: { artifactAppPermissions } });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  return artifactAppPermissions;
}

async function render(value: DesktopArtifactAppPermissions, onChange = vi.fn()) {
  await act(async () => {
    renderer = create(<ArtifactAppPermissions permissions={value} onChange={onChange} />);
  });
  return { root: renderer!.root, onChange };
}

const text = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : text(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");

const items = (root: ReactTestRenderer["root"]) => root.findAllByProps({ "data-item": true });

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  state.addToast.mockReset();
});

describe("ArtifactAppPermissions", () => {
  it("lists the powers granted to this version and offers to turn all of them off", async () => {
    const shell = stubShell(async () => permissions({ granted: [] }));
    const { root, onChange } = await render(permissions());
    expect(text(root.findByType("h2"))).toBe("This version of the page can");
    expect(items(root).map(text)).toEqual([
      "Show notifications",
      "Add an item to the menu bar",
      "Turn off all",
    ]);
    // The granted powers are a list, not actions.
    expect(items(root).map((item) => item.props.disabled === true)).toEqual([true, true, false]);

    await act(async () => {
      items(root)[2]!.props.onClick();
    });
    expect(shell).toHaveBeenCalledWith({ action: "turn-off" });
    expect(onChange).toHaveBeenCalledWith(permissions({ granted: [] }));
  });

  it("offers to ask again when something declared is not allowed", async () => {
    const shell = stubShell(async () => permissions());
    const { root, onChange } = await render(permissions({ granted: [] }));
    expect(text(root.findByType("h2"))).toBe("This version of the page has no permissions");
    expect(items(root).map(text)).toEqual(["Ask me again…"]);
    await act(async () => {
      items(root)[0]!.props.onClick();
    });
    expect(shell).toHaveBeenCalledWith({ action: "ask" });
    expect(onChange).toHaveBeenCalledWith(permissions());
  });

  it("shows nothing for a version that declares no powers", async () => {
    stubShell(async () => permissions());
    const { root } = await render(permissions({ declared: [], granted: [] }));
    expect(root.findAllByProps({ "data-menu": true })).toEqual([]);
  });

  it("keeps what it shows when the shell fails or answers for another version", async () => {
    stubShell(async () => {
      throw new Error("ipc failed");
    });
    const failed = await render(permissions());
    await act(async () => {
      items(failed.root)[2]!.props.onClick();
    });
    expect(failed.onChange).not.toHaveBeenCalled();
    expect(state.addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not change the permissions",
    });
    act(() => renderer?.unmount());

    stubShell(async () => permissions({ attachmentId: "version-2", granted: [] }));
    const stale = await render(permissions());
    await act(async () => {
      items(stale.root)[2]!.props.onClick();
    });
    expect(stale.onChange).not.toHaveBeenCalled();
  });
});
