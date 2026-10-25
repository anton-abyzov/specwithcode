// @vitest-environment jsdom
import type { DesignSystemId, DesignSystemSummary } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SystemMenu, type SystemMenuProps } from "./SystemMenu";
import { deleteWarning } from "./systemText";
import { TEST_SYSTEM } from "./testSystem";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.click();
  });
  await flush();
}

const item = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((element) =>
    element.textContent?.includes(text),
  );

const sibling = (systemId: string, name: string): DesignSystemSummary => ({
  ref: {
    owner: { kind: "project", environmentId: "host" as never, projectId: "harbor" as never },
    systemId: systemId as DesignSystemId,
    path: `.specweave/design/systems/${systemId}`,
  },
  name,
  revision: 1,
  updatedAt: "2026-10-20T10:00:00.000Z",
  tokenCount: 4,
  componentCount: 0,
  sources: [],
  ownerLabel: "Harbor",
});

function props(overrides: Partial<SystemMenuProps> = {}): SystemMenuProps {
  return {
    system: TEST_SYSTEM,
    ownerLabel: "Harbor",
    siblings: [sibling(TEST_SYSTEM.id, "Harbor UI"), sibling("s_dock", "Dock kit")],
    canManage: true,
    storage: { usedBytes: 2048, limitBytes: 50 * 1024 * 1024 },
    usage: 3,
    onSwitch: vi.fn(),
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onOpenSettings: vi.fn(),
    onRescan: vi.fn(),
    onStorage: vi.fn(),
    onDelete: vi.fn(async () => null),
    ...overrides,
  };
}

async function openMenu(menu: SystemMenuProps) {
  act(() => root.render(<SystemMenu {...menu} />));
  await press(document.querySelector<HTMLElement>('[aria-label="Design system menu"]')!);
}

describe("SystemMenu", () => {
  it("says when the system was updated and lists its actions", async () => {
    await openMenu(props());
    expect(document.querySelector('[data-testid="system-menu-header"]')!.textContent).toBe(
      "Design system · Updated October 23, 2026",
    );
    for (const label of [
      "Switch system",
      "Rename",
      "Duplicate",
      "Open in Settings",
      "Rescan",
      "Storage",
      "Delete",
    ])
      expect(item(label), label).toBeDefined();
    expect(item("Storage")!.textContent).toContain("2 KB");
  });

  it("leaves Rescan out for a system not read from files", async () => {
    await openMenu(props({ onRescan: null }));
    expect(item("Rescan")).toBeUndefined();
  });

  it("runs Rename, Duplicate and Open in Settings", async () => {
    const menu = props();
    await openMenu(menu);
    await press(item("Rename")!);
    expect(menu.onRename).toHaveBeenCalledOnce();
    await press(document.querySelector<HTMLElement>('[aria-label="Design system menu"]')!);
    await press(item("Duplicate")!);
    expect(menu.onDuplicate).toHaveBeenCalledOnce();
    await press(document.querySelector<HTMLElement>('[aria-label="Design system menu"]')!);
    await press(item("Open in Settings")!);
    expect(menu.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("disables changes for a window that may not write", async () => {
    await openMenu(props({ canManage: false }));
    for (const label of ["Rename", "Duplicate", "Delete"])
      expect(item(label)!.getAttribute("aria-disabled"), label).toBe("true");
    expect(item("Open in Settings")!.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("warns how many designs use the system before deleting it", async () => {
    const menu = props({ onDelete: vi.fn(async () => "The disk is read-only.") });
    await openMenu(menu);
    await press(item("Delete")!);
    const dialog = document.querySelector('[data-testid="system-delete-dialog"]')!;
    expect(dialog.textContent).toContain("Delete “Harbor UI”?");
    expect(dialog.textContent).toContain(
      "This deletes Harbor UI and its stored files from Harbor. 3 designs use it; they keep its id and render without it.",
    );
    await press(document.querySelector<HTMLElement>('[data-testid="system-delete-confirm"]')!);
    expect(menu.onDelete).toHaveBeenCalledOnce();
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe("The disk is read-only.");
  });
});

describe("deleteWarning", () => {
  it("agrees with one design and with several", () => {
    expect(deleteWarning({ name: "Harbor UI" }, 1, "Harbor")).toBe(
      "This deletes Harbor UI and its stored files from Harbor. 1 design uses it; it keeps its id and renders without it.",
    );
    expect(deleteWarning({ name: "Harbor UI" }, 2, "Harbor")).toBe(
      "This deletes Harbor UI and its stored files from Harbor. 2 designs use it; they keep its id and render without it.",
    );
  });
});
