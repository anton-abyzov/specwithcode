import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  finishedFollowUp,
  forgetAnsweredFollowUp,
  forgetLackedRelease,
  forgetSavedFollowUp,
  forgetSavedLackedRelease,
  forgetSavedOwnRequest,
  readLackedRelease,
  readSavedFollowUp,
  readSavedOwnRequest,
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
        refused: false,
        holdAskedAgain: false,
        held: false,
        refusedAgain: false,
        askedUnderHoldAt: null,
      }),
    ).not.toThrow();
    expect(() => forgetSavedOwnRequest()).not.toThrow();
    expect(readSavedFollowUp()).toBeNull();
  });
});

describe("the window's own request a reload takes up", () => {
  it("keeps whether the work was held for it and when it was asked again under a hold", () => {
    useSessionStorage();
    const request = {
      version: "0.2.5",
      holdUntil: "2026-10-20T10:15:00.000Z",
      refused: true,
      holdAskedAgain: true,
      held: true,
      refusedAgain: false,
      askedUnderHoldAt: Date.parse("2026-10-20T10:01:00.000Z"),
    };
    saveOwnRequest(request);
    expect(readSavedOwnRequest()).toEqual(request);
    // Saved by a window that kept less: nothing was refused or asked again.
    sessionStorage.setItem(
      "specwithcode.serviceUpdate.ownRequest",
      JSON.stringify({ version: "0.2.5", holdUntil: request.holdUntil }),
    );
    expect(readSavedOwnRequest()).toEqual({
      version: "0.2.5",
      holdUntil: request.holdUntil,
      refused: false,
      holdAskedAgain: false,
      held: false,
      refusedAgain: false,
      askedUnderHoldAt: null,
    });
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

  it("is forgotten once the agent installs for no request, after it was saved", () => {
    useSessionStorage();
    saveFollowUp({ appVersion: "0.2.5", serviceVersion: "0.2.5" });
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const installing: StudioServiceUpdateState = {
      ...upToDate,
      status: "installing",
      updatedAt: at(1_000),
      pendingInstall: null,
    };
    // Written before the press: not the agent's answer to it.
    forgetAnsweredFollowUp({ ...installing, updatedAt: at(-1_000) });
    expect(readSavedFollowUp()).not.toBeNull();
    // The press's own request, which the agent installs for.
    const pendingInstall = {
      requestedAt: at(0),
      mode: "force" as const,
      version: "0.2.5",
      holdUntil: at(15 * 60_000),
      handled: true,
    };
    forgetAnsweredFollowUp({ ...installing, pendingInstall });
    expect(readSavedFollowUp()).not.toBeNull();
    forgetAnsweredFollowUp(installing);
    expect(readSavedFollowUp()).toBeNull();
  });

  it("is kept while the service still holds the work for a request the desktop no longer reports", () => {
    useSessionStorage();
    saveFollowUp({ appVersion: "0.2.5", serviceVersion: "0.2.5" });
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    // The request's hold ended unstarted, while the agent's last snapshot for it still runs.
    const snapshotting: StudioServiceUpdateState = {
      ...upToDate,
      status: "waiting-for-quiet",
      availableVersion: "0.2.5",
      downloadedVersion: "0.2.5",
      updatedAt: at(1_000),
      pendingInstall: null,
    };
    forgetAnsweredFollowUp(snapshotting, true);
    expect(readSavedFollowUp()).not.toBeNull();
    // Nothing said yet of whether the service holds it.
    forgetAnsweredFollowUp(snapshotting);
    expect(readSavedFollowUp()).not.toBeNull();
    // The service holds nothing: the request was withdrawn, or lapsed.
    forgetAnsweredFollowUp(snapshotting, false);
    expect(readSavedFollowUp()).toBeNull();
  });
});
