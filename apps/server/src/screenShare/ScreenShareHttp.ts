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
 *   hears of them.
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
  SCREEN_SHARE_MAX_HOST_PROOF_LENGTH,
  SCREEN_SHARE_ROUTE_PREFIX,
  SCREEN_SHARE_VIEW_PATH,
} from "@specweave-studio/contracts";
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
  ownAppProofKind,
  personDeviceOf,
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

interface Services {
  readonly relay: ScreenShareRelay;
  readonly trust: ConnectDeviceTrust.ConnectDeviceTrustShape;
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly launchSecret: string | undefined;
}

const makeHandler = ({ relay, trust, environment, secrets, launchSecret }: Services) => {
  /** Read each time: the app writes a new verifier when it starts. Unreadable means no. */
  const proofKind = (proof: string) =>
    Effect.gen(function* () {
      const verifier = yield* secrets.get(DESKTOP_OWNER_VERIFIER_SECRET).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      return ownAppProofKind({
        proof,
        launchSecret,
        verifier,
        nowMs: yield* Clock.currentTimeMillis,
      });
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
    const noEnd = !asHost && expiresAtMs === null;
    if (asHost ? !isOwnApp(session, request) : device === null || "refusal" in device || noEnd) {
      yield* Effect.logInfo("Refused a screen sharing socket.", {
        socket: asHost ? "host" : "view",
        subject: session.subject,
        reason:
          device !== null && "refusal" in device
            ? device.refusal
            : noEnd
              ? "session_without_expiry"
              : "not_this_machines_app",
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
          let host: ReturnType<ScreenShareRelay["attachHost"]> | null = null;
          const refuse = (reason: string) =>
            Effect.sync(() => peer.close(SCREEN_SHARE_CLOSE_REFUSED, reason));
          onChunk = (chunk) =>
            Effect.gen(function* () {
              if (host !== null && typeof chunk !== "string") return host.binary(chunk);
              const proof = hostHelloProof(chunk);
              if (host !== null && proof === null) return host.text(chunk as string);
              // Nothing is heard from this socket until it has proved it is the app,
              // and a later proof that does not hold ends it.
              const kind = proof === null ? null : yield* proofKind(proof);
              if (proof === null || kind === null) {
                yield* Effect.logWarning(
                  "Refused a screen sharing host that did not prove it is this machine's app.",
                );
                if (host !== null) return relay.dropHost("proof_stale");
                return yield* refuse("not_this_machines_app");
              }
              if (host !== null) return host.reprove(proof);
              // The proof is kept and checked again when a viewer opens: a launch
              // proof runs out in minutes, an owner proof when its file is rewritten.
              host = relay.attachHost(peer, proof);
              onClosed = host.closed;
              yield* Effect.logInfo("This machine's app attached for screen sharing.", { kind });
            });
          untilOver = Effect.sleep(SCREEN_SHARE_HOST_HELLO_MS).pipe(
            Effect.andThen(
              Effect.suspend(() => (host === null ? refuse("no_hello") : Effect.void)),
            ),
            Effect.andThen(Effect.never),
          );
        } else if ("device" in device && expiresAtMs !== null) {
          // The app that attached may no longer be the app: its latest proof ran out, or
          // the file it is checked against was rewritten since.
          const credential = relay.hostCredential();
          if (credential !== undefined && (yield* proofKind(credential)) === null) {
            yield* Effect.logWarning("Dropped a screen sharing host whose proof no longer holds.");
            relay.dropHost("proof_stale");
          }
          const { claimedLabel } = device.device;
          const opened = relay.openViewer(
            peer,
            {
              thumbprint: device.device.thumbprint,
              label: device.device.label,
              ...(claimedLabel === undefined ? {} : { claimedLabel }),
              shortId: device.device.shortId,
              kind: device.device.kind,
            },
            environmentId,
          );
          if ("refused" in opened) {
            // A refused upgrade reads as a failed sign-in to ticket clients, so say it in the close.
            yield* writer.write(new Socket.CloseEvent(SCREEN_SHARE_CLOSE_REFUSED, opened.refused));
            return HttpServerResponse.empty();
          }
          onChunk = (chunk) =>
            Effect.sync(() => {
              if (typeof chunk === "string") opened.text();
              else opened.binary(chunk);
            });
          onClosed = opened.closed;
          // These sessions' expiry is not watched elsewhere, so the screen stops at it here.
          untilOver = Effect.sleep(Math.max(0, expiresAtMs - (yield* Clock.currentTimeMillis)));
          yield* Effect.logInfo("A device asked to view this machine's screen.", {
            device: device.device.shortId,
            kind: device.device.kind,
          });
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
    const relay = new ScreenShareRelay();
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
