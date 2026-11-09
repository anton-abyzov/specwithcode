// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRetryLoadOnBackendReady } from "./retryLoadOnBackendReady";

function ErrorView({ loadFailed, retry }: { loadFailed: boolean; retry: () => void }) {
  useRetryLoadOnBackendReady(loadFailed, retry);
  return null;
}

let root: Root;
let listeners: Set<() => void>;

const backendReady = () => {
  for (const listener of [...listeners]) listener();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners = new Set();
  vi.stubGlobal("desktopBridge", {
    onBackendReady: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("useRetryLoadOnBackendReady", () => {
  it("retries a failed load each time the backend answers again, until unmounted", async () => {
    const retry = vi.fn();
    await act(async () => root.render(<ErrorView loadFailed retry={retry} />));
    backendReady();
    backendReady();
    expect(retry).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
    backendReady();
    expect(retry).toHaveBeenCalledTimes(2);
    root = createRoot(document.createElement("div"));
  });

  it("leaves a render error alone", async () => {
    const retry = vi.fn();
    await act(async () => root.render(<ErrorView loadFailed={false} retry={retry} />));
    expect(listeners.size).toBe(0);
    backendReady();
    expect(retry).not.toHaveBeenCalled();
  });
});
