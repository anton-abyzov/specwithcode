// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- the pairing file and the relay are plain Node, shared with tests.
/**
 * The SpecWithCode Browser extension on this machine: the pairing code, the
 * loopback WebSocket route every paired Chrome profile keeps open, the
 * Settings › Chrome RPCs, and the hub the `chrome_*` MCP tools drive.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  type BrowserExtensionCheck,
  type BrowserExtensionPairing,
  type BrowserExtensionStatus,
  WS_METHODS,
  WsBrowserExtensionRpcGroup,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { EXTENSION_FILES, EXTENSION_VERSION } from "./extensionFiles.generated.ts";
import { BrowserRelayHub, type RelaySocket } from "./relayHub.ts";

export const BROWSER_RELAY_PATH = "/api/browser-relay";
export const PAIRING_PREFIX = "swc-chrome:1:";
/** Set once the listing is public on the Chrome Web Store. */
export const CHROME_WEB_STORE_URL: string | null = null;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function newPairingToken(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

export function encodePairingCode(relayUrl: string, token: string, machine: string): string {
  const json = JSON.stringify({ u: relayUrl, t: token, m: machine });
  return PAIRING_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

export function tokensEqual(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && a.length > 0 && NodeCrypto.timingSafeEqual(a, b);
}

/**
 * Only the extension, from this computer, may open the relay: a loopback peer,
 * an extension origin, and no proxy in between (a tunnel or `tailscale serve`
 * also arrives from loopback but adds forwarding headers).
 */
export function relayRequestAllowed(input: {
  readonly remoteAddress: string | undefined;
  readonly origin: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (!input.remoteAddress || !LOOPBACK_ADDRESSES.has(input.remoteAddress)) return false;
  if (!input.origin?.startsWith("chrome-extension://")) return false;
  for (const header of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip"])
    if (input.headers[header] !== undefined) return false;
  return true;
}

interface PairingStore {
  readonly read: () => string;
  readonly reset: () => string;
}

/** The token lives in the state folder, readable only by this user. */
function filePairingStore(dir: string): PairingStore {
  const file = NodePath.join(dir, "pairing.json");
  let cached: string | null = null;
  const write = (token: string) => {
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
    cached = token;
    return token;
  };
  return {
    read: () => {
      if (cached !== null) return cached;
      try {
        const token = JSON.parse(NodeFS.readFileSync(file, "utf8"))?.token;
        if (typeof token === "string" && token.length >= 32) return (cached = token);
      } catch {
        // First use, or an unreadable file: start over with a new code.
      }
      return write(newPairingToken());
    },
    reset: () => write(newPairingToken()),
  };
}

export interface BrowserExtensionShape {
  readonly hub: BrowserRelayHub;
  readonly relayUrl: string;
  readonly pairing: (reset: boolean) => BrowserExtensionPairing;
  readonly installFolder: () => { readonly path: string; readonly version: string };
  readonly status: () => BrowserExtensionStatus;
  readonly check: () => Promise<BrowserExtensionCheck>;
}

export class BrowserExtension extends Context.Service<BrowserExtension, BrowserExtensionShape>()(
  "specweave-studio/browserExtension/BrowserExtension",
) {}

export function makeBrowserExtension(options: {
  readonly stateDir: string;
  readonly port: number;
  readonly machineName?: string;
}): BrowserExtensionShape {
  const dir = NodePath.join(options.stateDir, "browser-extension");
  const store = filePairingStore(dir);
  const machine = options.machineName ?? NodeOS.hostname().replace(/\.local$/, "");
  const relayUrl = `ws://127.0.0.1:${options.port}${BROWSER_RELAY_PATH}`;
  const hub = new BrowserRelayHub({
    verifyToken: (token) => tokensEqual(store.read(), token),
    machineName: () => machine,
  });

  const check = async (): Promise<BrowserExtensionCheck> => {
    const profiles = hub.profiles();
    const checkedAt = new Date().toISOString();
    if (profiles.length === 0)
      return {
        state: "not_connected",
        profiles: [],
        message:
          "No Chrome profile is paired and connected. Open Chrome, click the SpecWithCode icon and paste the pairing code.",
        checkedAt,
      };
    const results = await Promise.all(
      profiles.map(async (profile) => {
        const started = Date.now();
        try {
          const tabs = (await hub.call(profile.id, "chrome.tabs.query", [{}], 5_000)) as unknown[];
          return {
            id: profile.id,
            label: profile.label,
            ok: true,
            tabCount: Array.isArray(tabs) ? tabs.length : 0,
            roundTripMs: Date.now() - started,
          };
        } catch (error) {
          return {
            id: profile.id,
            label: profile.label,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const allOk = results.every((result) => result.ok);
    return {
      state: allOk ? "connected" : "error",
      profiles: results,
      ...(allOk ? {} : { message: "A paired Chrome profile did not answer." }),
      checkedAt,
    };
  };

  return {
    hub,
    relayUrl,
    pairing: (reset) => {
      const token = reset ? store.reset() : store.read();
      if (reset) hub.disconnectAll("pairing code reset");
      return { pairingCode: encodePairingCode(relayUrl, token, machine), relayUrl };
    },
    installFolder: () => {
      // One stable folder, so Chrome's Load unpacked keeps pointing at it after updates.
      const target = NodePath.join(dir, "chrome");
      NodeFS.rmSync(target, { recursive: true, force: true });
      for (const file of EXTENSION_FILES) {
        const out = NodePath.join(target, file.path);
        NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
        NodeFS.writeFileSync(out, Buffer.from(file.base64, "base64"));
      }
      return { path: target, version: EXTENSION_VERSION };
    },
    status: () => ({
      relayUrl,
      bundledVersion: EXTENSION_VERSION,
      storeUrl: CHROME_WEB_STORE_URL,
      profiles: hub.profileSummaries(),
      recentActions: [...hub.recentActions()],
    }),
    check,
  };
}

export const layer = Layer.effect(
  BrowserExtension,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return makeBrowserExtension({ stateDir: config.stateDir, port: config.port });
  }),
);

// ── The relay route ─────────────────────────────────────────────────────────

const relayHandler = (extension: BrowserExtensionShape) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (
      Option.isNone(url) ||
      url.value.pathname !== BROWSER_RELAY_PATH ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    )
      return HttpServerResponse.text("Not Found", { status: 404 });
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    if (
      !relayRequestAllowed({
        remoteAddress: incoming.socket.remoteAddress,
        origin: request.headers.origin,
        headers: request.headers,
      })
    )
      return HttpServerResponse.text("Forbidden", { status: 403 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const outgoing = yield* Queue.unbounded<string | Socket.CloseEvent>();
        const relaySocket: RelaySocket = {
          send: (text) => {
            Queue.offerUnsafe(outgoing, text);
          },
          close: (code, reason) => {
            Queue.offerUnsafe(outgoing, new Socket.CloseEvent(code, reason));
          },
        };
        const session = extension.hub.open(relaySocket);
        const decoder = new TextDecoder();
        const send = Effect.forever(
          Queue.take(outgoing).pipe(
            Effect.flatMap((item) =>
              writer
                .write(item)
                .pipe(
                  Effect.andThen(
                    item instanceof Socket.CloseEvent ? Effect.interrupt : Effect.void,
                  ),
                ),
            ),
          ),
        );
        const receive = Effect.forever(
          reader.pull.pipe(
            Effect.map((chunks) => {
              for (const chunk of chunks)
                session.receive(typeof chunk === "string" ? chunk : decoder.decode(chunk));
            }),
          ),
        );
        return yield* Effect.raceFirst(send, receive).pipe(
          Effect.ensuring(Effect.sync(() => session.closed())),
        );
      }),
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
  });

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const extension = yield* BrowserExtension;
    yield* router.add("GET", BROWSER_RELAY_PATH, relayHandler(extension));
  }),
);

// ── Settings › Chrome RPCs ──────────────────────────────────────────────────

export const layerRpcHandlers = WsBrowserExtensionRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const extension = yield* BrowserExtension;
    const failed = (error: unknown): BrowserExtensionCheck => ({
      state: "error",
      profiles: [],
      message: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    });
    return {
      [WS_METHODS.browserExtensionStatus]: () => Effect.sync(() => extension.status()),
      [WS_METHODS.browserExtensionPairing]: (payload) =>
        Effect.sync(() => extension.pairing(payload.reset === true)),
      [WS_METHODS.browserExtensionTest]: () =>
        Effect.promise(() => extension.check().catch(failed)),
      [WS_METHODS.browserExtensionReconnect]: () =>
        Effect.promise(async () => {
          extension.hub.requestReconnect();
          // Sockets close and come back within a couple of seconds.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          await extension.hub.waitForProfiles(6_000);
          return extension.check().catch(failed);
        }),
      [WS_METHODS.browserExtensionStop]: (payload) =>
        Effect.promise(async () => {
          await extension.hub.stop(payload.profileId, payload.threadId);
          return extension.status();
        }),
      [WS_METHODS.browserExtensionInstallFolder]: () =>
        Effect.sync(() => extension.installFolder()),
    };
  }),
);
