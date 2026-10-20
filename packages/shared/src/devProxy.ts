/**
 * Backend paths the web dev server proxies in single-origin browser dev.
 *
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
export const DEV_PROXIED_PATH_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp"] as const;

/**
 * Prefixes the proxy must forward with the browser's own Host. MCP OAuth
 * derives its issuer and resource URLs from the request, and a client
 * rejects metadata naming a different origin than the one it fetched. The
 * server lets a cookie open `/ws` or change state through `/api` only when
 * the request's Origin matches its Host, so a dev page opened at any address
 * (127.0.0.1, a LAN or tailnet name) needs the Host it was opened at.
 */
export const DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES: ReadonlySet<string> = new Set([
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/mcp",
]);

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
