/**
 * How a scanned local server is named in the "Local servers" list.
 *
 * The scanner knows the listening process (`node`, `ssh`, a binary such as
 * `devd`) and, when the port serves a page, that page's `<title>`. The title is
 * what a person recognises, so it wins. A known process gets a plain-words
 * name ("Node server"); an unknown binary is never the headline - the row says
 * "Local server" and keeps the raw name on its second line.
 *
 * @module localServerLabel
 */
import type { DiscoveredLocalServer } from "@specweave-studio/contracts";
import { isLoopbackHost } from "@specweave-studio/shared/preview";

export const SPEC_WITH_CODE_SERVER_LABEL = "SpecWithCode";
export const UNNAMED_LOCAL_SERVER_LABEL = "Local server";

const FRIENDLY_PROCESS_NAMES: Readonly<Record<string, string>> = {
  node: "Node server",
  nodejs: "Node server",
  bun: "Bun server",
  deno: "Deno server",
  python: "Python server",
  python3: "Python server",
  ruby: "Ruby server",
  php: "PHP server",
  java: "Java server",
  dotnet: ".NET server",
  go: "Go server",
  ssh: "SSH tunnel",
  docker: "Docker container",
  "com.docker.backend": "Docker container",
  "com.docker.vpnkit": "Docker container",
  nginx: "nginx",
  httpd: "Apache server",
  caddy: "Caddy server",
  postgres: "PostgreSQL",
  redis: "Redis",
  temporal: "Temporal",
};

/** A readable name for a process, or null when the process is unknown. */
export function friendlyProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const known = FRIENDLY_PROCESS_NAMES[lower];
  if (known) return known;
  // Versioned interpreters: python3.12, node22, ruby3.3.
  const base = lower.replace(/[\d.]+$/, "");
  return FRIENDLY_PROCESS_NAMES[base] ?? null;
}

export interface LocalServerLabel {
  readonly title: string;
  readonly description: string;
  /** Both lines in full, for a hover tooltip when the row is cut off. */
  readonly hoverText: string;
}

type LabelledServer = Pick<
  DiscoveredLocalServer,
  "port" | "processName" | "pageTitle" | "specWithCode"
>;

/**
 * Title: the page title, else a friendly process name, else "Local server".
 * A SpecWithCode page is always called "SpecWithCode", whatever its title.
 * Description: `localhost:PORT · <process>`, keeping the raw name visible for
 * whoever needs to find the process.
 */
export function describeLocalServer(server: LabelledServer): LocalServerLabel {
  const processName = server.processName?.trim() || null;
  const title = server.specWithCode
    ? SPEC_WITH_CODE_SERVER_LABEL
    : server.pageTitle?.trim() || friendlyProcessName(processName) || UNNAMED_LOCAL_SERVER_LABEL;
  const address = `localhost:${server.port}`;
  const description = processName ? `${address} · ${processName}` : address;
  return { title, description, hoverText: `${title} — ${description}` };
}

/** The page this app is served from, so its own server can be left out. */
export interface CurrentAppLocation {
  readonly hostname: string;
  readonly port: string;
  readonly protocol: string;
}

/**
 * Whether a scanned server is the one serving this very window. The server
 * already hides its own process; this also covers a dev server or a different
 * backend that serves the page being viewed.
 */
export function isCurrentAppServer(
  server: Pick<DiscoveredLocalServer, "port" | "specWithCode">,
  location: CurrentAppLocation | null | undefined,
): boolean {
  if (!server.specWithCode || !location) return false;
  if (location.protocol !== "http:" && location.protocol !== "https:") return false;
  if (!isLoopbackHost(location.hostname)) return false;
  const port = location.port
    ? Number.parseInt(location.port, 10)
    : location.protocol === "http:"
      ? 80
      : 443;
  return port === server.port;
}

/**
 * Drops this app's own server and moves other SpecWithCode instances (another
 * machine's service reached over an SSH tunnel, say) below the project's own
 * servers, keeping the incoming order otherwise.
 */
export function arrangeLocalServers<T extends Pick<DiscoveredLocalServer, "port" | "specWithCode">>(
  servers: ReadonlyArray<T>,
  location: CurrentAppLocation | null | undefined,
): ReadonlyArray<T> {
  const visible = servers.filter((server) => !isCurrentAppServer(server, location));
  return [
    ...visible.filter((server) => !server.specWithCode),
    ...visible.filter((server) => server.specWithCode),
  ];
}
