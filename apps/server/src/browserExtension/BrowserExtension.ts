// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- the pairing file and the relay are plain Node, shared with tests.
/**
 * The SpecWithCode Browser extension on this machine: the pairing code, the
 * loopback WebSocket route every paired Chrome profile keeps open, the
 * Settings › Chrome RPCs, and the hub the `chrome_*` MCP tools drive.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  BROWSER_EXTENSION_STORE_ID,
  BROWSER_EXTENSION_STORE_URL,
  type BrowserExtensionCheck,
  type BrowserExtensionPairing,
  type BrowserExtensionPeer,
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
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { EXTENSION_VERSION } from "./extensionVersion.generated.ts";
import { BrowserRelayHub, type RelaySocket } from "./relayHub.ts";
import {
  BROWSER_EXTENSION_DIR,
  PAIRING_FILE,
  type PairingState,
  parsePairingState,
} from "./pairingState.ts";

export const BROWSER_RELAY_PATH = "/api/browser-relay";
export const PAIRING_PREFIX = "swc-chrome:1:";

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
  /** Records that a Chrome profile presented the current code, once per code. */
  readonly markConnected: () => void;
  /** Forgets that record, so Claude threads keep Claude in Chrome until a profile pairs again. */
  readonly markUnpaired: () => void;
}

/** The token lives in the state folder, readable only by this user. */
function filePairingStore(dir: string): PairingStore {
  const file = NodePath.join(dir, PAIRING_FILE);
  let cached: PairingState | null = null;
  const write = (state: PairingState & { readonly token: string }) => {
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(
      file,
      JSON.stringify(
        state.connectedAt === null
          ? { token: state.token }
          : { token: state.token, connectedAt: state.connectedAt },
      ),
      { mode: 0o600 },
    );
    cached = state;
    return state;
  };
  const load = (): PairingState & { readonly token: string } => {
    if (cached?.token) return { token: cached.token, connectedAt: cached.connectedAt };
    try {
      const state = parsePairingState(NodeFS.readFileSync(file, "utf8"));
      if (state.token !== null) {
        cached = state;
        return { token: state.token, connectedAt: state.connectedAt };
      }
    } catch {
      // First use, or an unreadable file: start over with a new code.
    }
    return write({ token: newPairingToken(), connectedAt: null });
  };
  return {
    read: () => load().token,
    reset: () => write({ token: newPairingToken(), connectedAt: null }).token,
    markConnected: () => {
      const state = load();
      if (state.connectedAt !== null) return;
      try {
        write({ token: state.token, connectedAt: new Date().toISOString() });
      } catch {
        // The relay keeps working; Claude threads just keep Claude in Chrome.
      }
    },
    markUnpaired: () => {
      const state = load();
      if (state.connectedAt === null) return;
      try {
        write({ token: state.token, connectedAt: null });
      } catch {
        // Claude threads keep starting without Claude in Chrome until the code is reset.
      }
    },
  };
}

interface PeerRecord {
  readonly machine: string;
  readonly label: string;
  /** Its threads are known here as `peer:<environmentId>:<threadId>`. */
  readonly environmentId: string;
  readonly state: BrowserExtensionPeer["state"];
  readonly requestedAt: string;
}

const MAX_PEERS = 50;

/**
 * Other machines' worker grants and the owner's answer to each, by session
 * id. A grant's name is the caller's own choice, so its use of this Chrome
 * waits for the owner to allow that one grant here.
 */
function filePeerStore(dir: string, onEvicted: (record: PeerRecord) => void) {
  const file = NodePath.join(dir, "peers.json");
  let peers: Map<string, PeerRecord> | null = null;
  const load = () => {
    if (peers) return peers;
    peers = new Map();
    try {
      const saved = JSON.parse(NodeFS.readFileSync(file, "utf8"))?.peers;
      if (saved && typeof saved === "object")
        for (const [id, record] of Object.entries(saved as Record<string, PeerRecord>))
          if (record && (record.state === "allowed" || record.state === "declined"))
            peers.set(id, record);
    } catch {
      // No answers yet.
    }
    return peers;
  };
  const save = () => {
    // Only answers outlive a restart; a request asks again.
    const answered = Object.fromEntries(
      [...load()].filter(([, record]) => record.state !== "pending"),
    );
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(file, JSON.stringify({ peers: answered }), { mode: 0o600 });
  };
  return {
    list: () => [...load()],
    get: (id: string) => load().get(id),
    set: (id: string, record: PeerRecord) => {
      const all = load();
      all.delete(id);
      all.set(id, record);
      // Forget unanswered requests first, then declines, then the oldest allowed.
      let evicted = false;
      for (const state of ["pending", "declined", "allowed"] as const)
        for (const [key, value] of all) {
          if (all.size <= MAX_PEERS) break;
          if (key !== id && value.state === state) {
            all.delete(key);
            evicted = true;
            onEvicted(value);
          }
        }
      if (record.state !== "pending" || evicted) save();
    },
    remove: (id: string) => {
      load().delete(id);
      save();
    },
  };
}

export interface BrowserExtensionShape {
  readonly hub: BrowserRelayHub;
  readonly relayUrl: string;
  readonly pairing: (reset: boolean) => BrowserExtensionPairing;
  readonly status: () => BrowserExtensionStatus;
  readonly check: () => Promise<BrowserExtensionCheck>;
  /**
   * Whether another machine's grant may use this Chrome. The first request
   * is recorded as pending for the owner to answer in Settings › Chrome.
   */
  readonly peerAccess: (input: {
    readonly id: string;
    readonly machine: string;
    readonly label: string;
    readonly environmentId: string;
  }) => BrowserExtensionPeer["state"];
  /** The owner's answer so far, without recording a request. */
  readonly peerState: (id: string) => BrowserExtensionPeer["state"] | undefined;
  /** The owner's answer; taking access back also lets go of that machine's tabs. */
  readonly answerPeer: (id: string, allow: boolean) => Promise<void>;
}

export class BrowserExtension extends Context.Service<BrowserExtension, BrowserExtensionShape>()(
  "specweave-studio/browserExtension/BrowserExtension",
) {}

export function makeBrowserExtension(options: {
  readonly stateDir: string;
  readonly port: number;
  readonly machineName?: string;
}): BrowserExtensionShape {
  const dir = NodePath.join(options.stateDir, BROWSER_EXTENSION_DIR);
  const store = filePairingStore(dir);
  // A forgotten machine loses access like a declined one: let go of its tabs.
  const peerStore = filePeerStore(dir, (record) => {
    const stillAllowed = peerStore
      .list()
      .some(
        ([, other]) => other.environmentId === record.environmentId && other.state === "allowed",
      );
    if (!stillAllowed) void hub.stopThreadsWithPrefix(`peer:${record.environmentId}:`);
  });
  const machine = options.machineName ?? NodeOS.hostname().replace(/\.local$/, "");
  const relayUrl = `ws://127.0.0.1:${options.port}${BROWSER_RELAY_PATH}`;
  const hub = new BrowserRelayHub({
    verifyToken: (token) => {
      const ok = tokensEqual(store.read(), token);
      if (ok) store.markConnected();
      return ok;
    },
    machineName: () => machine,
    onUnpaired: () => store.markUnpaired(),
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
    status: () => ({
      relayUrl,
      bundledVersion: EXTENSION_VERSION,
      storeUrl: BROWSER_EXTENSION_STORE_URL,
      profiles: hub.profileSummaries().map(({ extensionId, ...profile }) => ({
        ...profile,
        fromStore: extensionId === BROWSER_EXTENSION_STORE_ID,
      })),
      recentActions: [...hub.recentActions()],
      peers: peerStore.list().map(([id, record]) => ({
        id,
        machine: record.machine,
        label: record.label,
        state: record.state,
        requestedAt: record.requestedAt,
      })),
    }),
    check,
    peerState: (id) => peerStore.get(id)?.state,
    peerAccess: (input) => {
      const known = peerStore.get(input.id);
      if (known) return known.state;
      peerStore.set(input.id, {
        machine: input.machine,
        label: input.label,
        environmentId: input.environmentId,
        state: "pending",
        requestedAt: new Date().toISOString(),
      });
      hub.changed();
      return "pending";
    },
    answerPeer: async (id, allow) => {
      const known = peerStore.get(id);
      if (!known) return;
      peerStore.set(id, { ...known, state: allow ? "allowed" : "declined" });
      if (!allow) await hub.stopThreadsWithPrefix(`peer:${known.environmentId}:`);
      hub.changed();
    },
  };
}

export const layer = Layer.effect(
  BrowserExtension,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // The popup names this computer as the app does (its computer name), not by its host name.
    const { label } = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    return makeBrowserExtension({
      stateDir: config.stateDir,
      port: config.port,
      machineName: label,
    });
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
        // The extension says why it closed ("unpaired" from its popup) in the close frame.
        let closeReason: string | undefined;
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
        ).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.reason._tag === "SocketCloseError") closeReason = error.reason.closeReason;
            }),
          ),
        );
        return yield* Effect.raceFirst(send, receive).pipe(
          Effect.ensuring(Effect.sync(() => session.closed(closeReason))),
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
      [WS_METHODS.browserExtensionPeer]: (payload) =>
        Effect.promise(async () => {
          await extension.answerPeer(payload.id, payload.allow);
          return extension.status();
        }),
    };
  }),
);
