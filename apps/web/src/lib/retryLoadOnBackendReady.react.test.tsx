// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ARTIFACT_APP_LOAD_RETRY_MS, useRetryLoadOnBackendReady } from "./retryLoadOnBackendReady";

function ErrorView({ loadFailed, retry }: { loadFailed: boolean; retry: () => void }) {
  useRetryLoadOnBackendReady(loadFailed, retry);
  return null;
}

let root: Root;
let listeners: Set<() => void>;
let windowRole: string;

const backendReady = () => {
  for (const listener of [...listeners]) listener();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners = new Set();
  windowRole = "main";
  vi.stubGlobal("desktopBridge", {
    getWindowRole: () => windowRole,
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

  it("retries on a timer in an installed page's window, which hears no backend-ready", async () => {
    vi.useFakeTimers();
    try {
      windowRole = "artifact-app";
      const retry = vi.fn();
      await act(async () => root.render(<ErrorView loadFailed retry={retry} />));
      vi.advanceTimersByTime(ARTIFACT_APP_LOAD_RETRY_MS * 2);
      expect(retry).toHaveBeenCalledTimes(2);

      await act(async () => root.render(<ErrorView loadFailed={false} retry={retry} />));
      vi.advanceTimersByTime(ARTIFACT_APP_LOAD_RETRY_MS * 2);
      expect(retry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll in an app window", async () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      await act(async () => root.render(<ErrorView loadFailed retry={retry} />));
      vi.advanceTimersByTime(ARTIFACT_APP_LOAD_RETRY_MS * 3);
      expect(retry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
