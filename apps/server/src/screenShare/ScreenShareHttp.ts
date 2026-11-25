/**
 * The two sockets of screen sharing (1490) and who may open each:
 *
 * - `GET /api/screen-share/host`: this machine's own app, straight from this
 *   machine (`isOwnApp`). Nothing else can stand in as the screen.
 * - `GET /api/screen-share/view`: a person's approved device (`personDeviceOf`).
 *   Agents, worker grants, management keys, pairing codes and the local
 *   command line are refused here, before the app hears of them.
 *
 * Neither socket has a scope of its own on purpose: a scope says what a
 * session may do, never who it is. The decision is read from the whole session.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationReadScope,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_HOST_PATH,
  SCREEN_SHARE_ROUTE_PREFIX,
  SCREEN_SHARE_VIEW_PATH,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest, serveSocketUntilSessionEnds } from "../auth/http.ts";
import { isOwnApp, personDeviceOf } from "../auth/personDevice.ts";
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

const makeHandler = (
  relay: ScreenShareRelay,
  trust: ConnectDeviceTrust.ConnectDeviceTrust["Service"],
  environment: ServerEnvironment.ServerEnvironment["Service"],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url) || request.headers.upgrade?.toLowerCase() !== "websocket")
      return notFound;
    const path = url.value.pathname;
    if (path !== SCREEN_SHARE_HOST_PATH && path !== SCREEN_SHARE_VIEW_PATH) return notFound;
    const session = yield* authenticateMediaRequest(AuthOrchestrationReadScope);

    const asHost = path === SCREEN_SHARE_HOST_PATH;
    const device = asHost ? null : yield* personDeviceOf(session, trust.isApproved);
    if (asHost ? !isOwnApp(session, request) : device === null || "refusal" in device) {
      yield* Effect.logInfo("Refused a screen sharing socket.", {
        socket: asHost ? "host" : "view",
        subject: session.subject,
        reason: device !== null && "refusal" in device ? device.refusal : "not_this_machines_app",
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

        let onText: (text: string) => void = () => {};
        let onBinary: (bytes: Uint8Array) => void;
        let onClosed: () => void;
        if (device === null) {
          const host = relay.attachHost(peer);
          onText = host.text;
          onBinary = host.binary;
          onClosed = host.closed;
          yield* Effect.logInfo("This machine's app attached for screen sharing.");
        } else if ("device" in device) {
          const opened = relay.openViewer(
            peer,
            {
              thumbprint: device.device.thumbprint,
              label: device.device.label,
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
          onBinary = opened.binary;
          onClosed = opened.closed;
          yield* Effect.logInfo("A device asked to view this machine's screen.", {
            device: device.device.shortId,
            kind: device.device.kind,
          });
        } else {
          return HttpServerResponse.empty();
        }

        const receive = Effect.forever(
          reader.pull.pipe(
            Effect.map((chunks) => {
              for (const chunk of chunks)
                if (typeof chunk === "string") onText(chunk);
                else onBinary(chunk);
            }),
          ),
        );
        yield* serveSocketUntilSessionEnds(socket, session, Effect.raceFirst(send, receive)).pipe(
          Effect.ensuring(Effect.sync(() => onClosed())),
        );
        return HttpServerResponse.empty();
      }),
    ).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty())));
  });

/** One relay per server: the app's socket and the viewers' sockets meet in it. */
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const relay = new ScreenShareRelay();
    yield* router.add(
      "GET",
      `${SCREEN_SHARE_ROUTE_PREFIX}/*`,
      makeHandler(relay, trust, environment),
    );
  }),
);
