import type { AdvertisedEndpoint, ServerDirectEndpoint } from "@specweave-studio/contracts";

import {
  isShareablePairingUrl,
  isTailscaleHttpsEndpoint,
  resolveDesktopPairingUrl,
} from "./pairingUrls";

export type PhoneNetworkHint = "tailnet" | "same-network" | "anywhere";

export interface PhonePairingAddress {
  /** Origin the phone dials, shown so the owner can tell which address the code holds. */
  readonly httpBaseUrl: string;
  readonly hint: PhoneNetworkHint;
}

function hintFor(endpoint: AdvertisedEndpoint | null, httpBaseUrl: string): PhoneNetworkHint {
  if (endpoint !== null) {
    if (isTailscaleHttpsEndpoint(endpoint) || endpoint.reachability === "private-network") {
      return "tailnet";
    }
    if (endpoint.reachability === "lan") return "same-network";
    return "anywhere";
  }
  try {
    return new URL(httpBaseUrl).hostname.endsWith(".ts.net") ? "tailnet" : "anywhere";
  } catch {
    return "anywhere";
  }
}

/** Tailnet HTTPS first: it needs no open port and works away from home. */
function rankServerEndpoint(endpoint: ServerDirectEndpoint): number {
  if (endpoint.kind === "tailnet" && endpoint.httpBaseUrl.startsWith("https:")) return 0;
  return endpoint.kind === "tailnet" ? 1 : 2;
}

/**
 * The address a phone can reach this machine at: the endpoint Settings uses for
 * pairing links (desktop app), else an address the server reports for itself
 * (its LAN address or a Tailscale Serve name), else the page's own origin when
 * another device can open it. Null when only this computer can reach the server.
 */
export function resolvePhonePairingAddress(input: {
  readonly endpoint: AdvertisedEndpoint | null;
  readonly serverEndpoints?: ReadonlyArray<ServerDirectEndpoint> | undefined;
  readonly currentOrigin: string | null;
}): PhonePairingAddress | null {
  const candidates: Array<{ url: string; hint: PhoneNetworkHint | null }> = [];
  if (input.endpoint !== null && input.endpoint.status !== "unavailable") {
    candidates.push({
      url: input.endpoint.httpBaseUrl,
      hint: hintFor(input.endpoint, input.endpoint.httpBaseUrl),
    });
  }
  for (const endpoint of [...(input.serverEndpoints ?? [])].toSorted(
    (left, right) => rankServerEndpoint(left) - rankServerEndpoint(right),
  )) {
    candidates.push({
      url: endpoint.httpBaseUrl,
      hint: endpoint.kind === "tailnet" ? "tailnet" : "same-network",
    });
  }
  if (input.currentOrigin !== null) {
    candidates.push({ url: input.currentOrigin, hint: null });
  }
  for (const candidate of candidates) {
    if (!isShareablePairingUrl(candidate.url)) continue;
    return { httpBaseUrl: candidate.url, hint: candidate.hint ?? hintFor(null, candidate.url) };
  }
  return null;
}

/**
 * The link the phone scans. It names the server directly, never the hosted web
 * app, because the iPhone app talks to the server itself; its scanner reads the
 * token from the `#token=` fragment.
 */
export function buildPhonePairingUrl(address: PhonePairingAddress, credential: string): string {
  return resolveDesktopPairingUrl(address.httpBaseUrl, credential);
}

export function describePhoneNetworkHint(hint: PhoneNetworkHint): string {
  switch (hint) {
    case "tailnet":
      return "Your iPhone needs the Tailscale app, signed in to the same tailnet as this computer.";
    case "same-network":
      return "Your iPhone needs to be on the same Wi-Fi as this computer.";
    case "anywhere":
      return "Your iPhone can reach this address from any network.";
  }
}
