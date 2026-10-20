import type * as ServerConfig from "../config.ts";

/** Browser CSRF check. An untrusted forwarded host never chooses the authority. */
export function capacityMutationOriginAllowed(input: {
  origin?: string | undefined;
  host?: string | undefined;
  requestUrl: string;
  forwardedProto?: string | undefined;
  fetchSite?: string | undefined;
  authorization?: string | undefined;
  cookie?: string | undefined;
  trustedOrigins: ReadonlyArray<string>;
}): boolean {
  if (input.origin && input.trustedOrigins.includes(input.origin)) return true;
  if (input.fetchSite === "cross-site") return false;
  if (!input.origin)
    return (
      !input.cookie && /^(Bearer|DPoP)\s+\S+$/i.test(input.authorization ?? "") && !input.fetchSite
    );
  try {
    const origin = new URL(input.origin);
    if (origin.origin !== input.origin || origin.username || origin.password) return false;
    const request = new URL(input.requestUrl, `http://${input.host ?? "127.0.0.1"}`);
    const host = input.host ?? request.host;
    const protocol = input.forwardedProto === "https" ? "https:" : request.protocol;
    return (
      origin.host === host &&
      origin.protocol === protocol &&
      (protocol === "http:" || protocol === "https:")
    );
  } catch {
    return false;
  }
}

/**
 * Origins a mutation may come from besides the server's own. The Mac app's
 * renderer is trusted in every mode: a web page cannot send these origins, and
 * the app also drives a separately launched web-mode service such as M4's.
 */
export function mutationTrustedOrigins(
  config: Pick<ServerConfig.ServerConfig["Service"], "devAllowedOrigins" | "devUrl">,
): ReadonlyArray<string> {
  return [
    ...config.devAllowedOrigins,
    ...(config.devUrl ? [config.devUrl.origin] : []),
    "studio://app",
    "studio-dev://app",
  ];
}
