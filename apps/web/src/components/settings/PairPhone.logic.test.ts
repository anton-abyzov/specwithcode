import type { AdvertisedEndpoint } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPhonePairingUrl,
  phonePairingCodeState,
  resolvePhonePairingAddress,
} from "./PairPhone.logic";

function endpoint(
  overrides: Partial<AdvertisedEndpoint> & Pick<AdvertisedEndpoint, "id" | "httpBaseUrl">,
): AdvertisedEndpoint {
  return {
    label: "Endpoint",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    wsBaseUrl: overrides.httpBaseUrl.replace(/^http/u, "ws"),
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  } as AdvertisedEndpoint;
}

describe("resolvePhonePairingAddress", () => {
  it("uses the Tailscale HTTPS endpoint and asks for Tailscale on the phone", () => {
    const address = resolvePhonePairingAddress({
      endpoint: endpoint({
        id: "tailscale-magicdns:https://m4.tail.ts.net/",
        httpBaseUrl: "https://m4.tail.ts.net/",
        reachability: "private-network",
      }),
      currentOrigin: "http://127.0.0.1:8319",
    });
    expect(address).toEqual({ httpBaseUrl: "https://m4.tail.ts.net/", hint: "tailnet" });
  });

  it("uses a LAN endpoint and asks for the same Wi-Fi", () => {
    const address = resolvePhonePairingAddress({
      endpoint: endpoint({
        id: "desktop-lan:192.168.1.5",
        httpBaseUrl: "http://192.168.1.5:8319/",
      }),
      currentOrigin: null,
    });
    expect(address?.hint).toBe("same-network");
  });

  it("uses the address the server reports, preferring its Tailscale HTTPS name", () => {
    expect(
      resolvePhonePairingAddress({
        endpoint: null,
        serverEndpoints: [
          { kind: "lan", httpBaseUrl: "http://192.168.1.5:8319/" },
          { kind: "tailnet", httpBaseUrl: "https://m4.tail.ts.net/" },
        ],
        currentOrigin: "http://127.0.0.1:8319",
      }),
    ).toEqual({ httpBaseUrl: "https://m4.tail.ts.net/", hint: "tailnet" });
    expect(
      resolvePhonePairingAddress({
        endpoint: null,
        serverEndpoints: [{ kind: "lan", httpBaseUrl: "http://192.168.1.5:8319/" }],
        currentOrigin: null,
      }),
    ).toEqual({ httpBaseUrl: "http://192.168.1.5:8319/", hint: "same-network" });
  });

  it("falls back to the page origin when another device can open it", () => {
    expect(
      resolvePhonePairingAddress({ endpoint: null, currentOrigin: "https://m4.tail.ts.net" }),
    ).toEqual({ httpBaseUrl: "https://m4.tail.ts.net", hint: "tailnet" });
  });

  it("has no address when only this computer can reach the server", () => {
    expect(
      resolvePhonePairingAddress({ endpoint: null, currentOrigin: "http://127.0.0.1:8319" }),
    ).toBeNull();
    expect(
      resolvePhonePairingAddress({ endpoint: null, currentOrigin: "studio://app" }),
    ).toBeNull();
    expect(
      resolvePhonePairingAddress({
        endpoint: endpoint({
          id: "desktop-lan:192.168.1.5",
          httpBaseUrl: "http://192.168.1.5:8319/",
          status: "unavailable",
        }),
        currentOrigin: null,
      }),
    ).toBeNull();
  });
});

describe("buildPhonePairingUrl", () => {
  it("links the server's own /pair page with the token in the fragment", () => {
    expect(
      buildPhonePairingUrl({ httpBaseUrl: "https://m4.tail.ts.net/", hint: "tailnet" }, "abc123"),
    ).toBe("https://m4.tail.ts.net/pair#token=abc123");
  });
});

describe("phonePairingCodeState", () => {
  const address = { httpBaseUrl: "https://machine.example.test", hint: "anywhere" as const };
  it("keeps a live code on its original address", () => {
    expect(
      phonePairingCodeState({
        createdAddress: address,
        currentAddress: address,
        expiresAt: 101,
        now: 100,
      }),
    ).toBe("ready");
  });
  it("expires at the server deadline, including after a sleeping tab wakes", () => {
    for (const now of [101, 500]) {
      expect(
        phonePairingCodeState({
          createdAddress: address,
          currentAddress: address,
          expiresAt: 101,
          now,
        }),
      ).toBe("expired");
    }
  });
  it("never repoints an existing credential to a changed or missing route", () => {
    for (const currentAddress of [
      null,
      { ...address, httpBaseUrl: "https://other.example.test" },
    ]) {
      expect(
        phonePairingCodeState({
          createdAddress: address,
          currentAddress,
          expiresAt: 101,
          now: 100,
        }),
      ).toBe("route-changed");
    }
  });
});
