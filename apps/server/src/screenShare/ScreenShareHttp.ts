/**
 * The two sockets of screen sharing (1490) and who may open each:
 *
 * - `GET /api/screen-share/host`: this machine's own app, straight from this
 *   machine (`isOwnApp`), and only once its first message carried the app's
 *   proof (`ownAppProofKind`). The session class alone is not enough: a
 *   command line on this machine can obtain the same class, and so can the
 *   app's own window, which is why the proof is nothing the window holds. The
 *   app sends the proof again every few minutes and the latest one is checked
 *   again when a viewer opens.
 * - `GET /api/screen-share/view`: a person's approved device (`personDeviceOf`)
 *   on a session that has an end. Agents, worker grants, management keys,
 *   pairing codes and the local command line are refused here, before the app
 *   hears of them. The socket then has to answer a nonce with the device's own
 *   key (the knock) before anything is opened: the ticket that carried the
 *   sign-in here can be copied, and a copy must not be able to use up the
 *   device's opens, hold the one session or reach the app.
 *
 * Neither socket has a scope of its own on purpose: a scope says what a
 * session may do, never who it is. The decision is read from the whole session.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationReadScope,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_HOST_HELLO_MS,
  SCREEN_SHARE_HOST_PATH,
  SCREEN_SHARE_KNOCK_MS,
  SCREEN_SHARE_MAX_HOST_PROOF_LENGTH,
  SCREEN_SHARE_MAX_WAITING,
  SCREEN_SHARE_ROUTE_PREFIX,
  SCREEN_SHARE_VIEW_PATH,
  SCREEN_SHARE_WIRE,
  type ScreenShareViewerProve,
} from "@specweave-studio/contracts";
import { screenShareKnockHolds } from "@specweave-studio/shared/screenShareChannel";
// @effect-diagnostics-next-line nodeBuiltinImport:off - one unpredictable nonce per viewer socket.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { DESKTOP_OWNER_VERIFIER_SECRET } from "../auth/deviceApprover.ts";
import { authenticateMediaRequest, serveSocketUntilSessionEnds } from "../auth/http.ts";
import {
  approvedNameFrom,
  isOwnApp,
  ownAppStanding,
  ownAppStandingHolds,
  personDeviceOf,
  type OwnAppStanding,
} from "../auth/personDevice.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import { ScreenShareRelay, type ScreenSharePeer } from "./ScreenShareRelay.ts";

const forbidden = HttpServerResponse.text("Forbidden", { status: 403 });
const notFound = HttpServerResponse.text("Not Found", { status: 404 });

type Outgoing = string | Uint8Array | Socket.CloseEvent;

const outgoingBytes = (item: Outgoing) =>
  typeof item === "string"
    ? Buffer.byteLength(item)
    : item instanceof Uint8Array
      ? item.byteLength
      : 0;

/** The proof in a host's first message, or null when that message is anything else. */
export const hostHelloProof = (message: string | Uint8Array): string | null => {
  if (typeof message !== "string" || message.length > SCREEN_SHARE_MAX_HOST_PROOF_LENGTH + 64)
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const hello = parsed as Record<string, unknown>;
  return hello.t === "hello" && typeof hello.proof === "string" ? hello.proof : null;
};

/**
 * Which of the two sockets a request is for; null for everything else under
 * the prefix, which is answered 404 before anything is authenticated.
 */
export const screenShareSocketOf = (
  pathname: string,
  upgrade: string | undefined,
): "host" | "view" | null =>
  upgrade?.toLowerCase() !== "websocket"
    ? null
    : pathname === SCREEN_SHARE_HOST_PATH
      ? "host"
      : pathname === SCREEN_SHARE_VIEW_PATH
        ? "view"
        : null;

/** When a viewer's session ends, in epoch milliseconds; null when it never would. */
export const viewerSessionEnd = (expiresAt: DateTime.DateTime | undefined): number | null =>
  expiresAt === undefined ? null : DateTime.toEpochMillis(expiresAt);

/**
 * Why a socket is refused before any upgrade, or null when it may go on. A
 * host must be this machine's app; a viewer must be a person's approved device
 * on a session that ends by itself.
 */
export const screenShareSocketRefusal = (input: {
  readonly socket: "host" | "view";
  readonly ownApp: boolean;
  readonly device: { readonly refusal: string } | { readonly device: unknown } | null;
  readonly expiresAtMs: number | null;
}): string | null => {
  if (input.socket === "host") return input.ownApp ? null : "not_this_machines_app";
  if (input.device === null) return "not_a_persons_device";
  if ("refusal" in input.device) return input.device.refusal;
  return input.expiresAtMs === null ? "session_without_expiry" : null;
};

/** How often a host's standing is looked at again while a device is viewing. */
const HOST_RECHECK_MS = 60_000;

/** The longest knock worth reading: a signed line with the device's public key in it. */
const MAX_KNOCK_BYTES = 2048;

const proveText = (prove: ScreenShareViewerProve): string => JSON.stringify(prove);

/** The signed answer in a viewer's first message, or null for anything else. */
const knockOf = (chunk: string | Uint8Array): string | null => {
  if (typeof chunk === "string" || chunk.length < 2 || chunk.length > MAX_KNOCK_BYTES) return null;
  if (chunk[0] !== SCREEN_SHARE_WIRE.knock) return null;
  return Buffer.from(chunk.subarray(1)).toString("latin1");
};

interface Services {
  readonly relay: ScreenShareRelay<OwnAppStanding>;
  readonly trust: ConnectDeviceTrust.ConnectDeviceTrustShape;
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly launchSecret: string | undefined;
}

const makeHandler = ({ relay, trust, environment, secrets, launchSecret }: Services) => {
  /**
   * Viewer sockets that have not yet answered with their device's key, oldest
   * first. They hold nothing but a place here; one too many drops the oldest,
   * never the newcomer, so a crowd of copies cannot keep a real device out.
   */
  const waiting: Array<{ readonly drop: () => void }> = [];

  /** Read each time: the app writes a new verifier when it starts. Unreadable means no. */
  const verifierNow = secrets.get(DESKTOP_OWNER_VERIFIER_SECRET).pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  /** What to keep of a proof that holds right now, or null. The proof itself is not kept. */
  const standingOf = (proof: string) =>
    Effect.gen(function* () {
      return ownAppStanding({
        proof,
        launchSecret,
        verifier: yield* verifierNow,
        nowMs: yield* Clock.currentTimeMillis,
      });
    });
  const stillHolds = (standing: OwnAppStanding) =>
    Effect.gen(function* () {
      return ownAppStandingHolds(standing, {
        verifier: yield* verifierNow,
        nowMs: yield* Clock.currentTimeMillis,
      });
    });

  /**
   * The app that attached may no longer be the app: its latest proof ran out,
   * or the file it is checked against was rewritten since. Then it is dropped,
   * and whatever it was showing ends with it.
   */
  const dropStaleHost = Effect.gen(function* () {
    const standing = relay.hostStanding();
    if (standing === undefined || (yield* stillHolds(standing))) return;
    yield* Effect.logWarning("Dropped a screen sharing host whose proof no longer holds.");
    relay.dropHost("proof_stale");
  });

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const which = Option.isNone(url)
      ? null
      : screenShareSocketOf(url.value.pathname, request.headers.upgrade);
    if (which === null) return notFound;
    const session = yield* authenticateMediaRequest(AuthOrchestrationReadScope);

    const asHost = which === "host";
    const device = asHost ? null : yield* personDeviceOf(session, approvedNameFrom(trust));
    // A viewer's session must end by itself: one with no expiry is not let in.
    const expiresAtMs = viewerSessionEnd(session.expiresAt);
    const refusal = screenShareSocketRefusal({
      socket: which,
      ownApp: asHost && isOwnApp(session, request),
      device,
      expiresAtMs,
    });
    if (refusal !== null) {
      yield* Effect.logInfo("Refused a screen sharing socket.", {
        socket: which,
        subject: session.subject,
        reason: refusal,
      });
      return forbidden;
    }
    const environmentId = yield* environment.getEnvironmentId;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        // Sealed bytes do not compress, and deflate would queue outside the bound below.
        delete incoming.headers["sec-websocket-extensions"];
        const transport = incoming.socket;
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const outgoing = yield* Queue.unbounded<Outgoing>();
        let queued = 0;
        const offer = (item: Outgoing) => {
          queued += outgoingBytes(item);
          Queue.offerUnsafe(outgoing, item);
        };
        const peer: ScreenSharePeer = {
          sendText: offer,
          sendBinary: offer,
          close: (code, reason) => offer(new Socket.CloseEvent(code, reason)),
          bufferedBytes: () => queued + transport.writableLength,
        };
        const send = Effect.forever(
          Queue.take(outgoing).pipe(
            Effect.flatMap((item) =>
              writer.write(item).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    queued -= outgoingBytes(item);
                  }),
                ),
                Effect.andThen(item instanceof Socket.CloseEvent ? Effect.interrupt : Effect.void),
              ),
            ),
          ),
        );

        let onChunk: (chunk: string | Uint8Array) => Effect.Effect<void>;
        let onClosed: () => void = () => {};
        let untilOver: Effect.Effect<void> = Effect.never;

        if (device === null) {
          let host: ReturnType<ScreenShareRelay<OwnAppStanding>["attachHost"]> | null = null;
          const refuse = (reason: string) =>
            Effect.sync(() => peer.close(SCREEN_SHARE_CLOSE_REFUSED, reason));
          onChunk = (chunk) =>
            Effect.gen(function* () {
              if (host !== null && typeof chunk !== "string") return host.binary(chunk);
              const proof = hostHelloProof(chunk);
              if (host !== null && proof === null) return host.text(chunk as string);
              // Nothing is heard from this socket until it has proved it is the app,
              // and a later proof that does not hold ends it.
              const standing = proof === null ? null : yield* standingOf(proof);
              if (standing === null) {
                yield* Effect.logWarning(
                  "Refused a screen sharing host that did not prove it is this machine's app.",
                );
                // Only the socket that sent it is dropped, never a newer app that took over.
                if (host !== null) return host.drop("proof_stale");
                return yield* refuse("not_this_machines_app");
              }
              if (host !== null) return host.reprove(standing);
              // Checked again when a viewer opens: a launch proof runs out in minutes,
              // an owner proof when its file is rewritten.
              host = relay.attachHost(peer, standing);
              onClosed = host.closed;
              yield* Effect.logInfo("This machine's app attached for screen sharing.", {
                kind: standing.kind,
              });
            });
          untilOver = Effect.sleep(SCREEN_SHARE_HOST_HELLO_MS).pipe(
            Effect.andThen(
              Effect.suspend(() => (host === null ? refuse("no_hello") : Effect.void)),
            ),
            Effect.andThen(Effect.never),
          );
        } else if ("device" in device && expiresAtMs !== null) {
          const viewer = device.device;
          const nonce = NodeCrypto.randomBytes(16).toString("hex");
          type Opened = Exclude<ReturnType<typeof relay.openViewer>, { readonly refused: unknown }>;
          // "checking" from the moment an answer arrives: the deadline is for answering, and
          // an answer that came in time is not refused for the time its checking takes.
          let stage: "waiting" | "checking" | "over" | Opened = "waiting";
          const stageNow = () => stage;
          const refuse = (reason: string) => {
            stage = "over";
            peer.close(SCREEN_SHARE_CLOSE_REFUSED, reason);
          };
          const place = { drop: () => refuse("handshake_failed") };
          const leave = () => {
            const index = waiting.indexOf(place);
            if (index >= 0) waiting.splice(index, 1);
          };
          waiting.push(place);
          if (waiting.length > SCREEN_SHARE_MAX_WAITING) waiting.shift()?.drop();
          peer.sendText(proveText({ t: "prove", nonce, environmentId }));

          onChunk = (chunk) =>
            Effect.gen(function* () {
              if (stage === "over" || stage === "checking") return;
              if (stage !== "waiting")
                return typeof chunk === "string" ? stage.text() : stage.binary(chunk);
              // The first message is the knock or the end: nothing before it is opened,
              // counted against the device, or told to the app.
              leave();
              stage = "checking";
              const jws = knockOf(chunk);
              const holds =
                jws !== null &&
                screenShareKnockHolds({
                  jws,
                  environmentId,
                  nonce,
                  thumbprint: viewer.thumbprint,
                  nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
                });
              if (!holds) {
                yield* Effect.logInfo("A screen sharing viewer did not show its device's key.", {
                  device: viewer.shortId,
                });
                return refuse("handshake_failed");
              }
              yield* dropStaleHost;
              // The socket may have closed while the app's standing was read: then nothing opens.
              if (stageNow() !== "checking") return;
              const { claimedLabel } = viewer;
              const opened = relay.openViewer(
                peer,
                {
                  thumbprint: viewer.thumbprint,
                  label: viewer.label,
                  ...(claimedLabel === undefined ? {} : { claimedLabel }),
                  shortId: viewer.shortId,
                  kind: viewer.kind,
                },
                environmentId,
              );
              // A refused upgrade reads as a failed sign-in to ticket clients, so say it in the close.
              if ("refused" in opened) return refuse(opened.refused);
              stage = opened;
              yield* Effect.logInfo("A device asked to view this machine's screen.", {
                device: viewer.shortId,
                kind: viewer.kind,
              });
            });
          onClosed = () => {
            leave();
            if (typeof stage === "object") stage.closed();
            stage = "over";
          };
          // These sessions' expiry is not watched elsewhere, so the screen stops at it here.
          // While the device is in, the app's standing is looked at again every minute:
          // an app that stopped renewing its proof does not keep showing a screen.
          untilOver = Effect.raceFirst(
            Effect.raceFirst(
              Effect.sleep(Math.max(0, expiresAtMs - (yield* Clock.currentTimeMillis))),
              Effect.forever(Effect.sleep(HOST_RECHECK_MS).pipe(Effect.andThen(dropStaleHost))),
            ),
            // No answer in time: the place is given up. Once in, this waits for nothing.
            Effect.sleep(SCREEN_SHARE_KNOCK_MS).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (stage !== "waiting") return Effect.never;
                  leave();
                  refuse("handshake_failed");
                  return Effect.never;
                }),
              ),
            ),
          );
        } else {
          return HttpServerResponse.empty();
        }

        const receive = Effect.forever(
          reader.pull.pipe(
            Effect.flatMap((chunks) => Effect.forEach(chunks, onChunk, { discard: true })),
          ),
        );
        yield* serveSocketUntilSessionEnds(
          socket,
          session,
          Effect.raceFirst(Effect.raceFirst(send, receive), untilOver),
        ).pipe(Effect.ensuring(Effect.sync(() => onClosed())));
        return HttpServerResponse.empty();
      }),
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
  });
};

/** One relay per server: the app's socket and the viewers' sockets meet in it. */
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const relay = new ScreenShareRelay<OwnAppStanding>();
    yield* router.add(
      "GET",
      `${SCREEN_SHARE_ROUTE_PREFIX}/*`,
      makeHandler({
        relay,
        trust,
        environment,
        secrets,
        launchSecret: config.desktopBootstrapSecret,
      }),
    );
  }),
);
