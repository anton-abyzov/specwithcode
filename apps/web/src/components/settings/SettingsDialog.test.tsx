// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SettingsDialog } from "./SettingsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement;
const onClose = vi.fn();

beforeEach(async () => {
  onClose.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <SettingsDialog nav={<nav>Sections</nav>} header={<span>General</span>} onClose={onClose}>
        <button type="button">Inside</button>
      </SettingsDialog>,
    );
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const dialog = () => document.querySelector<HTMLElement>("[data-settings-dialog]")!;
const viewport = () => document.querySelector<HTMLElement>('[data-slot="settings-viewport"]')!;

function press(target: Element) {
  target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("SettingsDialog", () => {
  it("renders a labelled modal with a close button", () => {
    expect(dialog().getAttribute("role")).toBe("dialog");
    expect(document.querySelectorAll('[aria-label="Close settings"]').length).toBeGreaterThan(0);
  });

  it("closes from the close button", async () => {
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Close settings"]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    await act(async () => {
      dialog().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when a later document listener consumes Escape", async () => {
    const consume = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", consume);
    try {
      await act(async () => {
        dialog().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    } finally {
      document.removeEventListener("keydown", consume);
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a click on the dimmed area but not inside", async () => {
    await act(async () => press(dialog().querySelector("button:not([aria-label])")!));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => press(viewport()));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a drag that starts inside and ends on the dimmed area", async () => {
    await act(async () => {
      dialog().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      viewport().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
