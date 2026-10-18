// @vitest-environment jsdom
import { DndContext } from "@dnd-kit/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { checkProjectName } from "../../../studio/projectRename";

const requestProjectSettings = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(rest as object)}>{children}</a>
  ),
}));
vi.mock("../../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => children }));
vi.mock("../../../studio/projectSettingsRequests", () => ({ requestProjectSettings }));

const { ProjectRow } = await import("./SidebarProjectList");
type Rename = NonNullable<Parameters<typeof ProjectRow>[0]["rename"]>;

const group = {
  projectKey: "scripts",
  displayName: "Scripts",
  workspaceRoot: "/work/scripts",
  memberProjects: [],
} as unknown as SidebarProjectSnapshot;

const named = [
  { projectKey: "scripts", name: "Scripts", archived: false },
  { projectKey: "specweave", name: "SpecWeave", archived: false },
];

describe("ProjectRow rename", () => {
  let root: Root;
  let container: HTMLDivElement;
  let commit: ReturnType<typeof vi.fn<(name: string) => Promise<string | null>>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commit = vi.fn(async () => null);
    requestProjectSettings.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(rename: Rename | null = defaultRename()) {
    await act(async () =>
      root.render(
        <DndContext>
          <ul>
            <ProjectRow
              group={group}
              displayedProject={undefined}
              archived={false}
              waiting={0}
              current={false}
              onOpen={() => {}}
              onArchive={() => {}}
              sortable
              rename={rename ?? undefined}
            />
          </ul>
        </DndContext>,
      ),
    );
  }
  function defaultRename(): Rename {
    return {
      check: (draft) => checkProjectName({ draft, current: named[0]!, others: named }),
      commit: (name) => commit(name),
    };
  }
  const link = () => container.querySelector<HTMLAnchorElement>("a.sws-side-row");
  const input = () => container.querySelector<HTMLInputElement>("input[aria-label='Project name']");
  const error = () => container.querySelector(".sws-project-rename-error")?.textContent ?? null;

  async function startRename() {
    await act(async () => {
      link()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(input()).not.toBeNull();
  }
  async function type(value: string) {
    const field = input()!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function press(key: string) {
    await act(async () => {
      input()!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  }

  it("turns the name into a focused field on double click", async () => {
    await render();
    await startRename();
    expect(input()!.value).toBe("Scripts");
    expect(document.activeElement).toBe(input());
    expect(container.querySelector("[data-renaming]")).not.toBeNull();
    expect(requestProjectSettings).not.toHaveBeenCalled();
  });

  it("saves a trimmed new name on Enter and shows the row again", async () => {
    await render();
    await startRename();
    await type("  Olysense ");
    await press("Enter");
    expect(commit).toHaveBeenCalledWith("Olysense");
    expect(input()).toBeNull();
    expect(link()).not.toBeNull();
  });

  it("cancels on Escape without saving", async () => {
    await render();
    await startRename();
    await type("Olysense");
    await press("Escape");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    expect(link()!.textContent).toContain("Scripts");
  });

  it("refuses another project's name as it is typed, ignoring case", async () => {
    await render();
    await startRename();
    await type("specweave");
    expect(error()).toBe("Another project is already named “SpecWeave”.");
    expect(input()!.getAttribute("aria-invalid")).toBe("true");
    await press("Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });

  it("refuses an empty name", async () => {
    await render();
    await startRename();
    await type("   ");
    expect(error()).toBe("Enter a name.");
    await press("Enter");
    expect(commit).not.toHaveBeenCalled();
  });

  it("closes without saving when the name is unchanged", async () => {
    await render();
    await startRename();
    await press("Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it("keeps the field open with the server's reason when a save is refused", async () => {
    commit.mockResolvedValueOnce("Another project already has this name. Choose a different one.");
    await render();
    await startRename();
    await type("Tools");
    await press("Enter");
    expect(input()).not.toBeNull();
    expect(input()!.readOnly).toBe(false);
    expect(error()).toBe("Another project already has this name. Choose a different one.");
    await type("Tools 2");
    expect(error()).toBeNull();
  });

  it("offers Rename project in the row menu and focuses the field", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Actions for Scripts']",
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      trigger.click();
    });
    const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
      (node) => node.textContent === "Rename project",
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it("opens settings on double click where the name cannot change", async () => {
    await render(null);
    await act(async () => {
      link()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(input()).toBeNull();
    expect(requestProjectSettings).toHaveBeenCalledWith("scripts");
  });
});
