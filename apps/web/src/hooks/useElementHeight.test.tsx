// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useElementHeight } from "./useElementHeight";

let observers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];

class FakeResizeObserver {
  private entry: { callback: ResizeObserverCallback; target: Element | null };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, target: null };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.target = target;
  }
  disconnect() {
    observers = observers.filter((entry) => entry !== this.entry);
  }
  unobserve() {}
}

function setHeight(element: Element, height: number) {
  element.getBoundingClientRect = () => ({ height }) as DOMRect;
}

describe("useElementHeight", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    observers = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the element height and follows resizes, back to 0 on unmount", () => {
    const seen: number[] = [];
    let measured: HTMLDivElement | null = null;
    function Probe({ show }: { show: boolean }) {
      const [ref, height] = useElementHeight<HTMLDivElement>();
      seen.push(height);
      return show ? (
        <div
          ref={(node) => {
            if (node) {
              measured = node;
              setHeight(node, 68.4);
            }
            ref(node);
          }}
        />
      ) : null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Probe show />));
    expect(seen.at(-1)).toBe(68);

    act(() => {
      setHeight(measured!, 120);
      for (const entry of observers) entry.callback([], {} as ResizeObserver);
    });
    expect(seen.at(-1)).toBe(120);

    act(() => root.render(<Probe show={false} />));
    expect(seen.at(-1)).toBe(0);
    expect(observers).toHaveLength(0);
    act(() => root.unmount());
  });
});
