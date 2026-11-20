// @vitest-environment jsdom
import type { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { InlineDeviceApprovalCode, inlineCodeShown } from "./inlineApprovalCode";

vi.mock("./ownDeviceId", () => ({ useOwnDeviceShortId: () => "R2DK" }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machine = "env-work-mac" as EnvironmentId;

/** Stands in for the browser's observer, so a test can say what is on screen. */
class FakeObserver {
  static last: FakeObserver | null = null;
  observed: Element | null = null;
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.last = this;
  }
  observe(element: Element) {
    this.observed = element;
  }
  disconnect() {
    this.observed = null;
  }
  show(ratio: number) {
    const entry = {
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
    } as IntersectionObserverEntry;
    act(() => this.callback([entry], this as unknown as IntersectionObserver));
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <InlineDeviceApprovalCode environmentId={machine} machine="Work Mac" code="K7QX2M" />,
    ),
  );
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  FakeObserver.last = null;
  vi.unstubAllGlobals();
});

describe("an inline code stands in for the floating card only while on screen (1416)", () => {
  it("counts as shown where the browser cannot tell", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    mount();
    expect(inlineCodeShown(machine)).toBe(true);
    act(() => root?.unmount());
    expect(inlineCodeShown(machine)).toBe(false);
  });

  it("lets the floating card back while the code is out of view, and away once it is back", () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    mount();
    const observer = FakeObserver.last!;
    expect(observer.observed?.hasAttribute("data-device-waiting-code")).toBe(true);
    expect(inlineCodeShown(machine)).toBe(true);
    // A collapsed panel that keeps its rows mounted.
    observer.show(0);
    expect(inlineCodeShown(machine)).toBe(false);
    // Half the code peeks out: not readable, the floating card stays.
    observer.show(0.5);
    expect(inlineCodeShown(machine)).toBe(false);
    observer.show(1);
    expect(inlineCodeShown(machine)).toBe(true);
    act(() => root?.unmount());
    expect(inlineCodeShown(machine)).toBe(false);
    expect(observer.observed).toBe(null);
  });
});
