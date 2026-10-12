import type { DesktopBridge } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient } from "effect/http";

import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "./httpLayer";

describe("primary environment HTTP layer", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("uses cookie credentials for browser primary environments", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:8319/settings",
          origin: "http://127.0.0.1:8319",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:8319/api/auth/session");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("uses bearer auth without cookies for desktop-managed primaries", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "studio://app" },
        desktopBridge: {
          getLocalEnvironmentBootstrap: () => ({
            label: "Local environment",
            httpBaseUrl: "http://127.0.0.1:8319",
            wsBaseUrl: "ws://127.0.0.1:8319",
            bootstrapToken: "desktop-bootstrap-token",
          }),
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:8319/api/connect/link-state");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("turns a rejected desktop bearer request into a typed, retryable failure", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("stored bearer validation unavailable"))
      .mockResolvedValue("desktop-bearer-token");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "studio://app" },
        desktopBridge: { getLocalEnvironmentBearerToken } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      const failed = yield* Effect.exit(
        HttpClient.get("http://127.0.0.1:8319/.well-known/studio/environment"),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        // A defect would escape Effect.option/mapError in callers; a typed failure does not.
        expect(Cause.hasDies(failed.cause)).toBe(false);
        expect(Cause.hasFails(failed.cause)).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();

      yield* HttpClient.get("http://127.0.0.1:8319/.well-known/studio/environment");
      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });
});
