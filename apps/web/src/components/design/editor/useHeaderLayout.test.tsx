// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import type { HeaderLayout } from "./editorLayout";
import { useHeaderLayout } from "./useHeaderLayout";

let root: Root, container: HTMLDivElement;
let resize: ((width: number) => void) | null = null;
const original = globalThis.ResizeObserver;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      resize = (width) =>
        this.callback(
          [{ contentRect: { width } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
    }
    unobserve() {}
    disconnect() {
      resize = null;
    }
  } as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.ResizeObserver = original;
});

it("re-renders only when the header crosses a threshold", () => {
  const seen: HeaderLayout[] = [];
  function Probe() {
    const [ref, layout] = useHeaderLayout();
    seen.push(layout);
    return <header ref={ref} />;
  }
  act(() => root.render(<Probe />));
  act(() => resize!(700));
  const renders = seen.length;
  expect(seen.at(-1)).toMatchObject({ tools: false, crumbs: false });
  // A sidebar animation: many widths, all below the tools threshold.
  for (const width of [701, 705, 710, 715, 719]) act(() => resize!(width));
  expect(seen.length).toBe(renders);
  act(() => resize!(900));
  expect(seen.at(-1)).toMatchObject({ tools: true, crumbs: true });
});
