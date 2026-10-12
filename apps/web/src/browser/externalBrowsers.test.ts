import type {
  BrowserLinkTarget,
  ExternalBrowser,
  ExternalBrowserTarget,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canUseExternalBrowsers,
  listExternalBrowsers,
  openLinkOutsideApp,
  openUrlInExternalBrowser,
  resetExternalBrowsersCache,
} from "./externalBrowsers";

const state = vi.hoisted(() => ({
  settings: {
    browserLinkTarget: "system" as BrowserLinkTarget,
    browserExternalTarget: null as ExternalBrowserTarget | null,
  },
  openExternal: vi.fn(async (_url: string) => undefined),
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => state.settings,
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));

const chrome: ExternalBrowser = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Profile 2", name: "Work" }],
};

function stubBridge(bridge: Record<string, unknown> | undefined) {
  vi.stubGlobal("window", { desktopBridge: bridge });
}

beforeEach(() => {
  resetExternalBrowsersCache();
  state.openExternal.mockClear();
  state.settings = { browserLinkTarget: "system", browserExternalTarget: null };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listExternalBrowsers", () => {
  it("is null without the desktop bridge", async () => {
    stubBridge(undefined);
    expect(canUseExternalBrowsers()).toBe(false);
    expect(await listExternalBrowsers()).toBeNull();
  });

  it("is null on older desktop shells that lack the methods", async () => {
    stubBridge({ openExternal: vi.fn() });
    expect(await listExternalBrowsers()).toBeNull();
  });

  it("caches the list until asked to refresh", async () => {
    const list = vi.fn(async () => [chrome]);
    stubBridge({ listExternalBrowsers: list, openInExternalBrowser: vi.fn() });
    expect(await listExternalBrowsers()).toEqual([chrome]);
    await listExternalBrowsers();
    expect(list).toHaveBeenCalledTimes(1);
    await listExternalBrowsers({ refresh: true });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("reads a failed listing as no browsers", async () => {
    stubBridge({
      listExternalBrowsers: vi.fn(async () => Promise.reject(new Error("boom"))),
      openInExternalBrowser: vi.fn(),
    });
    expect(await listExternalBrowsers()).toEqual([]);
  });
});

describe("openUrlInExternalBrowser", () => {
  const target = { browserId: "chrome", profileDirectory: "Profile 2" };

  it("opens the chosen profile", async () => {
    const openInExternalBrowser = vi.fn(async () => true);
    stubBridge({ listExternalBrowsers: vi.fn(), openInExternalBrowser });
    await openUrlInExternalBrowser("https://ads.google.com", target);
    expect(openInExternalBrowser).toHaveBeenCalledWith({ url: "https://ads.google.com", target });
    expect(state.openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the default browser when the launch fails", async () => {
    stubBridge({ listExternalBrowsers: vi.fn(), openInExternalBrowser: vi.fn(async () => false) });
    await openUrlInExternalBrowser("https://ads.google.com", target);
    expect(state.openExternal).toHaveBeenCalledWith("https://ads.google.com");
  });

  it("uses the default browser without a target or bridge", async () => {
    stubBridge(undefined);
    await openUrlInExternalBrowser("https://example.com", target);
    await openUrlInExternalBrowser("https://example.com", null);
    expect(state.openExternal).toHaveBeenCalledTimes(2);
  });
});

describe("openLinkOutsideApp", () => {
  it("follows the saved profile", async () => {
    const openInExternalBrowser = vi.fn(async () => true);
    stubBridge({ listExternalBrowsers: vi.fn(), openInExternalBrowser });
    state.settings = {
      browserLinkTarget: "system",
      browserExternalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
    };
    await openLinkOutsideApp("https://ads.google.com");
    expect(openInExternalBrowser).toHaveBeenCalledOnce();
  });

  it("ignores a stale profile when links open in the app", async () => {
    const openInExternalBrowser = vi.fn(async () => true);
    stubBridge({ listExternalBrowsers: vi.fn(), openInExternalBrowser });
    state.settings = {
      browserLinkTarget: "app",
      browserExternalTarget: { browserId: "chrome" },
    };
    await openLinkOutsideApp("https://example.com");
    expect(openInExternalBrowser).not.toHaveBeenCalled();
    expect(state.openExternal).toHaveBeenCalledWith("https://example.com");
  });
});
