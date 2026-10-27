/**
 * The one rule for which addresses fleet traffic may use between machines:
 * a private Tailscale HTTPS name (`*.ts.net`, any port) or a SpecWithCode
 * Connect managed endpoint (exactly one `<slug>-<16 hex>` label directly above
 * the managed base domain, default port). Nothing else: no plain HTTP, no
 * credentials, query, fragment or path.
 */
import {
  isManagedEndpointHostname,
  resolveManagedEndpointBaseDomain,
} from "@specweave-studio/shared/managedEndpoint";

import { buildRelayUrl } from "../cloud/publicConfig.ts";

export type FleetTransport = "tailnet" | "connect";

export interface FleetOrigin {
  readonly origin: string;
  readonly transport: FleetTransport;
}

const TAILNET_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i;

let memoBaseDomain: string | undefined;

/** The managed endpoint base domain for this process, read once. */
export const managedEndpointBaseDomain = (): string =>
  (memoBaseDomain ??= resolveManagedEndpointBaseDomain({
    env: process.env,
    relayUrl: process.env.STUDIO_RELAY_URL?.trim() || buildRelayUrl() || undefined,
  }));

/** Whether `hostname` (already lowercased by URL parsing) is a tailnet name. */
export const isTailnetHostname = (hostname: string): boolean => TAILNET_HOST.test(hostname);

/**
 * The origin and its transport, or null when `value` is not an allowed fleet
 * address. `value` must be the bare origin (pathname "/").
 */
export function parseFleetOrigin(
  value: string,
  options: { readonly baseDomain?: string } = {},
): FleetOrigin | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    // `new URL` keeps a bare "?" or "#" out of search/hash; refuse them too.
    /[?#]/.test(value)
  )
    return null;
  if (TAILNET_HOST.test(url.hostname)) return { origin: url.origin, transport: "tailnet" };
  if (
    url.port === "" &&
    isManagedEndpointHostname(url.hostname, options.baseDomain ?? managedEndpointBaseDomain())
  )
    return { origin: url.origin, transport: "connect" };
  return null;
}

/**
 * Whether a request's Host header names a managed Connect endpoint (only the
 * default HTTPS port counts). A loopback caller can spoof Host, so callers use
 * this only to refuse, never to grant.
 */
export const isManagedEndpointHost = (
  hostHeader: string | undefined,
  options: { readonly baseDomain?: string } = {},
): boolean => {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase().replace(/:443$/, "");
  return isManagedEndpointHostname(host, options.baseDomain ?? managedEndpointBaseDomain());
};
