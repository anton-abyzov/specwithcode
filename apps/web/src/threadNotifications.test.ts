import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetNotificationOwnerForTests, isNotificationOwner } from "./threadNotifications";

beforeEach(() => {
  __resetNotificationOwnerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNotificationOwner", () => {
  it("owns alerts outside a browser window and in the browser", () => {
    expect(isNotificationOwner()).toBe(true);
    vi.stubGlobal("window", {});
    expect(isNotificationOwner()).toBe(true);
  });

  it("owns alerts on a desktop build with a single window", () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    expect(isNotificationOwner()).toBe(true);
  });

  it("owns alerts when the shell cannot answer", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getNotificationOwner: () => {
          throw new Error("shell unavailable");
        },
      },
    });
    expect(isNotificationOwner()).toBe(true);
  });

  it("asks the shell once and then follows its updates", () => {
    let changeOwner: (owner: boolean) => void = () => undefined;
    const getNotificationOwner = vi.fn(() => false);
    const onNotificationOwnerChange = vi.fn((listener: (owner: boolean) => void) => {
      changeOwner = listener;
      return () => undefined;
    });
    vi.stubGlobal("window", { desktopBridge: { getNotificationOwner, onNotificationOwnerChange } });

    expect(isNotificationOwner()).toBe(false);
    expect(isNotificationOwner()).toBe(false);
    expect(getNotificationOwner).toHaveBeenCalledOnce();
    expect(onNotificationOwnerChange).toHaveBeenCalledOnce();

    changeOwner(true);
    expect(isNotificationOwner()).toBe(true);
    changeOwner(false);
    expect(isNotificationOwner()).toBe(false);
    expect(getNotificationOwner).toHaveBeenCalledOnce();
    expect(onNotificationOwnerChange).toHaveBeenCalledOnce();
  });

  it("follows updates from a shell that only announces changes", () => {
    let changeOwner: (owner: boolean) => void = () => undefined;
    vi.stubGlobal("window", {
      desktopBridge: {
        onNotificationOwnerChange: (listener: (owner: boolean) => void) => {
          changeOwner = listener;
          return () => undefined;
        },
      },
    });
    expect(isNotificationOwner()).toBe(true);
    changeOwner(false);
    expect(isNotificationOwner()).toBe(false);
  });
});
