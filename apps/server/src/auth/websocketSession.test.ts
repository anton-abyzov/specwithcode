// @effect-diagnostics nodeBuiltinImport:off - serves real WebSocket upgrades from a Node HTTP server.
import * as NodeHttp from "node:http";
import * as Net from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  LOCAL_DEVICE_HOST_ID,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DeviceHubProxy from "../device/DeviceHubProxy.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { serveRpcWebSocket } from "../ws.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { routeLayer as previewStreamRoutes } from "../preview/ServerBrowserStream.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  authenticateMediaRequest,
  serveSocketUntilSessionEnds,
  upgradeUntilSessionEnds,
} from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const metadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-ws-session-test-" })),
);

const PingGroup = RpcGroup.make(Rpc.make("ping", { payload: {}, success: Schema.String }));
const pingHandlers = PingGroup.toLayer({ ping: () => Effect.succeed("pong") });

/**
 * `/ws` authenticates and serves RPC the way ws.ts does; `/media` is a raw
 * socket the way the device hub and preview stream use one. Each records the
 * authentication outcome.
 */
const startServer = Effect.gen(function* () {
  const outcomes: Array<string> = [];
  const record = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tap(() => Effect.sync(() => outcomes.push("accepted"))),
      Effect.tapError((error) =>
        Effect.sync(() =>
          outcomes.push(
            typeof error === "object" && error !== null && "_tag" in error
              ? String(error._tag)
              : "failed",
          ),
        ),
      ),
    );
  const rpc = HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* record(auth.authenticateWebSocketUpgrade(request));
      const httpEffect = yield* RpcServer.toHttpEffectWebsocket(PingGroup).pipe(
        Effect.provide(Layer.merge(pingHandlers, RpcSerialization.layerJson)),
      );
      return yield* upgradeUntilSessionEnds(session, httpEffect);
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("denied", { status: 401 }))),
  );
  const media = HttpRouter.add(
    "GET",
    "/media",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* record(authenticateMediaRequest(AuthOrchestrationReadScope));
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* request.upgrade;
          const reader = yield* socket.reader;
          yield* serveSocketUntilSessionEnds(socket, session, Effect.forever(reader.pull));
          return HttpServerResponse.empty();
        }),
      );
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("denied", { status: 401 }))),
  );
  const context = yield* Layer.build(
    HttpRouter.serve(Layer.merge(rpc, media), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(layerAuth),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
      ),
    ),
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  const port = NetAddress.isInetAddress(address) ? address.port : 0;
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const sessions = Context.get(context, SessionStore.SessionStore);
  const cookieSession = Effect.gen(function* () {
    const pairing = yield* auth.issuePairingCredential({ scopes: [AuthOrchestrationReadScope] });
    const exchanged = yield* auth.createBrowserSession(pairing.credential, metadata);
    const verified = yield* sessions.verify(exchanged.sessionToken);
    return {
      sessionId: verified.sessionId,
      cookie: `${sessions.cookieName}=${exchanged.sessionToken}`,
    };
  });
  return { origin: `http://127.0.0.1:${port}`, port, outcomes, auth, sessions, cookieSession };
});

const listenLayer = () =>
  NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" });

const portOf = (context: Context.Context<HttpServer.HttpServer>) => {
  const address = Context.get(context, HttpServer.HttpServer).address;
  return NetAddress.isInetAddress(address) ? address.port : 0;
};

/**
 * The real device hub proxy, in front of a fake hub with one socket and one
 * endless MJPEG stream, and the real preview stream route over a browser
 * whose tab never draws.
 */
const startProductionRoutes = Effect.gen(function* () {
  const hub = yield* Layer.build(
    HttpRouter.serve(
      Layer.merge(
        HttpRouter.add(
          "GET",
          "/api/devices/ws",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const socket = yield* request.upgrade;
                const reader = yield* socket.reader;
                return yield* Effect.forever(reader.pull);
              }),
            );
          }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty())),
        ),
        HttpRouter.add(
          "GET",
          "/vendor/serve-sim/helper/sim/stream.mjpeg",
          Effect.succeed(
            HttpServerResponse.stream(
              Stream.tick("20 millis").pipe(Stream.map(() => new TextEncoder().encode("frame"))),
              { contentType: "multipart/x-mixed-replace; boundary=frame" },
            ),
          ),
        ),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provideMerge(listenLayer())),
  );
  const hubOrigin = `http://127.0.0.1:${portOf(hub)}`;
  const devices = Layer.succeed(DeviceService.DeviceService, {
    currentReadiness: () =>
      Effect.succeed({ hostId: LOCAL_DEVICE_HOST_ID, hub: { origin: hubOrigin } }),
  } as unknown as DeviceService.DeviceService["Service"]);
  const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
  const browser = ServerBrowser.ServerBrowser.of({
    clearProfile: () => Effect.void,
    openDownload: () => Effect.succeedNone,
    answerFileChooser: () => Effect.succeed(false),
    attachViewer: () => Effect.succeed({ output, input: () => Effect.void }),
  });
  const recorded = { connections: 0, analytics: 0 };
  // The real `/ws` route, around a one-method RPC server.
  const rpc = HttpRouter.add(
    "GET",
    "/ws",
    serveRpcWebSocket(() =>
      RpcServer.toHttpEffectWebsocket(PingGroup).pipe(
        Effect.provide(Layer.merge(pingHandlers, RpcSerialization.layerJson)),
      ),
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("denied", { status: 401 }))),
  );
  const countingSessions = Layer.effect(
    SessionStore.SessionStore,
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      return SessionStore.SessionStore.of({
        ...sessions,
        recordClientConnection: (...args) => {
          recorded.connections += 1;
          return sessions.recordClientConnection(...args);
        },
      });
    }),
  );
  const analytics = Layer.succeed(
    AnalyticsService.AnalyticsService,
    AnalyticsService.AnalyticsService.of({
      record: () => Effect.sync(() => void (recorded.analytics += 1)),
      flush: Effect.void,
    }),
  );
  const context = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        rpc,
        DeviceHubProxy.layer,
        previewStreamRoutes.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      // The routes read these per request, so they belong to the server.
      Layer.provide(countingSessions),
      Layer.provideMerge(analytics),
      Layer.provideMerge(devices),
      Layer.provideMerge(NodeHttpClient.layerNodeHttp),
      Layer.provideMerge(layerAuth),
      Layer.provideMerge(listenLayer()),
    ),
  );
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const sessions = Context.get(context, SessionStore.SessionStore);
  const session = (ttl?: Duration.Duration) =>
    Effect.gen(function* () {
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        ...(ttl ? { ttl } : {}),
      });
      const ticket = yield* auth.issueWebSocketTicket(issued);
      const secondTicket = yield* auth.issueWebSocketTicket(issued);
      return { ...issued, ticket: ticket.ticket, secondTicket: secondTicket.ticket };
    });
  const cookieSession = Effect.gen(function* () {
    const pairing = yield* auth.issuePairingCredential({ scopes: [AuthOrchestrationReadScope] });
    const exchanged = yield* auth.createBrowserSession(pairing.credential, metadata);
    const verified = yield* sessions.verify(exchanged.sessionToken);
    return {
      sessionId: verified.sessionId,
      cookie: `${sessions.cookieName}=${exchanged.sessionToken}`,
    };
  });
  return {
    origin: `http://127.0.0.1:${portOf(context)}`,
    sessions,
    session,
    cookieSession,
    recorded,
  };
});

/** Opens a socket the way a browser would, with the headers a browser sends. */
const connect = (url: string, headers: Record<string, string>) =>
  Effect.sync(() => {
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    const opened = new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true));
      // A refused handshake reports only an error, never a close.
      socket.addEventListener("error", () => resolve(false));
      socket.addEventListener("close", () => resolve(false));
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    const messages: Array<string> = [];
    const waiting: Array<() => void> = [];
    socket.addEventListener("message", (event) => {
      messages.push(String(event.data));
      for (const wake of waiting.splice(0)) wake();
    });
    const message = (match: string) =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const check = () => {
              const found = messages.find((text) => text.includes(match));
              if (found === undefined) waiting.push(check);
              else resolve(found);
            };
            check();
          }),
      );
    return {
      opened: Effect.promise(() => opened),
      closed: Effect.promise(() => closed),
      close: Effect.sync(() => socket.close()),
      isClosed: Effect.sync(() => socket.readyState >= WebSocket.CLOSING),
      /** Sends one ping RPC and waits for its answer. */
      ping: (id: string) =>
        Effect.sync(() => socket.send(pingRequest(id))).pipe(
          Effect.andThen(message(`"requestId":"${id}"`)),
        ),
    };
  });

const pingRequest = (id: string) =>
  JSON.stringify({ _tag: "Request", id, tag: "ping", payload: {}, headers: [] });

interface Frame {
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * A WebSocket client that speaks the frames itself and never answers a close
 * frame, the way a stalled or hostile client would.
 */
const connectIgnoringClose = (port: number, path: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<{
        readonly nextFrame: () => Promise<Frame>;
        readonly frames: Array<Frame>;
        readonly sendText: (text: string) => void;
        readonly closed: Promise<void>;
      }>((resolve, reject) => {
        const socket = Net.connect(port, "127.0.0.1");
        const frames: Array<Frame> = [];
        const waiting: Array<() => void> = [];
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        let read = 0;
        const closed = new Promise<void>((done) => socket.on("close", () => done()));
        const client = {
          frames,
          closed,
          nextFrame: () =>
            new Promise<Frame>((done) => {
              const check = () => {
                const frame = frames[read];
                if (frame === undefined) waiting.push(check);
                else {
                  read += 1;
                  done(frame);
                }
              };
              check();
            }),
          sendText: (text: string) => {
            const payload = Buffer.from(text);
            const mask = Buffer.from([1, 2, 3, 4]);
            const header =
              payload.length < 126
                ? Buffer.from([0x81, 0x80 | payload.length])
                : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
            const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
            socket.write(Buffer.concat([header, mask, masked]));
          },
        };
        socket.on("error", (error) => {
          if (!upgraded) reject(error);
        });
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!upgraded) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const head = buffer.subarray(0, end).toString();
            buffer = buffer.subarray(end + 4);
            if (!head.startsWith("HTTP/1.1 101")) {
              reject(new Error(head));
              return;
            }
            upgraded = true;
            resolve(client);
          }
          while (buffer.length >= 2) {
            let length = buffer[1]! & 0x7f;
            let offset = 2;
            if (length === 126) {
              if (buffer.length < 4) break;
              length = buffer.readUInt16BE(2);
              offset = 4;
            }
            if (buffer.length < offset + length) break;
            frames.push({
              opcode: buffer[0]! & 0x0f,
              payload: buffer.subarray(offset, offset + length),
            });
            buffer = buffer.subarray(offset + length);
          }
          for (const wake of waiting.splice(0)) wake();
        });
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
            "",
            "",
          ].join("\r\n"),
        );
      }),
  );

const rpcUrl = (origin: string, query = "") =>
  `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}${query}`;

const live = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("cookie-authenticated upgrades", () => {
  it.live("refuse a socket from another origin and accept one from the server's own", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startServer;
        const { cookie } = yield* server.cookieSession;

        const foreign = yield* connect(rpcUrl(server.origin), {
          cookie,
          origin: "http://127.0.0.1:1",
        });
        assert.isFalse(yield* foreign.opened);
        const missing = yield* connect(rpcUrl(server.origin), { cookie });
        assert.isFalse(yield* missing.opened);
        const sameSitePage = yield* connect(rpcUrl(server.origin), {
          cookie,
          origin: "http://localhost:" + server.port,
          "sec-fetch-site": "same-site",
        });
        assert.isFalse(yield* sameSitePage.opened);

        const own = yield* connect(rpcUrl(server.origin), { cookie, origin: server.origin });
        assert.isTrue(yield* own.opened);
        yield* own.close;
        yield* own.closed;

        const mediaForeign = yield* connect(`${server.origin.replace(/^http/, "ws")}/media`, {
          cookie,
          origin: "http://127.0.0.1:1",
        });
        assert.isFalse(yield* mediaForeign.opened);

        assert.deepStrictEqual(server.outcomes, [
          "ServerAuthInvalidCredentialError",
          "ServerAuthInvalidCredentialError",
          "ServerAuthInvalidCredentialError",
          "accepted",
          "EnvironmentAuthInvalidError",
        ]);
      }),
    ),
  );

  it.live("leave ticket and bearer upgrades from any origin alone", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startServer;
        const bearer = yield* server.auth.issueSession();
        const ticket = yield* server.auth.issueWebSocketTicket({ sessionId: bearer.sessionId });

        const withTicket = yield* connect(rpcUrl(server.origin, `&wsTicket=${ticket.ticket}`), {
          origin: "http://127.0.0.1:1",
        });
        assert.isTrue(yield* withTicket.opened);
        yield* withTicket.close;
        const withBearer = yield* connect(rpcUrl(server.origin), {
          authorization: `Bearer ${bearer.token}`,
          origin: "http://127.0.0.1:1",
        });
        assert.isTrue(yield* withBearer.opened);
        yield* withBearer.close;
        assert.deepStrictEqual(server.outcomes, ["accepted", "accepted"]);
      }),
    ),
  );

  it.effect("accept trusted and forwarded same-origin requests and plain media reads", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* auth.issuePairingCredential({ scopes: [AuthOrchestrationReadScope] });
      const exchanged = yield* auth.createBrowserSession(pairing.credential, metadata);
      const request = (input: {
        readonly method?: string;
        readonly headers: Record<string, string>;
      }) =>
        ({
          url: "/ws",
          originalUrl: "/ws",
          method: input.method ?? "GET",
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { cookie: `${sessions.cookieName}=x`, ...input.headers },
        }) as unknown as HttpServerRequest.HttpServerRequest;
      const upgrade = { upgrade: "websocket", host: "127.0.0.1:8319" };

      // The Mac app's renderer, and a private HTTPS name behind a proxy.
      yield* auth.authenticateWebSocketUpgrade(
        request({ headers: { ...upgrade, origin: "studio://app" } }),
      );
      yield* auth.authenticateWebSocketUpgrade(
        request({
          headers: {
            upgrade: "websocket",
            host: "mac.example.ts.net",
            "x-forwarded-proto": "https",
            origin: "https://mac.example.ts.net",
          },
        }),
      );
      // An <img> or download sends no Origin; another page cannot read it.
      yield* auth.authenticateWebSocketUpgrade(request({ headers: { host: "127.0.0.1:8319" } }));
      // A form post from another port is a state change.
      const post = yield* auth
        .authenticateWebSocketUpgrade(
          request({
            method: "POST",
            headers: { host: "127.0.0.1:8319", origin: "http://127.0.0.1:3000" },
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(post._tag, "ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerAuth.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

describe("sessions that end", () => {
  it.live("close their open sockets with 4401 when revoked", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startServer;
        const kept = yield* server.cookieSession;
        const revoked = yield* server.cookieSession;
        const keptSocket = yield* connect(rpcUrl(server.origin), {
          cookie: kept.cookie,
          origin: server.origin,
        });
        const rpcSocket = yield* connect(rpcUrl(server.origin), {
          cookie: revoked.cookie,
          origin: server.origin,
        });
        const mediaSocket = yield* connect(`${server.origin.replace(/^http/, "ws")}/media`, {
          cookie: revoked.cookie,
          origin: server.origin,
        });
        assert.isTrue(yield* keptSocket.opened);
        assert.isTrue(yield* rpcSocket.opened);
        assert.isTrue(yield* mediaSocket.opened);

        yield* server.sessions.revoke(revoked.sessionId);

        assert.strictEqual(yield* rpcSocket.closed, 4401);
        assert.strictEqual(yield* mediaSocket.closed, 4401);
        // Another session's revocation leaves this one open.
        yield* keptSocket.close;
        assert.notStrictEqual(yield* keptSocket.closed, 4401);
      }),
    ),
  );

  it.effect("ends a watch at expiry, at once when already revoked, and not for others", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const now = yield* DateTime.now;
      const expiring = yield* auth.issueSession();
      const other = yield* auth.issueSession();

      const expiryWatch = yield* sessions.watchEnd({
        sessionId: expiring.sessionId,
        expiresAt: DateTime.add(now, { minutes: 5 }),
      });
      const expiry = yield* Effect.forkChild(expiryWatch);
      yield* sessions.revoke(other.sessionId);
      yield* TestClock.adjust(Duration.minutes(4));
      assert.isUndefined(expiry.pollUnsafe());
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(expiry);

      // Revoked before the watch started: the row check ends it at once.
      yield* Fiber.join(yield* Effect.forkChild(yield* sessions.watchEnd(other)));
    }).pipe(Effect.provide(layerAuth.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it.live("keep token sockets open past expiry, close cookie ones, and close both on revoke", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startServer;
        const ttl = Duration.millis(1500);
        // Token clients get a new token without renewing the session their
        // socket is bound to: relay, mobile and hosted clients exchange an
        // hourly DPoP token, and the desktop app keeps one cached bearer.
        const dpop = yield* server.sessions.issue({
          method: "dpop-access-token",
          proofKeyThumbprint: "test-key-thumbprint",
          scopes: [AuthOrchestrationReadScope],
          ttl,
        });
        const bearer = yield* server.sessions.issue({
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope],
          ttl,
        });
        const browser = yield* server.sessions.issue({
          method: "browser-session-cookie",
          scopes: [AuthOrchestrationReadScope],
          ttl,
        });
        const dpopTicket = yield* server.auth.issueWebSocketTicket(dpop);
        const bearerTicket = yield* server.auth.issueWebSocketTicket(bearer);
        const dpopSocket = yield* connect(
          rpcUrl(server.origin, `&wsTicket=${dpopTicket.ticket}`),
          {},
        );
        const bearerSocket = yield* connect(
          rpcUrl(server.origin, `&wsTicket=${bearerTicket.ticket}`),
          {},
        );
        const cookieSocket = yield* connect(rpcUrl(server.origin), {
          cookie: `${server.sessions.cookieName}=${browser.token}`,
          origin: server.origin,
        });
        assert.isTrue(yield* dpopSocket.opened);
        assert.isTrue(yield* bearerSocket.opened);
        assert.isTrue(yield* cookieSocket.opened);

        // The cookie session, issued last, expires no earlier than the others.
        assert.strictEqual(yield* cookieSocket.closed, 4401);
        assert.include(yield* dpopSocket.ping("dpop-after-expiry"), "pong");
        assert.include(yield* bearerSocket.ping("bearer-after-expiry"), "pong");

        yield* server.sessions.revoke(dpop.sessionId);
        yield* server.sessions.revoke(bearer.sessionId);
        assert.strictEqual(yield* dpopSocket.closed, 4401);
        assert.strictEqual(yield* bearerSocket.closed, 4401);
      }),
    ),
  );

  it.effect("end a watch when another process revokes the session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      // `specweave-studio auth session revoke` runs its own store on the same
      // database; its change notice never reaches this process.
      const otherProcess = Context.get(
        yield* Layer.build(Layer.fresh(SessionStore.layer)),
        SessionStore.SessionStore,
      );
      const session = yield* auth.issueSession();
      const watch = yield* Effect.forkChild(
        yield* sessions.watchEnd({ sessionId: session.sessionId }),
      );

      yield* otherProcess.revoke(session.sessionId);
      yield* TestClock.adjust(Duration.seconds(29));
      assert.isUndefined(watch.pollUnsafe());
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(watch);
    }).pipe(Effect.provide(layerAuth.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it.live("stop serving a client that never answers the close, then drop it", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startServer;
        const { cookie, sessionId } = yield* server.cookieSession;
        const client = yield* connectIgnoringClose(
          server.port,
          `/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
          { cookie, origin: server.origin },
        );
        client.sendText(pingRequest("before"));
        const answer = yield* Effect.promise(() => client.nextFrame());
        assert.include(answer.payload.toString(), "pong");

        yield* server.sessions.revoke(sessionId);
        const close = yield* Effect.promise(() => client.nextFrame());
        assert.strictEqual(close.opcode, 0x8);
        assert.strictEqual(close.payload.readUInt16BE(0), 4401);

        // The client ignores the close and keeps sending; nothing answers.
        const sentAt = yield* Clock.currentTimeMillis;
        client.sendText(pingRequest("after"));
        yield* Effect.promise(() => client.closed);
        assert.isBelow((yield* Clock.currentTimeMillis) - sentAt, 5_000);
        assert.deepStrictEqual(
          client.frames.slice(2).map((frame) => frame.payload.toString()),
          [],
        );
      }),
    ),
  );
});

describe("cookie-authenticated HTTP requests", () => {
  it.effect("change state only from the server's own or a trusted origin", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* auth.issuePairingCredential({ scopes: [AuthOrchestrationReadScope] });
      const exchanged = yield* auth.createBrowserSession(pairing.credential, metadata);
      const bearer = yield* auth.issueSession();
      const request = (input: {
        readonly method: string;
        readonly headers: Record<string, string>;
        readonly bearer?: boolean;
      }) =>
        ({
          url: "/api/auth/clients/revoke-others",
          originalUrl: "/api/auth/clients/revoke-others",
          method: input.method,
          cookies: input.bearer ? {} : { [sessions.cookieName]: exchanged.sessionToken },
          headers: input.bearer
            ? { authorization: `Bearer ${bearer.token}`, ...input.headers }
            : { cookie: `${sessions.cookieName}=x`, ...input.headers },
        }) as unknown as HttpServerRequest.HttpServerRequest;
      const accepted = (input: Parameters<typeof request>[0]) =>
        auth.authenticateHttpRequest(request(input));
      const rejected = (input: Parameters<typeof request>[0]) =>
        auth.authenticateHttpRequest(request(input)).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      const host = "127.0.0.1:8319";

      // The web app on its own origin, and its reads from anywhere.
      yield* accepted({ method: "POST", headers: { host, origin: `http://${host}` } });
      yield* accepted({ method: "GET", headers: { host } });
      yield* accepted({ method: "GET", headers: { host, origin: "http://127.0.0.1:3000" } });
      // The Mac app's renderer, and a private HTTPS name behind `tailscale serve`.
      yield* accepted({ method: "POST", headers: { host, origin: "studio://app" } });
      yield* accepted({
        method: "POST",
        headers: {
          host: "mac.example.ts.net",
          "x-forwarded-proto": "https",
          origin: "https://mac.example.ts.net",
        },
      });
      // A dev page on a LAN address, proxied with the browser's Host kept.
      yield* accepted({
        method: "POST",
        headers: { host: "192.168.1.5:5173", origin: "http://192.168.1.5:5173" },
      });
      // A bearer token is not sent by another page, so its origin is not checked.
      yield* accepted({
        method: "POST",
        bearer: true,
        headers: { host, origin: "http://127.0.0.1:3000" },
      });

      // Another localhost page's simple POST, a cross-site fetch, and a proxy
      // that rewrote Host all fail.
      assert.strictEqual(
        yield* rejected({ method: "POST", headers: { host, origin: "http://127.0.0.1:3000" } }),
        "ServerAuthInvalidCredentialError",
      );
      assert.strictEqual(
        yield* rejected({ method: "DELETE", headers: { host, origin: "https://evil.example" } }),
        "ServerAuthInvalidCredentialError",
      );
      // OPTIONS is not a read: a route may act on it.
      assert.strictEqual(
        yield* rejected({ method: "OPTIONS", headers: { host, origin: "http://127.0.0.1:3000" } }),
        "ServerAuthInvalidCredentialError",
      );
      assert.strictEqual(
        yield* rejected({ method: "POST", headers: { host, "sec-fetch-site": "cross-site" } }),
        "ServerAuthInvalidCredentialError",
      );
      assert.strictEqual(
        yield* rejected({ method: "POST", headers: { host, origin: "http://192.168.1.5:5173" } }),
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(Effect.provide(layerAuth.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

describe("production socket and stream routes", () => {
  it.live("close the device hub and preview stream sockets with 4401 on revoke", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startProductionRoutes;
        const ws = server.origin.replace(/^http/, "ws");
        const device = yield* server.session();
        const preview = yield* server.session();
        const deviceSocket = yield* connect(
          `${ws}/api/device-hub/api/devices/ws?wsTicket=${device.ticket}`,
          {},
        );
        const previewSocket = yield* connect(
          `${ws}/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=${preview.ticket}`,
          {},
        );
        assert.isTrue(yield* deviceSocket.opened);
        assert.isTrue(yield* previewSocket.opened);

        yield* server.sessions.revoke(device.sessionId);
        assert.strictEqual(yield* deviceSocket.closed, 4401);
        yield* server.sessions.revoke(preview.sessionId);
        assert.strictEqual(yield* previewSocket.closed, 4401);
      }),
    ),
  );

  it.live("end a proxied device stream when its session is revoked", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startProductionRoutes;
        const viewer = yield* server.session();
        const reader = yield* Effect.promise(async () => {
          // @effect-diagnostics-next-line globalFetchInEffect:off -- reads the body as the panel's <img> does
          const response = await fetch(
            `${server.origin}/api/device-hub/vendor/serve-sim/helper/sim/stream.mjpeg`,
            { headers: { authorization: `Bearer ${viewer.token}` } },
          );
          assert.strictEqual(response.status, 200);
          return response.body!.getReader();
        });
        const first = yield* Effect.promise(() => reader.read());
        assert.isFalse(first.done);

        yield* server.sessions.revoke(viewer.sessionId);
        // The hub would stream forever; the body ends once the session does.
        const drained = yield* Effect.promise(async () => {
          while (!(await reader.read()).done) {
            // keep reading frames already in flight
          }
          return true;
        }).pipe(Effect.timeoutOption("5 seconds"));
        assert.isTrue(Option.isSome(drained));
      }),
    ),
  );

  it.live(
    "answer a plain GET on /ws with 426 before recording the client, and close on revoke",
    () =>
      live(
        Effect.gen(function* () {
          const server = yield* startProductionRoutes;
          const { cookie, sessionId } = yield* server.cookieSession;
          const url = rpcUrl(server.origin).replace(/^ws/, "http");
          for (const origin of [server.origin, "http://127.0.0.1:1"]) {
            const status = yield* Effect.promise(() =>
              // @effect-diagnostics-next-line globalFetchInEffect:off -- a page's plain GET, not a socket
              fetch(url, { headers: { cookie, origin } }).then((response) => response.status),
            );
            assert.strictEqual(status, 426);
          }
          assert.deepStrictEqual(server.recorded, { connections: 0, analytics: 0 });

          const socket = yield* connect(rpcUrl(server.origin), { cookie, origin: server.origin });
          assert.isTrue(yield* socket.opened);
          assert.include(yield* socket.ping("open"), "pong");
          assert.deepStrictEqual(server.recorded, { connections: 1, analytics: 1 });
          yield* server.sessions.revoke(sessionId);
          assert.strictEqual(yield* socket.closed, 4401);
        }),
      ),
  );

  it.live("keep an expired token session's other sockets when one disconnects", () =>
    live(
      Effect.gen(function* () {
        const server = yield* startProductionRoutes;
        const ws = server.origin.replace(/^http/, "ws");
        const token = yield* server.session(Duration.millis(1000));
        const rpcSocket = yield* connect(rpcUrl(server.origin, `&wsTicket=${token.ticket}`), {});
        const deviceSocket = yield* connect(
          `${ws}/api/device-hub/api/devices/ws?wsTicket=${token.secondTicket}`,
          {},
        );
        assert.isTrue(yield* rpcSocket.opened);
        assert.isTrue(yield* deviceSocket.opened);
        yield* Effect.sleep("1500 millis");

        // The last /ws disconnect of an expired session publishes a removal;
        // the session is not revoked, so the device socket stays.
        yield* rpcSocket.close;
        yield* rpcSocket.closed;
        yield* Effect.sleep("500 millis");
        assert.isFalse(yield* deviceSocket.isClosed);

        yield* server.sessions.revoke(token.sessionId);
        assert.strictEqual(yield* deviceSocket.closed, 4401);
      }),
    ),
  );
});
