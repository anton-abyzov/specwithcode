// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - serves real WebSocket upgrades from a Node HTTP server on the wall clock: proofs and signed handshakes carry real time.
/**
 * The two screen sharing routes over real sockets (1490): a real Node HTTP
 * server, the real sign-in checks, sessions minted through the session store
 * and sockets opened with a `wsTicket`, the way the app and a viewer open them.
 * The relay's and the session's own rules are tested next to them; this file
 * proves the glue between a socket and those rules runs.
 */
import * as NodeHttp from "node:http";
import * as Net from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  encodeScreenShareHostFrame,
  decodeScreenShareHostFrame,
  SCREEN_SHARE_CLOSE_ENDED,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_HOST_HELLO_MS,
  SCREEN_SHARE_HOST_PATH,
  SCREEN_SHARE_RECORD,
  SCREEN_SHARE_ROUTE_PREFIX,
  SCREEN_SHARE_VIEW_PATH,
  SCREEN_SHARE_WIRE,
} from "@specweave-studio/contracts";
import {
  currentDesktopBootstrapToken,
  currentScreenShareHostProof,
} from "@specweave-studio/shared/desktopBootstrapToken";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@specweave-studio/shared/dpop";
import {
  acceptScreenShareProof,
  answerScreenShareChallenge,
  makeScreenShareOpener,
  makeScreenShareSealer,
  newScreenShareMachineKey,
  startScreenShareTarget,
  startScreenShareViewer,
} from "@specweave-studio/shared/screenShareChannel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { DESKTOP_OWNER_SUBJECT } from "../auth/deviceApprover.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { routeLayer } from "./ScreenShareHttp.ts";

const SECRET = "launch-secret-for-this-test";
const ON = { t: "status", status: { enabled: true, supported: true, busy: false } };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A device with a real P-256 key, the way a viewer holds one. */
const makeDevice = Effect.promise(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! } as DpopPublicJwk;
  const sign = async (data: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data),
    );
  return { jwk, thumbprint: computeDpopJwkThumbprint(jwk), sign };
});

const startServer = (thumbprint: string) =>
  Effect.gen(function* () {
    const config = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const base = yield* ServerConfig.ServerConfig;
        return ServerConfig.ServerConfig.of({ ...base, desktopBootstrapSecret: SECRET });
      }),
    ).pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "studio-screen-share-http-test-" }),
      ),
    );
    // The routes ask only for this machine's id; it comes from the real identity.
    // Given to the routes alone: sign-in reads the descriptor where it finds one.
    const environment = Layer.effect(
      ServerEnvironment.ServerEnvironment,
      Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: identity.getEnvironmentId,
          getDescriptor: Effect.die("The screen sharing routes do not read the descriptor."),
        });
      }),
    );
    const context = yield* Layer.build(
      HttpRouter.serve(routeLayer.pipe(Layer.provide(environment)), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(EnvironmentAuth.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(ServerEnvironment.layerIdentity),
        Layer.provideMerge(config),
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
      ),
    );
    const address = Context.get(context, HttpServer.HttpServer).address;
    const port = NetAddress.isInetAddress(address) ? address.port : 0;
    const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
    const sessions = Context.get(context, SessionStore.SessionStore);
    const environmentId = yield* Context.get(context, ServerEnvironment.ServerEnvironmentIdentity)
      .getEnvironmentId;
    // The real approved list: the device asks once as "Work laptop", gets a code,
    // and a person at this machine types it. That is the name the list keeps.
    const trust = Context.get(context, ConnectDeviceTrust.ConnectDeviceTrust);
    yield* trust.snapshot;
    const asked = yield* trust.check({
      subject: ConnectDeviceTrust.CONNECT_SUBJECT,
      proofKeyThumbprint: thumbprint,
      clientLabel: "Work laptop",
      clientDeviceType: "desktop",
    });
    if (asked._tag !== "refused" || asked.approvalCode === undefined)
      return yield* Effect.die("A device that was never approved must be given a code.");
    const approved = yield* trust.approve({
      code: asked.approvalCode,
      approvedBy: "this machine",
      approverKey: null,
    });
    assert.strictEqual(approved.status, "approved");
    const ticketFor = (input: Parameters<typeof sessions.issue>[0]) =>
      Effect.gen(function* () {
        const issued = yield* sessions.issue(input);
        return (yield* auth.issueWebSocketTicket(issued)).ticket;
      });
    return {
      http: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}`,
      environmentId: String(environmentId),
      /** This machine's own app, as its session reads. */
      appTicket: ticketFor({
        subject: DESKTOP_OWNER_SUBJECT,
        method: "bearer-access-token",
        scopes: [AuthAccessWriteScope, AuthOrchestrationReadScope],
      }),
      /** The approved device, signed in through Connect with its proof key, under a new name. */
      deviceTicket: ticketFor({
        subject: ConnectDeviceTrust.CONNECT_SUBJECT,
        method: "dpop-access-token",
        proofKeyThumbprint: thumbprint,
        scopes: [AuthOrchestrationReadScope],
        client: { deviceType: "desktop", os: "macOS", browser: "Chrome", label: "Renamed laptop" },
      }),
      /** A paired browser: signed in, but no person's approved device. */
      browserTicket: ticketFor({
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
    };
  });

/** A real WebSocket and what arrived on it, text and bytes in order. */
const open = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      const heard: Array<string | Uint8Array> = [];
      const waiting: Array<() => void> = [];
      let ended: { readonly code: number; readonly reason: string } | null = null;
      const wake = () => {
        for (const check of waiting.splice(0)) check();
      };
      socket.addEventListener("message", (event) => {
        const data: unknown = event.data;
        heard.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
        wake();
      });
      socket.addEventListener("close", (event) => {
        ended = { code: event.code, reason: event.reason };
        wake();
      });
      // A refused handshake reports only an error, never a close.
      socket.addEventListener("error", () => {
        ended ??= { code: 0, reason: "handshake refused" };
        wake();
      });
      const opened = new Promise<boolean>((resolve) => {
        socket.addEventListener("open", () => resolve(true));
        socket.addEventListener("error", () => resolve(false));
        socket.addEventListener("close", () => resolve(false));
      });
      let read = 0;
      /** The next message `pick` accepts, in arrival order. Fails if the socket closes first. */
      const next = <T>(pick: (message: string | Uint8Array) => T | undefined) =>
        Effect.promise(
          () =>
            new Promise<T>((resolve, reject) => {
              const check = () => {
                for (; read < heard.length; read += 1) {
                  const found = pick(heard[read]!);
                  if (found !== undefined) {
                    read += 1;
                    return resolve(found);
                  }
                }
                if (ended !== null)
                  return reject(new Error(`closed ${ended.code} ${ended.reason} before it came`));
                waiting.push(check);
              };
              check();
            }),
        );
      return {
        socket,
        heard,
        opened: Effect.promise(() => opened),
        send: (data: string | Uint8Array) => Effect.sync(() => socket.send(data)),
        /** The next text message of kind `t`, parsed. */
        text: (t: string) =>
          next((message) => {
            if (typeof message !== "string") return undefined;
            const parsed = JSON.parse(message) as Record<string, unknown>;
            return parsed.t === t ? parsed : undefined;
          }),
        bytes: next((message) => (typeof message === "string" ? undefined : message)),
        closed: Effect.promise(
          () =>
            new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
              const check = () => (ended === null ? void waiting.push(check) : resolve(ended));
              check();
            }),
        ),
      };
    }),
    ({ socket }) => Effect.sync(() => socket.close()),
  );

/**
 * The status line a WebSocket upgrade request gets, read off the raw
 * connection: 101 when it was upgraded, 0 when the server closed without one.
 */
const upgradeStatus = (url: string) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const { hostname, port, pathname, search } = new URL(url);
        const socket = Net.connect(Number(port), hostname, () => {
          socket.write(
            [
              `GET ${pathname}${search} HTTP/1.1`,
              `Host: ${hostname}:${port}`,
              "Connection: Upgrade",
              "Upgrade: websocket",
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n"),
          );
        });
        let head = "";
        const done = (status: number) => {
          socket.destroy();
          resolve(status);
        };
        socket.on("data", (chunk) => {
          head += chunk.toString("latin1");
          const line = /^HTTP\/1\.1 (\d{3})/.exec(head);
          if (line !== null) done(Number(line[1]));
        });
        socket.on("end", () => done(0));
        socket.on("error", reject);
      }),
  );

type Server = Effect.Success<ReturnType<typeof startServer>>;

/** This machine's app, attached with the right proof and saying sharing is on. */
const attachedHost = (server: Server) =>
  Effect.gen(function* () {
    const host = yield* open(
      `${server.ws}${SCREEN_SHARE_HOST_PATH}?wsTicket=${yield* server.appTicket}`,
    );
    assert.isTrue(yield* host.opened);
    yield* host.send(
      JSON.stringify({ t: "hello", proof: currentScreenShareHostProof(SECRET, Date.now()) }),
    );
    yield* host.text("attached");
    yield* host.send(JSON.stringify(ON));
    return host;
  });

/**
 * A viewer whose session the machine's app was told of. The app's status has
 * no answer to wait for, so a viewer that arrived before it is read tries again.
 */
const openedViewer = (server: Server) =>
  Effect.gen(function* () {
    const ticket = yield* server.deviceTicket;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const viewer = yield* open(`${server.ws}${SCREEN_SHARE_VIEW_PATH}?wsTicket=${ticket}`);
      const opened = yield* viewer.text("open").pipe(Effect.option);
      if (opened._tag === "Some") return { viewer, opened: opened.value };
      const { reason } = yield* viewer.closed;
      assert.include(["unsupported", "off"], reason);
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die("The relay never read the app's status.");
  });

const live = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("the host socket", () => {
  it.live("attaches this machine's app once its hello carries the host proof", () =>
    live(
      Effect.gen(function* () {
        const device = yield* makeDevice;
        const server = yield* startServer(device.thumbprint);
        const host = yield* attachedHost(server);
        assert.deepStrictEqual(
          host.heard.filter((message) => typeof message === "string"),
          [JSON.stringify({ t: "attached" })],
        );
      }),
    ),
  );

  it.live("refuses the bootstrap token the app's window holds, and anything that is no hello", () =>
    live(
      Effect.gen(function* () {
        const device = yield* makeDevice;
        const server = yield* startServer(device.thumbprint);
        const proofs = [
          JSON.stringify({ t: "hello", proof: currentDesktopBootstrapToken(SECRET, Date.now()) }),
          JSON.stringify({ t: "hello", proof: currentScreenShareHostProof("another", Date.now()) }),
          JSON.stringify(ON),
        ];
        for (const first of proofs) {
          const host = yield* open(
            `${server.ws}${SCREEN_SHARE_HOST_PATH}?wsTicket=${yield* server.appTicket}`,
          );
          assert.isTrue(yield* host.opened);
          yield* host.send(first);
          assert.deepStrictEqual(yield* host.closed, {
            code: SCREEN_SHARE_CLOSE_REFUSED,
            reason: "not_this_machines_app",
          });
          assert.deepStrictEqual(host.heard, []);
        }
        // Refused hosts never became the host: a viewer still finds none.
        const viewer = yield* open(
          `${server.ws}${SCREEN_SHARE_VIEW_PATH}?wsTicket=${yield* server.deviceTicket}`,
        );
        assert.deepStrictEqual(yield* viewer.closed, {
          code: SCREEN_SHARE_CLOSE_REFUSED,
          reason: "no_host",
        });
      }),
    ),
  );

  it.live(
    "closes a host that says nothing before the hello deadline",
    () =>
      live(
        Effect.gen(function* () {
          const device = yield* makeDevice;
          const server = yield* startServer(device.thumbprint);
          const host = yield* open(
            `${server.ws}${SCREEN_SHARE_HOST_PATH}?wsTicket=${yield* server.appTicket}`,
          );
          assert.isTrue(yield* host.opened);
          const started = Date.now();
          assert.deepStrictEqual(yield* host.closed, {
            code: SCREEN_SHARE_CLOSE_REFUSED,
            reason: "no_hello",
          });
          assert.isAtLeast(Date.now() - started, SCREEN_SHARE_HOST_HELLO_MS - 250);
          assert.deepStrictEqual(host.heard, []);
        }),
      ),
    SCREEN_SHARE_HOST_HELLO_MS + 8_000,
  );
});

describe("who may open which socket", () => {
  it.live("answers 403 to every session of the wrong kind, and 404 off the two paths", () =>
    live(
      Effect.gen(function* () {
        const device = yield* makeDevice;
        const server = yield* startServer(device.thumbprint);
        const view = `${server.http}${SCREEN_SHARE_VIEW_PATH}`;
        const host = `${server.http}${SCREEN_SHARE_HOST_PATH}`;
        const other = `${server.http}${SCREEN_SHARE_ROUTE_PREFIX}/other`;
        const { browserTicket, appTicket, deviceTicket } = server;
        const cases = [
          // A paired browser and this machine's own app are no person's approved device.
          [view, browserTicket, 403],
          [view, appTicket, 403],
          // A person's device, and a paired browser, are not this machine's app.
          [host, deviceTicket, 403],
          [host, browserTicket, 403],
          // Nothing else answers under the prefix, whoever asks.
          [other, appTicket, 404],
          // The right kinds are upgraded.
          [view, deviceTicket, 101],
          [host, appTicket, 101],
        ] as const;
        for (const [path, ticket, status] of cases)
          assert.strictEqual(
            yield* upgradeStatus(`${path}?wsTicket=${yield* ticket}`),
            status,
            `${path} answered the wrong status`,
          );
        assert.strictEqual(yield* upgradeStatus(other), 404);
      }),
    ),
  );
});

describe("the viewer socket", () => {
  it.live("refuses with no app attached, then opens a session named from the approved list", () =>
    live(
      Effect.gen(function* () {
        const device = yield* makeDevice;
        const server = yield* startServer(device.thumbprint);
        const early = yield* open(
          `${server.ws}${SCREEN_SHARE_VIEW_PATH}?wsTicket=${yield* server.deviceTicket}`,
        );
        assert.deepStrictEqual(yield* early.closed, {
          code: SCREEN_SHARE_CLOSE_REFUSED,
          reason: "no_host",
        });

        const host = yield* attachedHost(server);
        // A viewer comes in on a ticket, and the route lets in no session without
        // an expiry: this opening is the proof that a ticketed session carries one.
        const { opened } = yield* openedViewer(server);
        assert.strictEqual(opened.environmentId, server.environmentId);
        const told = yield* host.text("open");
        assert.strictEqual(told.sid, opened.sid);
        assert.strictEqual(told.environmentId, server.environmentId);
        const named = told.device as Record<string, unknown>;
        // The approved list's name, not the one this sign-in gave itself.
        assert.strictEqual(named.label, "Work laptop");
        assert.strictEqual(named.claimedLabel, "Renamed laptop");
        assert.strictEqual(named.thumbprint, device.thumbprint);
        assert.strictEqual(named.kind, "connect");
      }),
    ),
  );

  it.live("passes one whole handshake and a sealed record that only the two ends can open", () =>
    live(
      Effect.gen(function* () {
        const device = yield* makeDevice;
        const server = yield* startServer(device.thumbprint);
        const host = yield* attachedHost(server);
        const { viewer, opened } = yield* openedViewer(server);
        const sid = String(opened.sid);
        const environmentId = server.environmentId;
        yield* host.text("open");
        const wire = (type: number, body: Uint8Array) => new Uint8Array([type, ...body]);
        const json = (value: unknown) => encoder.encode(JSON.stringify(value));
        const fromViewer = host.bytes.pipe(
          Effect.map((message) => {
            const frame = decodeScreenShareHostFrame(message);
            assert.strictEqual(frame?.sid, sid);
            return frame!.payload;
          }),
        );
        const now = () => Math.floor(Date.now() / 1000);

        // Viewer hello, through the route, to the app.
        const start = startScreenShareViewer({
          mode: "view",
          deviceJwk: device.jwk,
          knowsMachine: false,
        });
        yield* viewer.send(wire(SCREEN_SHARE_WIRE.hello, json(start.hello)));
        const hello = yield* fromViewer;
        assert.strictEqual(hello[0], SCREEN_SHARE_WIRE.hello);

        // The app's challenge, signed with the machine's key, back to the viewer.
        const machineKey = newScreenShareMachineKey();
        const target = startScreenShareTarget({
          hello: JSON.parse(decoder.decode(hello.subarray(1))),
          environmentId,
          sessionId: sid,
          attestedThumbprint: device.thumbprint,
          machineKey,
        });
        yield* host.send(
          encodeScreenShareHostFrame(
            sid,
            wire(SCREEN_SHARE_WIRE.challenge, json(target.challenge)),
          ),
        );
        const challenge = yield* viewer.bytes;
        assert.strictEqual(challenge[0], SCREEN_SHARE_WIRE.challenge);

        // The viewer's proof, signed with the approved device key.
        const answer = yield* Effect.promise(() =>
          answerScreenShareChallenge({
            start,
            challenge: JSON.parse(decoder.decode(challenge.subarray(1))),
            environmentId,
            sessionId: sid,
            pinnedMachineKey: undefined,
            nowEpochSeconds: now(),
            sign: device.sign,
          }),
        );
        assert.strictEqual(answer.machineKey, machineKey.publicKey);
        yield* viewer.send(wire(SCREEN_SHARE_WIRE.proof, json(answer.proof)));
        const proof = yield* fromViewer;
        assert.strictEqual(proof[0], SCREEN_SHARE_WIRE.proof);
        const accepted = acceptScreenShareProof({
          start: target,
          proof: JSON.parse(decoder.decode(proof.subarray(1))),
          environmentId,
          sessionId: sid,
          nowEpochSeconds: now(),
        });
        // Both ends hold the same first-use code without it having crossed the wire.
        assert.strictEqual(accepted.code, answer.code);

        // One sealed record each way.
        const state = { phase: "waiting_for_approval" };
        const sealed = yield* Effect.promise(() =>
          makeScreenShareSealer(accepted.keys.toViewer, sid).seal(
            SCREEN_SHARE_RECORD.state,
            json(state),
          ),
        );
        yield* host.send(encodeScreenShareHostFrame(sid, wire(SCREEN_SHARE_WIRE.sealed, sealed)));
        const arrived = yield* viewer.bytes;
        assert.strictEqual(arrived[0], SCREEN_SHARE_WIRE.sealed);
        const record = yield* Effect.promise(() =>
          makeScreenShareOpener(answer.keys.toViewer, sid).open(arrived.subarray(1)),
        );
        assert.strictEqual(record.type, SCREEN_SHARE_RECORD.state);
        assert.deepStrictEqual(JSON.parse(decoder.decode(record.data)), state);

        const back = yield* Effect.promise(() =>
          makeScreenShareSealer(answer.keys.toTarget, sid).seal(SCREEN_SHARE_RECORD.end, json({})),
        );
        yield* viewer.send(wire(SCREEN_SHARE_WIRE.sealed, back));
        const returned = yield* fromViewer;
        const end = yield* Effect.promise(() =>
          makeScreenShareOpener(accepted.keys.toTarget, sid).open(returned.subarray(1)),
        );
        assert.strictEqual(end.type, SCREEN_SHARE_RECORD.end);
      }),
    ),
  );

  it.live("ends the session on any text from a viewer, and tells the app", () =>
    live(
      Effect.gen(function* () {
        const device = yield* makeDevice;
        const server = yield* startServer(device.thumbprint);
        const host = yield* attachedHost(server);
        const { viewer, opened } = yield* openedViewer(server);
        yield* host.text("open");
        yield* viewer.send(JSON.stringify({ t: "status", status: ON.status }));
        assert.deepStrictEqual(yield* viewer.closed, {
          code: SCREEN_SHARE_CLOSE_ENDED,
          reason: "protocol_error",
        });
        assert.strictEqual((yield* host.text("closed")).sid, opened.sid);
      }),
    ),
  );
});
