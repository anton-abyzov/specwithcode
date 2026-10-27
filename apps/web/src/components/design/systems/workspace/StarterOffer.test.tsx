// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { StarterOffer } from "./StarterOffer";
import type { SystemEditIntent } from "./systemEditIntents";
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
});

const nextFrame = () =>
  act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

function Section({ onEdit }: { onEdit: (intent: SystemEditIntent) => Promise<boolean> }) {
  return (
    <section id="section-spacing">
      <header>
        <button type="button" aria-expanded>
          Spacing
        </button>
      </header>
      <StarterOffer kind="spacing" sectionId="spacing" system={TEST_SYSTEM} onEdit={onEdit} />
    </section>
  );
}

describe("StarterOffer", () => {
  it("moves focus to the section title once the set is added", async () => {
    const onEdit = vi.fn(async () => true);
    act(() => root.render(<Section onEdit={onEdit} />));
    const offer = container.querySelector<HTMLButtonElement>('[data-testid="starter-offer"]')!;
    offer.focus();
    await act(async () => offer.click());
    await nextFrame();
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.textContent).toBe("Spacing");
  });

  it("leaves focus where the person moved it while the edit saved", async () => {
    let finish: (added: boolean) => void = () => undefined;
    const onEdit = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    act(() => root.render(<Section onEdit={onEdit} />));
    const offer = container.querySelector<HTMLButtonElement>('[data-testid="starter-offer"]')!;
    offer.focus();
    await act(async () => offer.click());
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    await act(async () => finish(true));
    await nextFrame();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("leaves focus on another section's offer the person moved to", async () => {
    let finish: (added: boolean) => void = () => undefined;
    const onEdit = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    act(() =>
      root.render(
        <>
          <Section onEdit={onEdit} />
          <section id="section-corners">
            <StarterOffer kind="radius" sectionId="corners" system={TEST_SYSTEM} onEdit={onEdit} />
          </section>
        </>,
      ),
    );
    const [spacing, corners] = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="starter-offer"]',
    );
    spacing!.focus();
    await act(async () => spacing!.click());
    corners!.focus();
    await act(async () => finish(true));
    await nextFrame();
    expect(document.activeElement).toBe(corners);
  });

  it("keeps focus on the offer when the edit fails", async () => {
    const onEdit = vi.fn(async () => false);
    act(() => root.render(<Section onEdit={onEdit} />));
    const offer = container.querySelector<HTMLButtonElement>('[data-testid="starter-offer"]')!;
    offer.focus();
    await act(async () => offer.click());
    await nextFrame();
    expect(document.activeElement).toBe(offer);
  });
});
