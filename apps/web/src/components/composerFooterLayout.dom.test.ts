// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { measureScrollToEndClearance, publishChatPanelHeight } from "./composerFooterLayout";

describe("measureScrollToEndClearance", () => {
  const box = (top: number, left = 0, right = 400) =>
    ({ top, bottom: top + 20, left, right, width: right - left, height: 20 }) as DOMRect;

  it("finds the pill by its data attribute whatever its label says", () => {
    const panel = document.createElement("div");
    panel.innerHTML = `
      <button data-jump-to-latest aria-label="Zum Neuesten springen"></button>
      <div data-overlay>
        <div data-composer-banner-surface="attached"></div>
        <div data-chat-composer-main-surface="true"></div>
      </div>`;
    const overlay = panel.querySelector<HTMLElement>("[data-overlay]")!;
    const rects = new Map<Element, DOMRect>([
      [panel.querySelector("[data-jump-to-latest]")!, box(100, 150, 250)],
      [panel.querySelector('[data-composer-banner-surface="attached"]')!, box(300)],
      [panel.querySelector('[data-chat-composer-main-surface="true"]')!, box(400)],
    ]);
    for (const [element, rect] of rects) element.getBoundingClientRect = () => rect;
    // The card spans the pill's column, so the pill clears the whole overlay.
    expect(measureScrollToEndClearance(overlay, 220)).toBe(220);
    // Without a pill, the whole overlay is cleared too.
    panel.querySelector("[data-jump-to-latest]")!.remove();
    expect(measureScrollToEndClearance(overlay, 220)).toBe(220);
  });
});

describe("publishChatPanelHeight", () => {
  it("writes the panel's height for the cards above the composer", () => {
    const panel = document.createElement("div");
    panel.getBoundingClientRect = () => ({ height: 655.6 }) as DOMRect;
    publishChatPanelHeight(panel);
    expect(panel.style.getPropertyValue("--chat-panel-height")).toBe("656px");
    publishChatPanelHeight(null);
  });
});
