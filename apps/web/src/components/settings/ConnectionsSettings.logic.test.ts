import type { AdvertisedEndpoint, DesktopWslState } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  canDisableTailscaleHttpsEndpoint,
  canRevokeOtherClients,
  isQrShareableEndpoint,
  isWslSettingsRowVisible,
  resolveTailscaleHttpsRowState,
  revokeClientSessions,
  selectQrEndpointOption,
  togglePairingScopeSelection,
  UNUSED_CLIENT_AFTER_MS,
  unusedClientSessions,
  type UnusedClientCandidate,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("isWslSettingsRowVisible", () => {
  it("shows the retry row when the WSL state failed to load", () => {
    expect(isWslSettingsRowVisible({ state: null, error: "load failed" })).toBe(true);
  });

  it("hides an unavailable and unused WSL snapshot", () => {
    expect(
      isWslSettingsRowVisible({
        state: { ...baseWslState, available: false, wslOnly: false },
        error: null,
      }),
    ).toBe(false);
  });

  it("shows an available WSL snapshot", () => {
    expect(isWslSettingsRowVisible({ state: baseWslState, error: null })).toBe(true);
  });
});

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("isQrShareableEndpoint", () => {
  it("excludes loopback endpoints so a scanned phone never dials itself", () => {
    expect(
      isQrShareableEndpoint(
        makeEndpoint({
          id: "desktop-loopback:4780",
          reachability: "loopback",
          httpBaseUrl: "http://127.0.0.1:4780",
        }),
      ),
    ).toBe(false);
  });

  it("excludes unavailable endpoints and keeps reachable ones", () => {
    expect(isQrShareableEndpoint(makeEndpoint({ status: "unavailable" }))).toBe(false);
    expect(isQrShareableEndpoint(makeEndpoint({}))).toBe(true);
    expect(
      isQrShareableEndpoint(makeEndpoint({ reachability: "private-network", status: "unknown" })),
    ).toBe(true);
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("falls back to the saved default preference key when nothing is selected", () => {
    expect(selectQrEndpointOption(options, null, "desktop-core:lan:http")?.id).toBe(
      "desktop-lan:http://192.168.1.42:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });

  it("returns the first option when nothing is QR-shareable, and null when empty", () => {
    const loopbackOnly = options.slice(0, 1);
    expect(selectQrEndpointOption(loopbackOnly, null, null)?.id).toBe("desktop-loopback:4780");
    expect(selectQrEndpointOption([], "anything", "anything")).toBeNull();
  });
});

describe("canRevokeOtherClients", () => {
  it("permits revocation when a write-only grant cannot list clients", () => {
    expect(canRevokeOtherClients(null)).toBe(true);
  });

  it("disables revocation only when a loaded list has no other clients", () => {
    expect(canRevokeOtherClients([])).toBe(false);
    expect(canRevokeOtherClients([{ current: true }])).toBe(false);
    expect(canRevokeOtherClients([{ current: true }, { current: false }])).toBe(true);
  });
});

describe("resolveTailscaleHttpsRowState", () => {
  const endpoint = (overrides: Partial<AdvertisedEndpoint> = {}): AdvertisedEndpoint => ({
    id: "tailscale-magicdns:https://desktop.tail.ts.net/",
    label: "Tailscale HTTPS",
    provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
    httpBaseUrl: "https://desktop.tail.ts.net/",
    wsBaseUrl: "wss://desktop.tail.ts.net/",
    reachability: "private-network",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "desktop-addon",
    status: "available",
    ...overrides,
  });

  it("asks the user to check before Studio reads Tailscale", () => {
    expect(resolveTailscaleHttpsRowState({ endpoint: null, tailscaleChecked: false })).toEqual({
      kind: "unchecked",
    });
  });

  it("reports Tailscale as not found once it was read, or on older desktops", () => {
    expect(resolveTailscaleHttpsRowState({ endpoint: null, tailscaleChecked: true }).kind).toBe(
      "not-found",
    );
    expect(
      resolveTailscaleHttpsRowState({ endpoint: null, tailscaleChecked: undefined }).kind,
    ).toBe("not-found");
  });

  it("separates routes set up outside Studio from Studio's own", () => {
    expect(
      resolveTailscaleHttpsRowState({
        endpoint: endpoint({ managedOutsideStudio: true }),
        tailscaleChecked: true,
      }).kind,
    ).toBe("outside-studio");
    expect(
      resolveTailscaleHttpsRowState({
        endpoint: endpoint({ managedOutsideStudio: true, status: "unavailable" }),
        tailscaleChecked: true,
      }).kind,
    ).toBe("outside-studio-unreachable");
    expect(
      resolveTailscaleHttpsRowState({ endpoint: endpoint(), tailscaleChecked: true }).kind,
    ).toBe("on");
    expect(
      resolveTailscaleHttpsRowState({
        endpoint: endpoint({ status: "unavailable" }),
        tailscaleChecked: true,
      }).kind,
    ).toBe("off");
  });

  it("never offers to turn off a route set up outside Studio", () => {
    expect(canDisableTailscaleHttpsEndpoint(endpoint())).toBe(true);
    expect(canDisableTailscaleHttpsEndpoint(endpoint({ managedOutsideStudio: true }))).toBe(false);
    expect(canDisableTailscaleHttpsEndpoint(endpoint({ status: "unavailable" }))).toBe(false);
  });
});

describe("unusedClientSessions", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const old = new Date(now - UNUSED_CLIENT_AFTER_MS - 60_000).toISOString();
  const recent = new Date(now - 60 * 60_000).toISOString();
  const session = (overrides: Partial<UnusedClientCandidate> = {}): UnusedClientCandidate => ({
    sessionId: "session",
    subject: "one-time-token",
    label: "1068 installed check headless",
    deviceType: "desktop",
    issuedAt: old,
    lastConnectedAt: old,
    connected: false,
    current: false,
    ...overrides,
  });
  const ids = (sessions: ReadonlyArray<UnusedClientCandidate>) =>
    unusedClientSessions(sessions, now).map((entry) => entry.sessionId);

  it("offers a paired computer sign-in that has not connected for a day", () => {
    expect(ids([session()])).toEqual(["session"]);
    expect(ids([session({ subject: "device-approval" })])).toEqual(["session"]);
  });

  it("counts a sign-in that never connected from when it was issued", () => {
    expect(ids([session({ lastConnectedAt: null })])).toEqual(["session"]);
    expect(ids([session({ lastConnectedAt: null, issuedAt: recent })])).toEqual([]);
  });

  it("keeps this app, a connected client and anything used within a day", () => {
    expect(ids([session({ current: true })])).toEqual([]);
    expect(ids([session({ connected: true })])).toEqual([]);
    expect(ids([session({ lastConnectedAt: recent })])).toEqual([]);
  });

  it("keeps phones, the fleet's machines, their keys, worker grants and Connect", () => {
    expect(ids([session({ label: "iPhone", deviceType: "mobile" })])).toEqual([]);
    expect(ids([session({ label: "iPad", deviceType: "tablet" })])).toEqual([]);
    expect(ids([session({ label: "Private fleet browser" })])).toEqual([]);
    expect(ids([session({ label: undefined })])).toEqual(["session"]);
    expect(ids([session({ subject: "fleet-invitation", lastConnectedAt: null })])).toEqual([]);
    expect(ids([session({ subject: "mcp-client", lastConnectedAt: null })])).toEqual([]);
    expect(ids([session({ subject: "cloud-connect", lastConnectedAt: null })])).toEqual([]);
  });

  it("does not take an unreadable time as proof of disuse", () => {
    expect(ids([session({ lastConnectedAt: "not a time" })])).toEqual([]);
  });
});

describe("revokeClientSessions", () => {
  it("revokes every sign-in, a few at a time", async () => {
    let running = 0;
    let most = 0;
    const revoke = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
    });
    const result = await revokeClientSessions(["a", "b", "c", "d", "e"], revoke, 2);
    expect(result).toEqual({ revoked: 5, failed: 0, error: null });
    expect(revoke).toHaveBeenCalledTimes(5);
    expect(most).toBe(2);
  });

  it("goes on after a failure and reports the first message", async () => {
    const revoke = vi.fn(async (sessionId: string) => {
      if (sessionId !== "a") throw new Error(`refused ${sessionId}`);
    });
    expect(await revokeClientSessions(["a", "b", "c"], revoke, 1)).toEqual({
      revoked: 1,
      failed: 2,
      error: "refused b",
    });
  });
});
