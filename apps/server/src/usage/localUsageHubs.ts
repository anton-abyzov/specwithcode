/**
 * Finds a CLIProxyAPI installed on this machine, so its quota can be added to
 * Usage without the person copying a URL and a management key by hand.
 *
 * Only fixed install locations are read, and the hub is always reached over
 * loopback. The management key is read from the install's own key file when
 * the hub is adopted and goes straight to the secret store; detection reports
 * whether that file exists, never what it holds.
 *
 * @module usage/localUsageHubs
 */
import {
  UsageLimitSourceId,
  type LocalUsageHub,
  type LocalUsageHubId,
  type UsageLimitSourceConfig,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

const DEFAULT_PORT = 8317;
/** A key file is one short line; anything else is not a key and is not sent anywhere. */
const MAX_KEY_LENGTH = 512;

export const LOCAL_HUB_LABEL = "CLI Proxy on this machine";

interface LocalHubLayout {
  readonly id: LocalUsageHubId;
  readonly configPaths: ReadonlyArray<string>;
  readonly keyPath: string | null;
}

/** Where a CLIProxyAPI install keeps its config, most specific layout first. */
export function localHubLayouts(home: string, path: Path.Path): ReadonlyArray<LocalHubLayout> {
  const specweave = path.join(home, ".local", "share", "specweave", "proxy");
  return [
    {
      id: "specweave",
      configPaths: [path.join(specweave, "config.yaml")],
      keyPath: path.join(specweave, "secrets", "management-key.txt"),
    },
    {
      id: "home",
      configPaths: [path.join(home, ".cli-proxy-api", "config.yaml")],
      keyPath: null,
    },
    {
      id: "homebrew",
      configPaths: ["/opt/homebrew/etc/cliproxyapi.conf", "/usr/local/etc/cliproxyapi.conf"],
      keyPath: null,
    },
  ];
}

/** The top-level `port:` of a CLIProxyAPI config, or its default when unset or out of range. */
export function proxyPort(config: string): number {
  const port = Number(/^port:[ \t]*["']?(\d{1,5})["']?[ \t]*(?:#.*)?$/m.exec(config)?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a configured source already points at the hub listening on `port` of this machine. */
export function isLocalHubSource(source: UsageLimitSourceConfig, port: number): boolean {
  try {
    const url = new URL(source.url);
    const sourcePort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return LOOPBACK.has(url.hostname.toLowerCase()) && sourcePort === port;
  } catch {
    return false;
  }
}

/** The id the settings dialog would give the same URL, so both paths name one entry. */
export function localHubSourceId(port: number): UsageLimitSourceId {
  return UsageLimitSourceId.make(`cliproxy-127.0.0.1-${port}`);
}

/** One trimmed line, or null when the file does not look like a key. */
export function managementKeyFromFile(contents: string): string | null {
  const key = contents.trim();
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && !/\s/.test(key) ? key : null;
}

export interface DetectedLocalHub extends LocalUsageHub {
  readonly keyPath: string | null;
}

export const detectLocalUsageHubs = Effect.fn("localUsageHubs.detect")(function* (input: {
  readonly home: string;
  readonly sources: Readonly<Record<string, UsageLimitSourceConfig>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  const hubs: Array<DetectedLocalHub> = [];
  for (const layout of localHubLayouts(input.home, path)) {
    let configPath: string | null = null;
    for (const candidate of layout.configPaths) {
      if (yield* exists(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (configPath === null) continue;
    const config = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
    const port = proxyPort(config);
    // Two layouts on one port are one hub; the first, most specific layout names it.
    if (hubs.some((hub) => hub.url === `http://127.0.0.1:${port}`)) continue;
    const url = `http://127.0.0.1:${port}`;
    const running = yield* client.get(`${url}/`).pipe(
      Effect.timeout("1500 millis"),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const keyAvailable =
      layout.keyPath !== null &&
      managementKeyFromFile(
        yield* fs.readFileString(layout.keyPath).pipe(Effect.orElseSucceed(() => "")),
      ) !== null;
    const configured = Object.entries(input.sources).find(([, source]) =>
      isLocalHubSource(source, port),
    );
    hubs.push({
      id: layout.id,
      url,
      configPath,
      running,
      keyAvailable,
      sourceId: configured ? UsageLimitSourceId.make(configured[0]) : null,
      keyPath: keyAvailable ? layout.keyPath : null,
    });
  }
  return hubs;
});

/** Strips what only the server may know before a detection result goes to a client. */
export function toLocalUsageHub({ keyPath: _keyPath, ...hub }: DetectedLocalHub): LocalUsageHub {
  return hub;
}
