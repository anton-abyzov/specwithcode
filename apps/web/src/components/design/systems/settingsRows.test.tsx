// @vitest-environment jsdom
/** Settings > Design systems rows open the system's page, and offer Rename and Delete (1046 AC-08). */
import type { DesignSystemSummary } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesignSystemsSettingsView } from "./DesignSystemsSettingsView";
import { FIGMA_OFF, PROJECTS, SYSTEMS } from "./fixtureData";
import { DeleteSystemDialog, usageWarning } from "./ManageSystemDialogs";

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

async function press(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  await flush();
}

const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => ({
    item,
    label: item.textContent?.trim() ?? "",
  }));

function render(
  extra: Partial<Parameters<typeof DesignSystemsSettingsView>[0]> = {},
  wired = true,
) {
  const handlers = {
    onOpenSystem: vi.fn(),
    onRenameSystem: vi.fn(),
    onDeleteSystem: vi.fn(),
    onNew: vi.fn(),
  };
  const { onNew, ...rowHandlers } = handlers;
  act(() =>
    root.render(
      <DesignSystemsSettingsView
        systems={SYSTEMS}
        systemsError={null}
        problems={[]}
        proposals={[]}
        projects={PROJECTS}
        now={0}
        canWrite
        rescans={{}}
        threadTitleFor={() => null}
        onRescan={() => undefined}
        onOpenProposal={() => undefined}
        figma={{ status: FIGMA_OFF, error: null, checking: false, onCheck: () => undefined }}
        systemHref={(system: DesignSystemSummary) => `/design/systems/pg.${system.ref.systemId}`}
        onNew={onNew}
        {...(wired ? rowHandlers : {})}
        {...extra}
      />,
    ),
  );
  return handlers;
}

describe("Settings design system rows", () => {
  it("link each name to the system's page", async () => {
    const handlers = render();
    const first = SYSTEMS.toSorted((a, b) => a.name.localeCompare(b.name))[0]!;
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="system-link"]')!;
    expect(link.textContent).toBe(first.name);
    expect(link.getAttribute("href")).toBe(`/design/systems/pg.${first.ref.systemId}`);
    await act(async () => link.click());
    expect(handlers.onOpenSystem).toHaveBeenCalledWith(first);
    // A modified click is left to the browser (new tab or window).
    await act(async () =>
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      ),
    );
    expect(handlers.onOpenSystem).toHaveBeenCalledTimes(1);
  });

  it("keep plain names where the page is not wired", () => {
    render({}, false);
    expect(container.querySelector('[data-testid="system-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-row-menu"]')).toBeNull();
  });

  it("offer Open, Rename and Delete in the row menu", async () => {
    const handlers = render();
    const first = SYSTEMS.toSorted((a, b) => a.name.localeCompare(b.name))[0]!;
    await press(container.querySelector<HTMLElement>('[data-testid="system-row-menu"]')!);
    expect(menuItems().map((entry) => entry.label)).toEqual(["Open", "Rename…", "Delete…"]);
    await act(async () =>
      menuItems()
        .find((entry) => entry.label === "Rename…")!
        .item.click(),
    );
    expect(handlers.onRenameSystem).toHaveBeenCalledWith(first);
    await press(container.querySelector<HTMLElement>('[data-testid="system-row-menu"]')!);
    await act(async () =>
      menuItems()
        .find((entry) => entry.label === "Delete…")!
        .item.click(),
    );
    expect(handlers.onDeleteSystem).toHaveBeenCalledWith(first);
  });

  it("offer Start from scratch only where the server can create systems", async () => {
    render({ canStartFromScratch: false });
    await press(container.querySelector<HTMLElement>('[data-testid="new-design-system"]')!);
    expect(menuItems().map((entry) => entry.label)).not.toContain("Start from scratch");
    act(() => root.unmount());
    root = createRoot(container);
    document.body.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove());
    const handlers = render({ canStartFromScratch: true });
    await press(container.querySelector<HTMLElement>('[data-testid="new-design-system"]')!);
    const scratch = menuItems().find((entry) => entry.label === "Start from scratch")!;
    await act(async () => scratch.item.click());
    expect(handlers.onNew).toHaveBeenCalledWith("scratch");
  });
});

describe("Delete design system", () => {
  it("warns with how many designs use it", async () => {
    expect(usageWarning(null, "Atlas web")).toBe("Checking which designs use it…");
    expect(usageWarning(0, "Atlas web")).toBe("No designs in Atlas web use it.");
    expect(usageWarning(1, "Atlas web")).toContain("1 design in Atlas web uses it.");
    const onDelete = vi.fn(async () => null);
    const onClose = vi.fn();
    act(() =>
      root.render(
        <DeleteSystemDialog
          name="Weave"
          ownerLabel="Atlas web"
          designs={3}
          usageError={null}
          onDelete={onDelete}
          onClose={onClose}
        />,
      ),
    );
    await flush();
    const warning = document.querySelector('[data-testid="delete-system-warning"]')!;
    expect(warning.textContent).toContain("3 designs in Atlas web use it.");
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete design system",
    )!;
    await act(async () => confirm.click());
    await flush();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
