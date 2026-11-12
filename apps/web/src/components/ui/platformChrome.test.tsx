// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { applyPlatform, type Platform } from "../../lib/platformConventions";
import { AlertDialogFooter } from "./alert-dialog";
import { DialogFooter } from "./dialog";
import { Kbd } from "./kbd";
import { WizardFooter } from "./wizard";

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
  delete document.documentElement.dataset.platform;
});

function draw(platform: Platform, node: ReactNode) {
  applyPlatform(document.documentElement, platform);
  act(() => root.render(node));
}
const slot = (name: string) => container.querySelector<HTMLElement>(`[data-slot="${name}"]`)!;
const labels = () => [...container.querySelectorAll("button")].map((button) => button.textContent);

describe("Kbd", () => {
  const keys = (
    <>
      <Kbd keyName="enter" />
      <Kbd keyName="tab" />
      <Kbd keyName="escape" />
      <Kbd shortcut="o" />
      <Kbd>/</Kbd>
    </>
  );
  const printed = () => [...container.querySelectorAll("kbd")].map((key) => key.textContent);

  it("prints symbols on macOS", () => {
    draw("macos", keys);
    expect(printed()).toEqual(["↵", "⇥", "esc", "⌘O", "/"]);
  });

  it.each(["windows", "linux"] as const)("prints words on %s", (platform) => {
    draw(platform, keys);
    expect(printed()).toEqual(["Enter", "Tab", "Esc", "Ctrl+O", "/"]);
  });
});

describe("dialog footers", () => {
  const buttons = (
    <>
      <button type="button">Cancel</button>
      <button type="button">Save</button>
    </>
  );

  it.each([
    ["macos", "last"],
    ["linux", "last"],
    ["windows", "first"],
  ] as const)("on %s the default button is drawn %s", (platform, placement) => {
    draw(
      platform,
      <>
        <DialogFooter>{buttons}</DialogFooter>
        <AlertDialogFooter>{buttons}</AlertDialogFooter>
      </>,
    );
    expect(slot("dialog-footer").dataset.defaultButton).toBe(placement);
    expect(slot("alert-dialog-footer").dataset.defaultButton).toBe(placement);
  });

  it("keeps the source order on every system, so focus opens on the same button", () => {
    draw("windows", <AlertDialogFooter>{buttons}</AlertDialogFooter>);
    expect(labels()).toEqual(["Cancel", "Save"]);
  });

  it("leaves a footer alone when it is not a row of buttons", () => {
    draw("windows", <DialogFooter buttonOrder="source">{buttons}</DialogFooter>);
    expect(slot("dialog-footer").dataset.defaultButton).toBeUndefined();
  });

  it("orders only the wizard's buttons when the footer has a leading control", () => {
    draw("windows", <WizardFooter leading={<label>Skip next time</label>}>{buttons}</WizardFooter>);
    expect(slot("dialog-footer").dataset.defaultButton).toBeUndefined();
    expect(slot("wizard-footer-actions").dataset.defaultButton).toBe("first");
    expect(labels()).toEqual(["Cancel", "Save"]);
  });

  it("keeps a wizard step with Back in its source order", () => {
    draw("windows", <WizardFooter buttonOrder="source">{buttons}</WizardFooter>);
    expect(slot("dialog-footer").dataset.defaultButton).toBeUndefined();
  });

  it("orders the whole wizard footer when it holds only buttons", () => {
    draw("windows", <WizardFooter>{buttons}</WizardFooter>);
    expect(slot("dialog-footer").dataset.defaultButton).toBe("first");
  });
});
