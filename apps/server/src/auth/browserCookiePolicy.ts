/** Cookie transport flags do not authorize a request or trust proxy headers. */
export interface BrowserCookieRequest {
  readonly originalUrl: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

function absoluteUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function loopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function browserCookieAttributes(request: BrowserCookieRequest) {
  const url = absoluteUrl(request.originalUrl);
  const origin = absoluteUrl(request.headers.origin);
  const referer = absoluteUrl(request.headers.referer);
  // Unknown transport is conservative. In particular, an absolute HTTPS URL
  // or HTTPS browser context cannot be downgraded by a forwarded HTTP header.
  const https =
    url?.protocol === "https:" || origin?.protocol === "https:" || referer?.protocol === "https:";
  const invalidOrigin =
    request.headers.origin !== undefined &&
    (origin === null || origin.origin !== request.headers.origin);
  const localUrl =
    url !== null &&
    loopbackHttp(url) &&
    (request.headers.host === undefined || request.headers.host === url.host);
  const localOrigin =
    origin !== null &&
    loopbackHttp(origin) &&
    (url !== null ? origin.origin === url.origin : origin.host === request.headers.host);
  const localReferer =
    referer !== null &&
    loopbackHttp(referer) &&
    (url !== null ? referer.origin === url.origin : referer.host === request.headers.host);
  const explicitLocalHttp =
    !https && !invalidOrigin && (origin !== null ? localOrigin : localUrl || localReferer);
  // Relative reverse-proxy requests with no verified local browser context keep
  // Secure. Forwarded / X-Forwarded-* never establish an HTTP exception.
  return { httpOnly: true, path: "/", sameSite: "lax", secure: !explicitLocalHttp } as const;
}
