import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  finishedFollowUp,
  forgetLackedRelease,
  forgetSavedFollowUp,
  forgetSavedLackedRelease,
  forgetSavedOwnRequest,
  readLackedRelease,
  readSavedFollowUp,
  rememberLackedRelease,
  saveFollowUp,
  saveLackedRelease,
  saveOwnRequest,
  servesRelease,
} from "./serviceUpdateMemory";

// What a window keeps of "Update now" in its sessionStorage for a reload.

beforeEach(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});

afterEach(() => {
  forgetLackedRelease();
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

/** A window's sessionStorage, empty. */
function useSessionStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

describe("a window's saved update", () => {
  it("stays the window's own when its storage refuses to save or forget", () => {
    const refuse = () => {
      throw new Error("The quota has been exceeded.");
    };
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: () => null,
      setItem: refuse,
      removeItem: refuse,
    };
    expect(() => saveFollowUp({ appVersion: "0.2.5", serviceVersion: "0.2.5" })).not.toThrow();
    expect(() => saveFollowUp(null)).not.toThrow();
    expect(() => forgetSavedFollowUp()).not.toThrow();
    expect(() => saveLackedRelease("0.2.5")).not.toThrow();
    expect(() => forgetSavedLackedRelease()).not.toThrow();
    expect(() =>
      saveOwnRequest({
        version: "0.2.5",
        holdUntil: "2026-10-20T10:15:00.000Z",
        holdAskedAgain: false,
        held: false,
        refusedAgain: false,
      }),
    ).not.toThrow();
    expect(() => forgetSavedOwnRequest()).not.toThrow();
    expect(readSavedFollowUp()).toBeNull();
  });
});

const upToDate: StudioServiceUpdateState = {
  status: "up-to-date",
  identity: "m4",
  installedVersion: "0.2.4",
  availableVersion: null,
  downloadedVersion: null,
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

describe("a release the service's agent lacked", () => {
  it("is served once the service runs it or a newer release", () => {
    expect(servesRelease(upToDate, "0.2.5")).toBe(false);
    expect(servesRelease({ ...upToDate, installedVersion: "0.2.5" }, "0.2.5")).toBe(true);
    expect(servesRelease({ ...upToDate, installedVersion: "0.2.6" }, "0.2.5")).toBe(true);
  });

  it("is kept when a later failure names no version", () => {
    useSessionStorage();
    rememberLackedRelease("0.2.5");
    rememberLackedRelease(null);
    expect(readLackedRelease()).toBe("0.2.5");
  });
});

describe("the app's install a reloaded window saved", () => {
  it("is not taken as due when neither it nor the service names a version", () => {
    useSessionStorage();
    saveFollowUp({ appVersion: "0.2.5", serviceVersion: null });
    // An agent that cannot say which version the service runs now.
    const installed: StudioServiceUpdateState = {
      ...upToDate,
      status: "installed",
      installedVersion: null,
      lastInstall: {
        version: "0.2.5",
        at: new Date(Date.now() + 1_000).toISOString(),
        result: "updated",
      },
    };
    expect(finishedFollowUp(installed)).toBeNull();
  });
});
