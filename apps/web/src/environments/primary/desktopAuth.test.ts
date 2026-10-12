import type { DesktopBridge } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { __resetDesktopPrimaryAuthForTests, readDesktopPrimaryBearerToken } from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });

  it("retries a rejected main-process credential request and then caches its success", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("stored bearer validation unavailable"))
      .mockResolvedValue("validated-bearer");
    window.desktopBridge = { getLocalEnvironmentBearerToken } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).rejects.toThrow("validation unavailable");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("validated-bearer");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("validated-bearer");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });
});
