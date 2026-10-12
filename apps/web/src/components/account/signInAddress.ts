const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The address to open on another device to sign in to this machine: an HTTPS
 * address that is not loopback, since a browser elsewhere neither reaches this
 * machine's localhost nor keeps a sign-in made over plain HTTP. The page's own
 * address wins when it qualifies, then the server's direct routes (the
 * Tailscale HTTPS one among them), then what the desktop app advertises.
 */
export function pickSignInAddress(input: {
  readonly pageUrl: string | null;
  readonly directEndpoints: ReadonlyArray<{ readonly httpBaseUrl: string }>;
  readonly advertisedEndpoints: ReadonlyArray<{ readonly httpBaseUrl: string }>;
}): string | null {
  const candidates = [
    input.pageUrl,
    ...input.directEndpoints.map((endpoint) => endpoint.httpBaseUrl),
    ...input.advertisedEndpoints.map((endpoint) => endpoint.httpBaseUrl),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || LOOPBACK_HOSTS.has(url.hostname)) continue;
    return new URL("/pair", url.origin).toString();
  }
  return null;
}

/** First letter for the account avatar. */
export function accountInitial(name: string): string {
  return (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}
