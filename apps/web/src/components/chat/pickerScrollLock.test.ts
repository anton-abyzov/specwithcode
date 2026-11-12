// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { allowsPickerOverlayScroll } from "./pickerScrollLock";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("allowsPickerOverlayScroll", () => {
  it("lets the Limits by account view scroll inside the picker popup", () => {
    const root = mount(
      `<div data-model-picker-popup=""><div data-model-picker-secondary=""><section class="sws-machine-limits"><p id="row">Weekly</p></section></div></div>`,
    );
    expect(allowsPickerOverlayScroll(root.querySelector("#row"))).toBe(true);
  });

  it("still blocks the page behind the picker", () => {
    const root = mount(`<main><p id="page">thread</p></main>`);
    expect(allowsPickerOverlayScroll(root.querySelector("#page"))).toBe(false);
    expect(allowsPickerOverlayScroll(null)).toBe(false);
  });

  it("keeps the model list and the Models popover scrollable", () => {
    const root = mount(
      `<div data-model-picker-content=""><i id="a"></i></div><div data-project-models-popover=""><i id="b"></i></div>`,
    );
    expect(allowsPickerOverlayScroll(root.querySelector("#a"))).toBe(true);
    expect(allowsPickerOverlayScroll(root.querySelector("#b"))).toBe(true);
  });
});
