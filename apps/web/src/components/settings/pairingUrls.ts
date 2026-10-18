import { isLoopbackHostname } from "../../environments/primary/target";
import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

/**
 * Whether another machine can open this pairing link. The desktop app's own
 * origin (studio://app) and loopback addresses only reach the machine that made
 * the link, so they are never offered for sharing.
 */
export function isShareablePairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}
