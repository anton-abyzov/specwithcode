// @vitest-environment jsdom
import type { DesignSystem, EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The files lane's parts read the server; here they only show what they were given.
vi.mock("./FilesBrowser", () => ({
  FilesBrowser: (props: {
    canEdit: boolean;
    onGoToSection: (id: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="files-layer" data-can-edit={String(props.canEdit)}>
      <button type="button" onClick={() => props.onGoToSection("type")}>
        Go to Typography
      </button>
      <button type="button" onClick={() => props.onGoToSection("assets")}>
        Go to Assets
      </button>
      <button type="button" onClick={props.onClose}>
        Close files
      </button>
    </div>
  ),
}));
vi.mock("./AssetsSection", () => ({
  AssetsSection: (props: { systemId: string; canEdit: boolean }) => (
    <div data-testid="assets-body" data-system={props.systemId} />
  ),
}));
vi.mock("./OverviewReadme", () => ({
  OverviewReadme: (props: { systemId: string }) => (
    <div data-testid="readme-body" data-system={props.systemId} />
  ),
}));
vi.mock("./WelcomeSheet", () => ({
  WelcomeSheet: (props: { systemId: string; onChanged?: () => void }) => (
    <button type="button" data-testid="welcome-sheet" onClick={() => props.onChanged?.()}>
      Welcome
    </button>
  ),
}));

const { goToSectionId, SystemWorkspace } = await import("./SystemWorkspace");
const { TEST_SYSTEM } = await import("./testSystem");
type SystemWorkspaceProps = import("./SystemWorkspace").SystemWorkspaceProps;

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

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const button = (text: string) =>
  $$("button").find((candidate) => candidate.textContent?.trim() === text);

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.click();
  });
  await flush();
}

function props(overrides: Partial<SystemWorkspaceProps> = {}): SystemWorkspaceProps {
  return {
    environmentId: "host" as EnvironmentId,
    owner: { kind: "project", projectId: "harbor" as never },
    system: TEST_SYSTEM,
    canEdit: true,
    readOnlyReason: null,
    canManage: true,
    onEdit: vi.fn(async () => true),
    conflict: false,
    onReload: vi.fn(),
    usage: 2,
    fileCount: 5,
    menu: {
      ownerLabel: "Harbor",
      siblings: [],
      storage: null,
      onSwitch: vi.fn(),
      onDuplicate: vi.fn(),
      onOpenSettings: vi.fn(),
      onDelete: vi.fn(async () => null),
    },
    onRename: vi.fn(async () => true),
    hash: "",
    onHashChange: vi.fn(),
    ...overrides,
  };
}

const render = (workspace: SystemWorkspaceProps) =>
  act(() => root.render(<SystemWorkspace {...workspace} />));
const sectionIds = () => $$("section[data-section]").map((section) => section.dataset.section);

describe("SystemWorkspace", () => {
  it("lays the sections out in order, each with a card, and lists them in the nav", () => {
    render(props());
    const ids = sectionIds();
    expect(ids.slice(0, 6)).toEqual(["readme", "colors", "type", "spacing", "corners", "shadows"]);
    expect(ids.slice(-2)).toEqual(["components", "assets"]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "family-duration",
        "family-easing",
        "family-breakpoint",
        "family-zIndex",
        "family-control",
        "family-opacity",
      ]),
    );
    expect($("#section-family-zIndex-title")!.textContent).toBe("Z index");
    expect(
      $$('[data-testid="system-nav"] [data-nav-section]').map((row) => row.dataset.navSection),
    ).toEqual(ids);
    expect($('[data-testid="system-nav-files"]')!.textContent).toBe("Files5");
    // The files lane's bodies get this system.
    expect($('[data-testid="readme-body"]')!.dataset.system).toBe(TEST_SYSTEM.id);
    expect($('[data-testid="assets-body"]')!.dataset.system).toBe(TEST_SYSTEM.id);
  });

  it("shows an editor each empty core section with Add, and hides them from viewers", () => {
    const system: DesignSystem = {
      ...TEST_SYSTEM,
      tokens: TEST_SYSTEM.tokens.filter((token) => token.group !== "spacing"),
      components: [],
    };
    render(props({ system }));
    const spacing = $("#section-spacing")!;
    expect(spacing.textContent).toContain("No spacing values yet.");
    expect(spacing.querySelector('[aria-label="Add to Spacing"]')).not.toBeNull();
    expect($("#section-components")!.textContent).toContain("No components yet.");

    render(props({ system, canEdit: false, readOnlyReason: "This window may not change files." }));
    expect(sectionIds()).not.toContain("spacing");
    expect(sectionIds()).not.toContain("components");
    expect($('[data-testid="system-read-only"]')!.textContent).toContain("Read-only");
    expect($('[data-testid="system-read-only"]')!.title).toBe("This window may not change files.");
    expect($$('[data-testid="section-add"]')).toHaveLength(0);
  });

  it("opens the add dialog from a section's Add", async () => {
    render(props());
    await press($('#section-spacing [data-testid="section-add"]')!);
    expect($('[data-testid="add-token-dialog"]')).not.toBeNull();
  });

  it("asks before removing a mode and its values", async () => {
    const onEdit = vi.fn(async () => true);
    render(props({ onEdit }));
    await press($('[aria-label="Remove mode Dark"]')!);
    const dialog = $('[data-testid="mode-remove-dialog"]')!;
    expect(dialog.textContent).toContain("Remove the Dark mode?");
    expect(dialog.textContent).toMatch(/Its values on \d+ tokens are deleted with it/);
    expect(onEdit).not.toHaveBeenCalled();
    await press($('[data-testid="mode-remove-confirm"]')!);
    expect(onEdit).toHaveBeenCalledWith({ kind: "delete-mode", id: "dark" });
  });

  it("collapses a section from its title", () => {
    render(props());
    const toggle = $("#section-colors button[aria-expanded]")!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect($("#section-colors-body")!.hidden).toBe(true);
    expect($('[data-testid="color-table"]')).toBeNull();
  });

  it("filters the nav to sections and tokens that match", () => {
    render(props());
    const search = $('[aria-label="Search sections and tokens"]') as HTMLInputElement;
    typeInto(search, "tide");
    expect($$("[data-nav-section]").map((row) => row.dataset.navSection)).toEqual([
      "colors",
      "components",
    ]);
    expect($$("[data-nav-item]").map((row) => row.dataset.navItem)).toEqual([
      "tide-high",
      "tide-low",
      "TideChart",
    ]);
    typeInto(search, "zzz");
    expect($('[data-testid="system-nav"]')!.textContent).toContain("No matches for “zzz”");
  });

  it("marks the section the hash names and writes the hash for a nav pick", async () => {
    const workspace = props({ hash: "shadows" });
    render(workspace);
    expect($('[data-nav-section="shadows"]')!.getAttribute("aria-current")).toBe("true");
    await press($('[data-nav-section="family-zIndex"]')!);
    expect(workspace.onHashChange).toHaveBeenCalledWith("family-zIndex");
    expect($('[data-nav-section="family-zIndex"]')!.getAttribute("aria-current")).toBe("true");
  });

  it("goes to a linked section that appears after the first render", () => {
    const noColors = {
      ...TEST_SYSTEM,
      tokens: TEST_SYSTEM.tokens.filter((t) => t.type !== "color"),
    };
    const workspace = props({ hash: "colors", canEdit: false, system: noColors });
    render(workspace);
    expect(sectionIds()).not.toContain("colors");
    render({ ...workspace, system: TEST_SYSTEM });
    expect($('[data-nav-section="colors"]')!.getAttribute("aria-current")).toBe("true");
  });

  it("opens Files over the cards and goes to the section a file is shown in", async () => {
    const workspace = props();
    render(workspace);
    await press($('[data-testid="system-nav-files"]')!);
    const layer = $('[data-testid="files-layer"]')!;
    expect(layer.closest("main")!.className).toContain("relative");
    expect(layer.dataset.canEdit).toBe("true");
    await press(button("Go to Typography")!);
    expect($('[data-testid="files-layer"]')).toBeNull();
    expect(workspace.onHashChange).toHaveBeenLastCalledWith("type");
    await press($('[data-testid="system-nav-files"]')!);
    await press(button("Close files")!);
    expect($('[data-testid="files-layer"]')).toBeNull();
  });

  it("stops editing on a conflict and offers Reload", () => {
    const workspace = props({ conflict: true });
    render(workspace);
    const banner = $('[data-testid="system-conflict"]')!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("This design system changed elsewhere.");
    expect($('[aria-label="Remove space-1"]')).toBeNull();
    act(() => button("Reload")!.click());
    expect(workspace.onReload).toHaveBeenCalledOnce();
  });

  it("keeps an open add dialog and what was typed through a conflict, until Reload", async () => {
    const onEdit = vi.fn(async () => false);
    const workspace = props({ onEdit });
    render(workspace);
    await press($('#section-spacing [data-testid="section-add"]')!);
    const name = document.querySelector<HTMLInputElement>(
      '[data-testid="add-token-dialog"] input',
    )!;
    typeInto(name, "space-9");
    render({ ...workspace, conflict: true });
    const notice = $('[data-testid="dialog-conflict"]')!;
    expect(notice.getAttribute("role")).toBe("alert");
    // The notice sits in the dialog header, outside the scrolling panel.
    expect(notice.closest('[data-slot="dialog-header"]')).not.toBeNull();
    // A change made elsewhere conflicted; this dialog's own Add never ran.
    expect(notice.textContent).toContain("Reload before you add");
    expect(notice.textContent).not.toContain("This was not added.");
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="add-token-submit"]')!.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="add-token-dialog"] input')!.value,
    ).toBe("space-9");
    act(() =>
      [...notice.querySelectorAll("button")].find((b) => b.textContent === "Reload")!.click(),
    );
    expect(workspace.onReload).toHaveBeenCalledOnce();
    render({ ...workspace, conflict: false });
    expect($('[data-testid="dialog-conflict"]')).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="add-token-submit"]')!.disabled,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="add-token-dialog"] input')!.value,
    ).toBe("space-9");
  });

  it("says the Add was not added only when this dialog's own Add was refused", async () => {
    const onEdit = vi.fn(async () => false);
    const workspace = props({ onEdit });
    render(workspace);
    await press($('#section-spacing [data-testid="section-add"]')!);
    typeInto(
      document.querySelector<HTMLInputElement>('[data-testid="add-token-dialog"] input')!,
      "space-9",
    );
    const values = [
      ...document.querySelectorAll<HTMLInputElement>('[data-testid="add-token-dialog"] input'),
    ];
    for (const input of values.slice(1)) typeInto(input, "36px");
    await press($('[data-testid="add-token-submit"]')!);
    expect(onEdit).toHaveBeenCalledOnce();
    render({ ...workspace, conflict: true });
    expect($('[data-testid="dialog-conflict"]')!.textContent).toContain("This was not added.");
    render({ ...workspace, conflict: false });
    render({ ...workspace, conflict: true });
    expect($('[data-testid="dialog-conflict"]')!.textContent).toContain("Reload before you add");
  });

  it("keeps the add dialog when a reload empties the family it was opened on", async () => {
    const workspace = props({ conflict: false });
    render(workspace);
    await press($('#section-family-zIndex [data-testid="section-add"]')!);
    typeInto(
      document.querySelector<HTMLInputElement>('[data-testid="add-token-dialog"] input')!,
      "z-modal",
    );
    const emptied = {
      ...TEST_SYSTEM,
      revision: TEST_SYSTEM.revision + 1,
      tokens: TEST_SYSTEM.tokens.filter((token) => token.name !== "z-float"),
    };
    render({ ...workspace, system: emptied });
    expect($("#section-family-zIndex")).toBeNull();
    const dialog = $('[data-testid="add-token-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector<HTMLInputElement>("input")!.value).toBe("z-modal");
  });

  it("welcomes an empty system on Overview", () => {
    const onChanged = vi.fn();
    render(props({ system: { ...TEST_SYSTEM, tokens: [], components: [] }, onChanged }));
    const welcome = $('#section-readme [data-testid="welcome-sheet"]')!;
    act(() => welcome.click());
    expect(onChanged).toHaveBeenCalledOnce();
    render(props());
    expect($('[data-testid="welcome-sheet"]')).toBeNull();
  });

  it("renames the system from the menu", async () => {
    const workspace = props();
    render(workspace);
    await press($('[aria-label="Design system menu"]')!);
    await press(
      $$('[role="menuitem"]').find((element) => element.textContent?.includes("Rename"))!,
    );
    const input = $('[aria-label="Design system name"]') as HTMLInputElement;
    typeInto(input, "Harbor UI 2");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(workspace.onRename).toHaveBeenCalledWith("Harbor UI 2");
    expect($("h1")!.textContent).toBe("Harbor UI");
  });
});

describe("goToSectionId", () => {
  it("maps the files lane's ids onto the sections shown", () => {
    const shown = ["readme", "colors", "type", "assets"] as const;
    expect(goToSectionId("readme", shown)).toBe("readme");
    expect(goToSectionId("type", shown)).toBe("type");
    expect(goToSectionId("assets", shown)).toBe("assets");
    expect(goToSectionId("overview", shown)).toBe("readme");
    expect(goToSectionId("typography", shown)).toBe("type");
    expect(goToSectionId("corners", shown)).toBeNull();
    expect(goToSectionId("../x", shown)).toBeNull();
  });
});
