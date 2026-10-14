/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Windows / lsof missing: checks a curated list of common dev ports through
 * the shared Net service.
 *
 * Listening ports are published only after a bounded HTTP(S) probe finds a
 * successful HTML document or a redirect to one. Some listeners are never
 * connected to at all (see `listenerSkipReason`): a probe is a real TCP
 * connection, and one-shot loopback OAuth callback servers treat any
 * connection as their single request.
 * The same response's head is
 * read (bounded) for the page title, so the list can show a friendly name
 * without a second request. The listener owned by this very server process is
 * left out: it is the app the user is already looking at.
 * Positive and negative results are cached briefly by candidate URL and listener identity,
 * limiting repeated requests without leaving stale classifications around.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 */
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
  type DiscoveredLocalServer,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Net from "@specweave-studio/shared/Net";
import { isLoopbackHost, LSOF_LOCAL_HOST_TOKENS } from "@specweave-studio/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import {
  describeLocalServerPage,
  readBoundedText,
  type LocalServerPageInfo,
} from "./localServerPage.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      input: {
        readonly configuredUrls: ReadonlyArray<string>;
        readonly initialSnapshot: ReadonlyArray<DiscoveredLocalServer>;
      },
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
  }
>()("specweave-studio/preview/PortScanner/PortDiscovery") {}

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

const POLL_INTERVAL = Duration.seconds(3);
const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT = Duration.seconds(1);
/** Reading the title is best effort; a slow body keeps the server, minus its title. */
const PAGE_TITLE_READ_TIMEOUT = Duration.millis(300);
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const WEB_PROBE_CONCURRENCY = 16;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Listener processes the scanner never connects to, matched as a
 * case-insensitive prefix of the process name (lsof `-F c` reports
 * `agy_acp_server.par`, Linux may truncate it, Get-Process drops `.exe`).
 *
 * Google's Antigravity ACP server (`agy_acp_server`) signs in through a
 * one-shot loopback OAuth callback server: the first connection it accepts,
 * whether an HTTP GET, a TLS ClientHello or a bare connect, consumes the
 * callback and fails the sign-in. The prober is often another Studio instance
 * on the same machine, so the auth flow cannot defend itself; the scanner has
 * to stay away.
 *
 * On Windows a `.par` launched through its interpreter can show up as
 * `python` in Get-Process, so this name rule does not fire there. That case
 * relies on the ephemeral-port rule in `listenerSkipReason`: agy binds its
 * callback to 127.0.0.1 on an OS-assigned port, and Studio starts agy itself,
 * never from a project terminal.
 */
const NEVER_PROBE_PROCESS_NAME_PREFIXES: ReadonlyArray<string> = Object.freeze(["agy_acp_server"]);

interface PortRange {
  readonly min: number;
  readonly max: number;
}

/** IANA dynamic range; the macOS and Windows default ephemeral range. */
const IANA_EPHEMERAL_PORT_RANGE: PortRange = Object.freeze({ min: 49_152, max: 65_535 });
/** Linux default `net.ipv4.ip_local_port_range`. */
const LINUX_DEFAULT_EPHEMERAL_PORT_RANGE: PortRange = Object.freeze({ min: 32_768, max: 60_999 });
const LINUX_EPHEMERAL_PORT_RANGE_PATH = "/proc/sys/net/ipv4/ip_local_port_range";

/**
 * How long a terminal-owned loopback listener on an ephemeral port must stay
 * up before it is probed. OAuth CLIs run from a Studio terminal (`az login`,
 * a google-auth-oauthlib script with `port=0`) are terminal-owned too; their
 * callback servers usually close within a minute, dev servers stay up.
 */
const TERMINAL_EPHEMERAL_LISTENER_MIN_AGE_MS = Duration.toMillis(Duration.seconds(60));

/** Bind addresses that accept connections on every interface. */
const WILDCARD_BIND_HOSTS: ReadonlySet<string> = new Set(["*", "0.0.0.0", "[::]", "::"]);

type BindScope = "loopback" | "wildcard";

const bindScopeOf = (host: string): BindScope =>
  WILDCARD_BIND_HOSTS.has(host) ? "wildcard" : "loopback";

const isNeverProbeProcess = (processName: string | null): boolean => {
  if (processName === null) return false;
  const normalized = processName.trim().toLowerCase();
  return NEVER_PROBE_PROCESS_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const parseIpLocalPortRange = (raw: string): PortRange | null => {
  const [minRaw, maxRaw, ...rest] = raw.trim().split(/\s+/);
  if (rest.length > 0) return null;
  const min = Number(minRaw);
  const max = Number(maxRaw);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min <= 0 || max >= 65_536 || min > max) return null;
  return { min, max };
};

/**
 * Tuned hosts and containers often widen the range to `1024 65535`. Taking
 * that literally would treat 3000, 5173 and 8000 as ephemeral, so the lower
 * bound never drops below the Linux default.
 */
const resolveLinuxEphemeralPortRange = (raw: string): PortRange => {
  const parsed = parseIpLocalPortRange(raw);
  if (parsed === null) return LINUX_DEFAULT_EPHEMERAL_PORT_RANGE;
  const min = Math.max(parsed.min, LINUX_DEFAULT_EPHEMERAL_PORT_RANGE.min);
  return min <= parsed.max ? { min, max: parsed.max } : LINUX_DEFAULT_EPHEMERAL_PORT_RANGE;
};

const isInPortRange = (port: number, range: PortRange): boolean =>
  port >= range.min && port <= range.max;

/** One listening socket as reported by lsof or Get-NetTCPConnection. */
interface ListenerEntry {
  readonly port: number;
  readonly bindScope: BindScope;
  readonly pid: number | null;
  readonly processName: string | null;
  readonly terminal: TerminalProcessOwner | null;
}

type ListenerSkipReason =
  | "never-probe-process"
  | "ephemeral-loopback-unowned"
  | "ephemeral-loopback-terminal-too-new";

/**
 * Why a listening socket must not be connected to, or null when it may be.
 * A port is probed only when every socket on it may be: `localhost` can
 * resolve to either loopback family, so a probe may reach any of them.
 *
 * Loopback listeners on ephemeral ports are where the OS places servers that
 * never asked to be found: OAuth callbacks that bind port 0 (agy, `az login`,
 * google-auth-oauthlib with `port=0`), debugger handshakes and test harnesses.
 * A single probe connection can break them. Dev servers normally pick fixed
 * ports (Vite 5173, Next 3000, ...) below the ephemeral range, and servers
 * meant to be reached usually bind a wildcard address, while OAuth callbacks
 * bind loopback (RFC 8252). So such a listener is probed only when a project
 * terminal owns it (`terminal` comes from the terminal manager's registered
 * process tree) and it has been up for TERMINAL_EPHEMERAL_LISTENER_MIN_AGE_MS.
 *
 * Known gaps:
 * - OAuth callbacks on fixed ports below the range are still probed:
 *   `gcloud auth login` (8085-8184), google-auth-oauthlib with an explicit
 *   port such as 8080. Only the agy name rule protects a fixed port.
 * - A callback that binds a wildcard address on an ephemeral port is probed.
 * - The probe runs a moment after lsof listed the socket; a port that closes
 *   and is reassigned in between is not re-checked.
 *
 * Trade-off: a loopback-only dev server on an ephemeral port started outside a
 * Studio terminal is not auto-discovered, and one started in a terminal shows
 * up after a minute. Clicking its URL in a Studio terminal opens it in
 * Preview, and a preview URL in a project script is always probed.
 */
const listenerSkipReason = (
  entry: ListenerEntry,
  ageMillis: number,
  ephemeralPorts: PortRange,
): ListenerSkipReason | null => {
  if (isNeverProbeProcess(entry.processName)) return "never-probe-process";
  if (!isInPortRange(entry.port, ephemeralPorts)) return null;
  if (entry.bindScope === "wildcard") return null;
  if (entry.terminal === null) return "ephemeral-loopback-unowned";
  if (ageMillis < TERMINAL_EPHEMERAL_LISTENER_MIN_AGE_MS) {
    return "ephemeral-loopback-terminal-too-new";
  }
  return null;
};

interface ListenerSnapshot {
  /** One entry per port, never a never-probe process. */
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  /** Every socket behind `servers`, never-probe ones included; null when unknown. */
  readonly entries: ReadonlyArray<ListenerEntry> | null;
}

interface ListenerSighting {
  readonly firstSeenMillis: number;
  readonly skipLogged: boolean;
}

interface ListenerClassification {
  /** Ports discovered listeners must not be probed on. */
  readonly blockedPorts: ReadonlySet<number>;
  /** Ports held by never-probe processes; configured URLs skip them too. */
  readonly protectedPorts: ReadonlySet<number>;
}

const buildListenerSnapshot = (entries: ReadonlyArray<ListenerEntry>): ListenerSnapshot => {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const entry of entries) {
    if (isNeverProbeProcess(entry.processName) || seen.has(entry.port)) continue;
    seen.set(entry.port, {
      host: "localhost",
      port: entry.port,
      url: `http://localhost:${entry.port}`,
      processName: entry.processName,
      pid: entry.pid,
      terminal: entry.terminal,
    });
  }
  return {
    servers: [...seen.values()].toSorted((left, right) => left.port - right.port),
    entries,
  };
};

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ListenerSubscription {
  readonly configuredUrls: ReadonlyArray<string>;
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
}

interface ScannerState {
  readonly listeners: ReadonlyMap<Listener, ListenerSubscription>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
    }
  >;
  readonly retainCount: number;
}

interface TerminalProcessOwner {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

interface WebProbeCacheEntry {
  readonly pid: number | null;
  readonly isWeb: boolean;
  readonly page: LocalServerPageInfo | null;
  readonly expiresAtMillis: number;
}

interface WebProbeResult {
  readonly url: string;
  readonly page: LocalServerPageInfo | null;
}

const withPageInfo = (
  server: DiscoveredLocalServer,
  page: LocalServerPageInfo | null,
): DiscoveredLocalServer => {
  const { pageTitle: _pageTitle, specWithCode: _specWithCode, ...rest } = server;
  return {
    ...rest,
    ...(page?.title ? { pageTitle: page.title } : {}),
    ...(page?.specWithCode ? { specWithCode: true as const } : {}),
  };
};

interface WebProbeGroup {
  readonly server: DiscoveredLocalServer;
  readonly urls: ReadonlyArray<string>;
  readonly configuredKey: string | null;
}

interface WebProbeSnapshot {
  readonly discovered: ReadonlyArray<DiscoveredLocalServer>;
  readonly configured: ReadonlyMap<string, DiscoveredLocalServer>;
}

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseConfiguredUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isLoopbackHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
};

const localServerKey = (host: string, port: number): string =>
  `${isLoopbackHost(host) ? "loopback" : host.toLowerCase()}:${port}`;

const urlPort = (url: URL): number =>
  url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "http:" ? 80 : 443;

const webProbeCacheKey = (raw: string): string => {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
};

const normalizeConfiguredUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    urls
      .slice(0, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
      .filter((raw) => raw.length <= PREVIEW_URL_MAX_LENGTH)
      .map(parseConfiguredUrl)
      .filter((url): url is URL => url !== null && url.href.length <= PREVIEW_URL_MAX_LENGTH)
      .map((url) => {
        if (url.hostname === "0.0.0.0") url.hostname = "localhost";
        return url.href;
      })
      .filter((url) => url.length <= PREVIEW_URL_MAX_LENGTH),
  ),
];

const projectWebProbeSnapshot = (
  snapshot: WebProbeSnapshot,
  configuredUrls: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> => {
  const visibleByServer = new Map<string, DiscoveredLocalServer>();
  for (const raw of normalizeConfiguredUrls(configuredUrls)) {
    const url = new URL(raw);
    const port = urlPort(url);
    const serverKey = localServerKey(url.hostname, port);
    if (visibleByServer.has(serverKey)) continue;
    const configured = snapshot.configured.get(webProbeCacheKey(raw));
    if (configured) visibleByServer.set(serverKey, { ...configured, url: raw });
  }
  for (const server of snapshot.discovered) {
    const key = localServerKey(server.host, server.port);
    if (!visibleByServer.has(key)) visibleByServer.set(key, server);
  }
  return [...visibleByServer.values()].toSorted((left, right) => left.port - right.port);
};

const parseLsofOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ListenerSnapshot => {
  const entries: ListenerEntry[] = [];
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const address = parseLsofAddress(value);
      if (address === null) continue;
      entries.push({
        port: address.port,
        bindScope: bindScopeOf(address.host),
        pid,
        processName,
        terminal: pid === null ? null : (terminalByProcessId.get(pid) ?? null),
      });
    }
  }

  return buildListenerSnapshot(entries);
};

const parseLsofAddress = (
  name: string,
): { readonly host: string; readonly port: number } | null => {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173", "localhost:5173",
  //           "192.168.1.10:5173 (LISTEN)" — we only care if the host part is local.
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return { host: hostPart, port };
};

const parseWindowsListenerOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ListenerSnapshot => {
  const entries: ListenerEntry[] = [];
  for (const line of raw.split(/\r?\n/g)) {
    const [hostRaw, portRaw, pidRaw, processNameRaw] = line.trim().split("|", 4);
    const host = hostRaw?.trim() ?? "";
    if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") continue;
    const port = Number(portRaw);
    const pid = Number(pidRaw);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    const normalizedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    entries.push({
      port,
      bindScope: bindScopeOf(host),
      pid: normalizedPid,
      processName: processNameRaw?.trim() || null,
      terminal: normalizedPid === null ? null : (terminalByProcessId.get(normalizedPid) ?? null),
    });
  }
  return buildListenerSnapshot(entries);
};

const serversEqual = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.host !== b.host ||
      a.port !== b.port ||
      a.url !== b.url ||
      a.processName !== b.processName ||
      a.pageTitle !== b.pageTitle ||
      a.specWithCode !== b.specWithCode ||
      a.pid !== b.pid ||
      a.terminal?.threadId !== b.terminal?.threadId ||
      a.terminal?.terminalId !== b.terminal?.terminalId
    ) {
      return false;
    }
  }
  return true;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const stateRef = yield* Ref.make<ScannerState>({
    listeners: new Map(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());
  // Keyed by `pid:port`; holds only the sockets present in the last listener scan.
  const listenerSightingsRef = yield* Ref.make<ReadonlyMap<string, ListenerSighting>>(new Map());
  // Kept from the last lsof/PowerShell scan so the common-port fallback still
  // skips never-probe listeners while the process probe is failing.
  const lastProtectedPortsRef = yield* Ref.make<ReadonlySet<number>>(new Set());
  const scanSemaphore = yield* Semaphore.make(1);
  const selfProcessId = process.pid;

  const resolveEphemeralPortRange = Effect.fn("PortDiscovery.resolveEphemeralPortRange")(
    function* () {
      if (hostPlatform !== "linux") return IANA_EPHEMERAL_PORT_RANGE;
      const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
      if (Option.isNone(fileSystem)) return LINUX_DEFAULT_EPHEMERAL_PORT_RANGE;
      const raw = yield* fileSystem.value
        .readFileString(LINUX_EPHEMERAL_PORT_RANGE_PATH)
        .pipe(Effect.orElseSucceed(() => ""));
      return resolveLinuxEphemeralPortRange(raw);
    },
  );
  // Read once: the range is a boot-time sysctl and the scanner polls every few seconds.
  const ephemeralPortRange = yield* resolveEphemeralPortRange();

  const probeCommonPorts = Effect.fn("PortDiscovery.probeCommonPorts")(function* () {
    const results = yield* Effect.forEach(
      COMMON_DEV_PORTS,
      (port) =>
        net.isPortAvailableOnLoopback(port).pipe(
          Effect.map((available) => ({
            port,
            listening: !available,
          })),
        ),
      { concurrency: "unbounded" },
    );
    const servers = results
      .filter((result) => result.listening)
      .map<DiscoveredLocalServer>((result) => ({
        host: "localhost",
        port: result.port,
        url: `http://localhost:${result.port}`,
        processName: null,
        pid: null,
        terminal: null,
      }));
    return { servers, entries: null } satisfies ListenerSnapshot;
  });

  const probeWebUrl = Effect.fn("PortDiscovery.probeWebUrl")((url: string) =>
    Effect.gen(function* () {
      const response = Option.getOrNull(
        yield* httpClient.get(url).pipe(Effect.timeoutOption(WEB_PROBE_TIMEOUT)),
      );
      if (response === null) return null;
      const location = response.headers.location?.trim();
      if (NAVIGATION_REDIRECT_STATUSES.has(response.status) && location) {
        return { url, page: null } satisfies WebProbeResult;
      }
      if (response.status < 200 || response.status >= 300) return null;
      if (response.status === 204 || response.status === 205) return null;
      const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "text/html" && contentType !== "application/xhtml+xml") return null;
      // The body is already on its way; its head names the page. A slow or
      // failing read keeps the server and just drops the title.
      const page = yield* readBoundedText(response.stream).pipe(
        Effect.map(describeLocalServerPage),
        Effect.timeoutOption(PAGE_TITLE_READ_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      return { url, page } satisfies WebProbeResult;
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );

  const classifyListeners = Effect.fn("PortDiscovery.classifyListeners")(function* (
    listeners: ListenerSnapshot,
    nowMillis: number,
  ) {
    if (listeners.entries === null) {
      const protectedPorts = yield* Ref.get(lastProtectedPortsRef);
      return { blockedPorts: protectedPorts, protectedPorts } satisfies ListenerClassification;
    }
    const previous = yield* Ref.get(listenerSightingsRef);
    const sightings = new Map<string, ListenerSighting>();
    const blockedPorts = new Set<number>();
    const protectedPorts = new Set<number>();
    const newlySkipped: Array<{ readonly entry: ListenerEntry; readonly reason: string }> = [];
    for (const entry of listeners.entries) {
      const key = `${entry.pid ?? ""}:${entry.port}`;
      const sighting = sightings.get(key) ??
        previous.get(key) ?? { firstSeenMillis: nowMillis, skipLogged: false };
      const reason = listenerSkipReason(
        entry,
        nowMillis - sighting.firstSeenMillis,
        ephemeralPortRange,
      );
      if (reason === null) {
        sightings.set(key, sighting);
        continue;
      }
      blockedPorts.add(entry.port);
      if (reason === "never-probe-process") protectedPorts.add(entry.port);
      if (!sighting.skipLogged) newlySkipped.push({ entry, reason });
      sightings.set(key, { ...sighting, skipLogged: true });
    }
    yield* Ref.set(listenerSightingsRef, sightings);
    yield* Ref.set(lastProtectedPortsRef, protectedPorts);
    yield* Effect.forEach(
      newlySkipped,
      ({ entry, reason }) =>
        Effect.logDebug("preview port scanner skipped a listener", {
          port: entry.port,
          pid: entry.pid,
          processName: entry.processName,
          reason,
        }),
      { discard: true },
    );
    return { blockedPorts, protectedPorts } satisfies ListenerClassification;
  });

  const makeWebProbeGroups = (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
    { blockedPorts, protectedPorts }: ListenerClassification,
  ): ReadonlyArray<WebProbeGroup> => {
    const serversByKey = new Map(
      servers.map((server) => [localServerKey(server.host, server.port), server] as const),
    );
    const groups: WebProbeGroup[] = [];
    const configuredResources = new Set<string>();

    for (const raw of configuredUrls) {
      const url = new URL(raw);
      const port = urlPort(url);
      const key = localServerKey(url.hostname, port);
      const resourceKey = webProbeCacheKey(raw);
      // Configured URLs are always loopback, so a never-probe listener on the
      // same port is the process the URL would reach.
      if (protectedPorts.has(port)) continue;
      if (configuredResources.has(resourceKey)) continue;
      configuredResources.add(resourceKey);
      groups.push({
        server: serversByKey.get(key) ?? {
          host: url.hostname,
          port,
          url: raw,
          processName: null,
          pid: null,
          terminal: null,
        },
        urls: [raw],
        configuredKey: resourceKey,
      });
    }

    for (const server of servers) {
      if (blockedPorts.has(server.port)) continue;
      groups.push({
        server,
        urls: [`http://${server.host}:${server.port}`, `https://${server.host}:${server.port}`],
        configuredKey: null,
      });
    }

    return groups;
  };

  const probeWebServers = Effect.fn("PortDiscovery.probeWebServers")(function* (
    listeners: ListenerSnapshot,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(webProbeCacheRef);
    const classification = yield* classifyListeners(listeners, nowMillis);
    const groups = makeWebProbeGroups(listeners.servers, configuredUrls, classification);
    const batchProbes = new Map<
      string,
      Effect.Effect<{ readonly probe: WebProbeCacheEntry; readonly fresh: boolean }>
    >();
    const batchProbeSemaphore = yield* Semaphore.make(1);
    const getProbe = (url: string, pid: number | null) => {
      const key = webProbeCacheKey(url);
      const identity = `${key}\u0000${pid ?? ""}`;
      return batchProbeSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = batchProbes.get(identity);
            if (existing) return [existing] as const;
            const cachedProbe = cached.get(key);
            const cachedIsCurrent =
              cachedProbe?.pid === pid && cachedProbe.expiresAtMillis > nowMillis;
            const memoized = yield* Effect.cached(
              cachedIsCurrent
                ? Effect.succeed({ probe: cachedProbe, fresh: false })
                : probeWebUrl(url).pipe(
                    Effect.map((result) => ({
                      probe: {
                        pid,
                        isWeb: result !== null,
                        page: result?.page ?? null,
                        expiresAtMillis: 0,
                      },
                      fresh: true,
                    })),
                  ),
            );
            batchProbes.set(identity, memoized);
            return [memoized] as const;
          }),
        )
        .pipe(Effect.flatMap(([probe]) => probe));
    };
    const probed = yield* Effect.forEach(
      groups,
      (group) =>
        Effect.gen(function* () {
          const probes: Array<readonly [string, WebProbeCacheEntry, boolean]> = [];
          let visibleUrl: string | null = null;
          let page: LocalServerPageInfo | null = null;
          for (const url of group.urls) {
            const key = webProbeCacheKey(url);
            const { probe, fresh } = yield* getProbe(url, group.server.pid);
            probes.push([key, probe, fresh]);
            if (probe.isWeb) {
              visibleUrl = url;
              page = probe.page;
              break;
            }
          }
          return { group, probes, visibleUrl, page };
        }),
      { concurrency: WEB_PROBE_CONCURRENCY },
    );
    const completedAtMillis = yield* Clock.currentTimeMillis;
    const nextCache = new Map(
      [...cached].filter(([, probe]) => probe.expiresAtMillis > completedAtMillis),
    );
    const discovered: DiscoveredLocalServer[] = [];
    const configured = new Map<string, DiscoveredLocalServer>();
    for (const { group, probes, visibleUrl, page } of probed) {
      for (const [key, probe, fresh] of probes) {
        nextCache.set(
          key,
          fresh ? { ...probe, expiresAtMillis: completedAtMillis + WEB_PROBE_CACHE_TTL_MS } : probe,
        );
      }
      if (visibleUrl === null) continue;
      // This server's own listener is the app the user is looking at.
      if (group.server.pid !== null && group.server.pid === selfProcessId) continue;
      const server = withPageInfo({ ...group.server, url: visibleUrl }, page);
      if (group.configuredKey === null) discovered.push(server);
      else configured.set(group.configuredKey, server);
    }
    yield* Ref.set(webProbeCacheRef, nextCache);
    return { discovered, configured } satisfies WebProbeSnapshot;
  });

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; falling back to common-port probes", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const scanUnlocked = Effect.fn("PortDiscovery.scanUnlocked")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
    const state = yield* Ref.get(stateRef);
    const terminalByProcessId = new Map<number, TerminalProcessOwner>();
    for (const registration of state.terminalProcesses.values()) {
      for (const processId of registration.processIds) {
        terminalByProcessId.set(processId, registration.owner);
      }
    }
    if (hostPlatform === "win32") {
      const recoverWindowsProbeFailure = recoverProcessProbeFailure("windows-listeners");
      const command =
        'Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $processName = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Output "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)|$processName" }';
      const listeners = yield* processRunner
        .run({
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", command],
          timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => parseWindowsListenerOutput(result.stdout, terminalByProcessId)),
          Effect.catchTags({
            ProcessSpawnError: recoverWindowsProbeFailure,
            ProcessStdinError: recoverWindowsProbeFailure,
            ProcessOutputLimitError: recoverWindowsProbeFailure,
            ProcessReadError: recoverWindowsProbeFailure,
            ProcessTimeoutError: recoverWindowsProbeFailure,
          }),
        );
      if (listeners !== null) return yield* probeWebServers(listeners, configuredUrls);
      return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    const lsofResult = yield* processRunner
      .run({
        command: "lsof",
        args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => parseLsofOutput(result.stdout, terminalByProcessId)),
        Effect.catchTags({
          ProcessSpawnError: recoverLsofProbeFailure,
          ProcessStdinError: recoverLsofProbeFailure,
          ProcessOutputLimitError: recoverLsofProbeFailure,
          ProcessReadError: recoverLsofProbeFailure,
          ProcessTimeoutError: recoverLsofProbeFailure,
        }),
      );
    if (lsofResult !== null) return yield* probeWebServers(lsofResult, configuredUrls);
    return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
  });

  const scanSnapshot = Effect.fn("PortDiscovery.scanSnapshot")(
    (configuredUrls: ReadonlyArray<string>) =>
      scanSemaphore.withPermits(1)(scanUnlocked(configuredUrls)),
  );

  const scanOnce: PortDiscovery["Service"]["scan"] = (configuredUrls = []) => {
    const normalized = normalizeConfiguredUrls(configuredUrls);
    return scanSnapshot(normalized).pipe(
      Effect.map((snapshot) => projectWebProbeSnapshot(snapshot, normalized)),
    );
  };

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      const configuredUrls = [
        ...new Set(
          [...(yield* Ref.get(stateRef)).listeners.values()].flatMap(
            (subscription) => subscription.configuredUrls,
          ),
        ),
      ];
      const snapshot = yield* scanSnapshot(configuredUrls);
      const notifications = yield* Ref.modify(stateRef, (state) => {
        const listeners = new Map(state.listeners);
        const changed: Array<readonly [Listener, ReadonlyArray<DiscoveredLocalServer>]> = [];
        for (const [listener, subscription] of listeners) {
          const next = projectWebProbeSnapshot(snapshot, subscription.configuredUrls);
          if (serversEqual(subscription.lastSnapshot, next)) continue;
          listeners.set(listener, { ...subscription, lastSnapshot: next });
          changed.push([listener, next]);
        }
        return [changed, { ...state, listeners }];
      });
      yield* Effect.forEach(notifications, ([listener, servers]) => listener(servers), {
        discard: true,
      });
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Ticks skip the scan and its span when no
  // client is currently retained, so the cost is one Ref.get every POLL_INTERVAL.
  const pollIfRetained = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => (state.retainCount > 0 ? pollTick() : Effect.void)),
  );
  yield* Effect.forkScoped(pollIfRetained.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const acquireRetention = Effect.fn("PortDiscovery.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) {
      // Run an immediate scan + broadcast so the new retainer doesn't have
      // to wait up to POLL_INTERVAL for the first emission.
      yield* pollTick();
    }
  });

  const retain: PortDiscovery["Service"]["retain"] = Effect.acquireRelease(acquireRetention(), () =>
    Ref.update(stateRef, (state) => ({
      ...state,
      retainCount: Math.max(0, state.retainCount - 1),
    })),
  );

  const subscribe: PortDiscovery["Service"]["subscribe"] = Effect.fn("PortDiscovery.subscribe")(
    (input, listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => {
          const listeners = new Map(state.listeners);
          listeners.set(listener, {
            configuredUrls: normalizeConfiguredUrls(input.configuredUrls),
            lastSnapshot: input.initialSnapshot,
          });
          return { ...state, listeners };
        }),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Map(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      ),
  );

  const registerTerminalProcesses: PortDiscovery["Service"]["registerTerminalProcesses"] =
    Effect.fn("PortDiscovery.registerTerminalProcesses")(function* (input) {
      const owner = {
        threadId: ThreadId.make(input.threadId),
        terminalId: input.terminalId,
      };
      const processIds = new Set(
        input.processIds.filter((processId) => Number.isInteger(processId) && processId > 0),
      );
      yield* Ref.update(stateRef, (state) => {
        const terminalProcesses = new Map(state.terminalProcesses);
        const key = terminalOwnerKey(owner);
        if (processIds.size === 0) {
          terminalProcesses.delete(key);
        } else {
          terminalProcesses.set(key, { owner, processIds });
        }
        return { ...state, terminalProcesses };
      });
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    yield* Ref.update(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      terminalProcesses.delete(terminalOwnerKey(input));
      return { ...state, terminalProcesses };
    });
  });

  return PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);
