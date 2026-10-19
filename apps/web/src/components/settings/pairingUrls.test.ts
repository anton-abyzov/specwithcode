import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AdvertisedEndpoint } from "@specweave-studio/contracts";

import {
  isShareablePairingUrl,
  resolveAdvertisedEndpointPairingUrl,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:8319", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:8319", "PAIRCODE")).toBe(
      "http://192.168.1.44:8319/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.studio.invalid");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:8319", "PAIRCODE")).toBe(
      "https://preview.studio.invalid/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A8319#token=PAIRCODE",
    );
  });

  it("links the server itself when the build has no hosted app", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "");

    expect(resolveHostedPairingUrl("https://m4.tailnet.ts.net/", "PAIRCODE")).toBeNull();
    expect(
      resolveAdvertisedEndpointPairingUrl(
        {
          id: "tailscale-magicdns:https://m4.tailnet.ts.net/",
          httpBaseUrl: "https://m4.tailnet.ts.net/",
          compatibility: { hostedHttpsApp: "compatible" },
        } as unknown as AdvertisedEndpoint,
        "PAIRCODE",
      ),
    ).toBe("https://m4.tailnet.ts.net/pair#token=PAIRCODE");
  });

  it("shares only links another machine can open", () => {
    expect(isShareablePairingUrl("studio://app/pair#token=PAIRCODE")).toBe(false);
    expect(isShareablePairingUrl("http://127.0.0.1:8319/pair#token=PAIRCODE")).toBe(false);
    expect(isShareablePairingUrl("http://localhost:8319/pair#token=PAIRCODE")).toBe(false);
    expect(isShareablePairingUrl("not a url")).toBe(false);
    expect(isShareablePairingUrl("https://air.tailnet.ts.net/pair#token=PAIRCODE")).toBe(true);
    expect(isShareablePairingUrl("http://192.168.1.44:8319/pair#token=PAIRCODE")).toBe(true);
  });
});
