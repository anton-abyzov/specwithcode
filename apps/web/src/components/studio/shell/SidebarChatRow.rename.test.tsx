// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { checkChatTitle } from "../../../studio/threadTitles";

vi.mock("./Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => children }));

const { SidebarChatRow } = await import("./SidebarChatRow");
type Rename = NonNullable<Parameters<typeof SidebarChatRow>[0]["rename"]>;

describe("SidebarChatRow rename", () => {
  let root: Root;
  let container: HTMLDivElement;
  let commit: ReturnType<typeof vi.fn<(title: string) => Promise<string | null>>>;
  let open: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commit = vi.fn(async () => null);
    open = vi.fn();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(rename: Rename | null = defaultRename(), title = "Plan storage") {
    await act(async () =>
      root.render(
        <ul>
          <SidebarChatRow
            title={title}
            tone="idle"
            tip={title}
            current={false}
            icon={<span data-icon />}
            menuItems={null}
            onOpen={open}
            rename={rename ?? undefined}
          />
        </ul>,
      ),
    );
  }
  function defaultRename(current = "Plan storage"): Rename {
    return {
      check: (draft) => checkChatTitle(draft, current),
      commit: (title) => commit(title),
    };
  }
  const row = () => container.querySelector<HTMLButtonElement>("button.sws-side-row");
  const input = () => container.querySelector<HTMLInputElement>("input[aria-label='Chat name']");
  const error = () => container.querySelector(".sws-project-rename-error")?.textContent ?? null;

  async function doubleClick() {
    await act(async () => {
      row()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
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

  it("opens the chat on a single click", async () => {
    await render();
    await act(async () => row()!.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(input()).toBeNull();
  });

  it("turns the title into a focused field on double click", async () => {
    await render();
    await doubleClick();
    expect(input()!.value).toBe("Plan storage");
    expect(document.activeElement).toBe(input());
    expect(container.querySelector("li[data-renaming]")).not.toBeNull();
  });

  it("saves a trimmed new title on Enter and returns focus to the row", async () => {
    await render();
    await doubleClick();
    await type("  External drive layout ");
    await press("Enter");
    expect(commit).toHaveBeenCalledWith("External drive layout");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(row());
  });

  it("saves a valid new title when the field loses focus", async () => {
    await render();
    await doubleClick();
    await type("Drive layout");
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      input()!.blur();
    });
    expect(commit).toHaveBeenCalledWith("Drive layout");
    expect(input()).toBeNull();
  });

  it("keeps editing when the opened chat's composer takes focus by itself", async () => {
    // jsdom's window never has focus; the app's does.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    await render();
    await doubleClick();
    await type("Drive layout");
    await act(async () => composer.focus());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(commit).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input()!.value).toBe("Drive layout");
    composer.remove();
    vi.restoreAllMocks();
  });

  it("cancels on Escape without saving", async () => {
    await render();
    await doubleClick();
    await type("Something else");
    await press("Escape");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    expect(row()!.textContent).toContain("Plan storage");
  });

  it("refuses an empty title and keeps the field open on Enter", async () => {
    await render();
    await doubleClick();
    await type("   ");
    expect(error()).toBe("Enter a name.");
    await press("Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });

  it("closes without saving when the title is unchanged", async () => {
    await render();
    await doubleClick();
    await press("Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it("keeps the field open with the server's reason when a save is refused", async () => {
    commit.mockResolvedValueOnce("Thread not found.");
    await render();
    await doubleClick();
    await type("Renamed");
    await press("Enter");
    expect(input()).not.toBeNull();
    expect(error()).toBe("Thread not found.");
  });

  it("edits an untitled chat from an empty field without an error", async () => {
    await render(defaultRename(""), "");
    expect(row()!.textContent).toContain("Untitled chat");
    await doubleClick();
    expect(input()!.value).toBe("");
    expect(error()).toBeNull();
    expect(input()!.getAttribute("aria-invalid")).toBeNull();
    await press("Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it("saves when the person tabs away", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await render();
    await doubleClick();
    await type("Drive layout");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      input()!.blur();
    });
    expect(commit).toHaveBeenCalledWith("Drive layout");
    vi.restoreAllMocks();
  });

  it("gives focus back at most three times, then treats the next loss as leaving", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const other = document.createElement("textarea");
    document.body.append(other);
    await render();
    await doubleClick();
    await type("Drive layout");
    for (let steal = 0; steal < 3; steal++) {
      await act(async () => other.focus());
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(document.activeElement).toBe(input());
    }
    await act(async () => other.focus());
    expect(commit).toHaveBeenCalledWith("Drive layout");
    other.remove();
    vi.restoreAllMocks();
  });

  it("ends the edit for good when renaming stops being allowed", async () => {
    await render();
    await doubleClick();
    await render(null);
    expect(input()).toBeNull();
    expect(container.querySelector("li[data-renaming]")).toBeNull();
    await render();
    expect(input()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("offers Rename in the row menu and focuses the field", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Actions for Plan storage']",
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      trigger.click();
    });
    const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
      (node) => node.textContent === "Rename",
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it("leaves a coordinator-named chat as it is on double click", async () => {
    await render(null);
    await doubleClick();
    expect(input()).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Actions for Plan storage']",
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      trigger.click();
    });
    const items = [...document.querySelectorAll("[role='menuitem']")].map((n) => n.textContent);
    expect(items).toContain("Open");
    expect(items).not.toContain("Rename");
  });
});
