/**
 * The launch URL an installed page's launcher opens, and the in-app route its
 * window shows. The launcher carries nothing but a random install id, so the
 * parser accepts exactly the canonical form this module writes and nothing
 * else: no query, hash, credentials, port, extra path or case variant.
 */
export const ARTIFACT_APP_ROUTE = "artifact-app";

/** The renderer argument naming the install an installed-page window shows. */
export const ARTIFACT_APP_WINDOW_ARGUMENT = "--studio-artifact-app=";

const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
const INSTALL_ID_BYTES = 16;
const APP_USER_MODEL_ID_MAX = 128;

// Web Crypto instead of node:crypto keeps this module loadable from a sandboxed preload.
export function newArtifactAppInstallId(
  random: (size: number) => Uint8Array = (size) =>
    globalThis.crypto.getRandomValues(new Uint8Array(size)),
): string {
  const bytes = random(INSTALL_ID_BYTES);
  if (bytes.length !== INSTALL_ID_BYTES) {
    throw new Error("Install id source returned the wrong number of bytes.");
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isArtifactAppInstallId(value: unknown): value is string {
  return typeof value === "string" && INSTALL_ID_PATTERN.test(value);
}

/** True for a lowercase URL scheme; the scheme ends up in a shell script and a desktop entry. */
export function isArtifactAppScheme(value: string): boolean {
  return SCHEME_PATTERN.test(value);
}

export function artifactAppLaunchUrl(scheme: string, installId: string): string {
  if (!isArtifactAppScheme(scheme)) throw new Error("Invalid URL scheme for an installed page.");
  if (!isArtifactAppInstallId(installId)) throw new Error("Invalid install id.");
  return `${scheme}://app/${ARTIFACT_APP_ROUTE}/${installId}`;
}

/**
 * The install id in a launch URL, or null. The value must equal the canonical
 * URL (optionally with one trailing slash) character for character; parsing
 * with `new URL` and checking fields would accept `app:/`, a bare `?` or `#`,
 * `@app`, an uppercase scheme or embedded whitespace.
 */
export function parseArtifactAppLaunchUrl(value: string, scheme: string): string | null {
  if (typeof value !== "string" || typeof scheme !== "string") return null;
  if (!isArtifactAppScheme(scheme)) return null;
  const prefix = `${scheme}://app/${ARTIFACT_APP_ROUTE}/`;
  if (!value.startsWith(prefix)) return null;
  let rest = value.slice(prefix.length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  return isArtifactAppInstallId(rest) ? rest : null;
}

/** The first launch URL among process arguments (a second launch or the app's own start). */
export function findArtifactAppLaunchInArgv(
  argv: ReadonlyArray<string>,
  scheme: string,
): string | null {
  for (const argument of argv) {
    const installId = parseArtifactAppLaunchUrl(argument, scheme);
    if (installId !== null) return installId;
  }
  return null;
}

/** The renderer URL for an installed-page window; the web client uses hash history in desktop. */
export function artifactAppWindowUrl(desktopUrl: string, installId: string): string {
  if (!isArtifactAppInstallId(installId)) throw new Error("Invalid install id.");
  const url = new URL(desktopUrl);
  url.search = "";
  url.hash = `/${ARTIFACT_APP_ROUTE}/${installId}`;
  return url.toString();
}

/**
 * A per-install Windows AppUserModelID so the taskbar groups each installed
 * page on its own. Windows caps the id at 128 characters; the base is cut, never
 * the install id, so two installs can never share an identity.
 */
export function artifactAppUserModelId(baseAppUserModelId: string, installId: string): string {
  if (!isArtifactAppInstallId(installId)) throw new Error("Invalid install id.");
  const suffix = `.artifactapp.${installId}`;
  const base = baseAppUserModelId.slice(0, APP_USER_MODEL_ID_MAX - suffix.length);
  return `${base}${suffix}`;
}
