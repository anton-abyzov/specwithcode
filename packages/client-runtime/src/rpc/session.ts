import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@specweave-studio/contracts";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { constPing, constPong } from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";
import { environmentMismatchError } from "../connection/errors.ts";
import {
  LOOPBACK_ANSWERED_SILENCE_MS,
  LOOPBACK_SOCKET_OPEN_TIMEOUT,
} from "../connection/thisMachine.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
  /** When the last frame arrived from the server (Clock millis), if any did. */
  readonly lastInboundAt?: Effect.Effect<number | undefined>;
  /** Completes when the next frame arrives from the server. */
  readonly nextInbound?: Effect.Effect<void>;
}

export interface RpcSessionConnectOptions {
  /**
   * The socket reaches the server on this machine (see `thisMachine.ts`), so
   * it may take longer to open and tolerates a long silence before it counts
   * as dead: a starved local server holds the socket open and answers late.
   */
  readonly thisMachine?: boolean;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
  /** This client answers /usage-limits itself, so the server may advertise it. */
  readonly usageLimitsCommand?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
      options?: RpcSessionConnectOptions,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@specweave-studio/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

const isSocketErrorReason = Schema.is(Socket.SocketErrorReason);

/** The same socket, running `onFrames` each time a batch of frames arrives. */
function observeInbound(socket: Socket.Socket, onFrames: Effect.Effect<void>): Socket.Socket {
  return Socket.make({
    reader: Effect.map(socket.reader, (reader) => ({
      pull: Effect.tap(reader.pull, () => onFrames),
      upgrade: (options?: Socket.TlsUpgradeOptions) => reader.upgrade(options),
    })),
    writer: socket.writer,
  });
}

type SocketFrame = Uint8Array | string;

function sameFrame(left: SocketFrame | Socket.CloseEvent, right: SocketFrame): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (!(left instanceof Uint8Array) || left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * The same socket, for the server on this machine: the RPC client's pinger
 * only counts a decoded Pong as proof of life and gives up after three
 * unanswered 5 second windows, which drops a working connection to a starved
 * local server that is still streaming replies with its Pong queued behind
 * them. So a Pong the server never sent is added (a) after every batch of
 * frames that does arrive, and (b) in answer to each outbound Ping while the
 * last real frame is at most `answeredSilenceMs` old. Past that the pinger
 * times out as usual. A loopback server that has gone away closes the socket
 * at once, so this delays nothing but the verdict on a slow one.
 *
 * Real frames are pulled by a pump fiber into a one-slot mailbox (keeping
 * backpressure), so a synthetic Pong never races a real pull for its frames.
 */
const answerPingsWhileHeard = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  answeredSilenceMs: number,
) {
  const serialization = yield* RpcSerialization.RpcSerialization;
  const parser = serialization.makeUnsafe();
  const pingFrame = parser.encode(constPing);
  const pongFrame = parser.encode(constPong);
  if (pingFrame === undefined || pongFrame === undefined) return socket;
  const pongBatch: Arr.NonEmptyReadonlyArray<SocketFrame> = [pongFrame];
  const current = yield* Ref.make(
    Option.none<{
      readonly mailbox: Queue.Queue<Arr.NonEmptyReadonlyArray<SocketFrame>, Socket.SocketError>;
      readonly lastFrameAt: Ref.Ref<number>;
    }>(),
  );

  const reader = Effect.gen(function* () {
    const real = yield* socket.reader;
    const mailbox = yield* Queue.bounded<
      Arr.NonEmptyReadonlyArray<SocketFrame>,
      Socket.SocketError
    >(1);
    const lastFrameAt = yield* Ref.make(yield* Clock.currentTimeMillis);
    yield* real.pull.pipe(
      Effect.flatMap((frames) =>
        Effect.gen(function* () {
          yield* Ref.set(lastFrameAt, yield* Clock.currentTimeMillis);
          yield* Queue.offer(mailbox, [...frames, pongFrame]);
        }),
      ),
      Effect.forever,
      Effect.catchCause((cause) => Queue.failCause(mailbox, cause)),
      Effect.forkScoped,
    );
    // Closing the connection scope must fail a pull that is waiting.
    yield* Effect.addFinalizer(() =>
      Effect.all([
        Ref.set(current, Option.none()),
        Queue.fail(
          mailbox,
          new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
        ),
      ]),
    );
    yield* Ref.set(current, Option.some({ mailbox, lastFrameAt }));
    return {
      pull: Queue.take(mailbox),
      upgrade: (options?: Socket.TlsUpgradeOptions) => real.upgrade(options),
    } satisfies Socket.Reader;
  });

  const answerPing = Effect.gen(function* () {
    const connection = yield* Ref.get(current);
    if (Option.isNone(connection)) return;
    const silentMs =
      (yield* Clock.currentTimeMillis) - (yield* Ref.get(connection.value.lastFrameAt));
    if (silentMs > answeredSilenceMs) return;
    // A full mailbox already holds a batch that ends in a Pong.
    yield* Effect.sync(() => Queue.offerUnsafe(connection.value.mailbox, pongBatch));
  });

  const writer = Effect.map(socket.writer, (real) => ({
    write: (chunk: SocketFrame | Socket.CloseEvent) =>
      sameFrame(chunk, pingFrame)
        ? Effect.andThen(real.write(chunk), answerPing)
        : real.write(chunk),
    writeAll: real.writeAll,
  }));

  return Socket.make({ reader, writer });
});

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
  networkHint: string,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: `${error.message}${isSocketErrorReason(error.reason) ? networkHint : ""}`,
      });
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
    ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
  };

  const connect = Effect.fnUntraced(function* (
    connection: PreparedConnection,
    connectOptions: RpcSessionConnectOptions = {},
  ) {
    const thisMachine = connectOptions.thisMachine === true;
    const networkHint =
      connection.target._tag === "RelayConnectionTarget" ? ` ${NETWORK_BLOCKING_HINT}` : "";
    const mapRpcError = (error: Parameters<typeof mapSessionRpcError>[0]) =>
      mapSessionRpcError(error, networkHint);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    // Set when the socket closes because pongs stopped, so the failure says so
    // instead of looking like the server closed the connection.
    const pingTimedOut = yield* Ref.make(false);
    // Inbound traffic, so a health check can count any frame as an answer.
    const lastInboundAt = yield* Ref.make<number | undefined>(undefined);
    const inboundSignal = yield* Ref.make(yield* Deferred.make<void>());
    const recordInbound = Effect.gen(function* () {
      yield* Ref.set(lastInboundAt, yield* Clock.currentTimeMillis);
      const previous = yield* Ref.getAndSet(inboundSignal, yield* Deferred.make<void>());
      yield* Deferred.succeed(previous, undefined);
    });
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onPingTimeout: Ref.set(pingTimedOut, true),
      onDisconnect: Effect.all([Deferred.isDone(connected), Ref.get(pingTimedOut)]).pipe(
        Effect.flatMap(([wasConnected, timedOut]) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: `${
                !wasConnected
                  ? `${connection.label} could not establish a WebSocket connection.`
                  : timedOut
                    ? `${connection.label} stopped responding.`
                    : `${connection.label} disconnected.`
              }${networkHint}`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    // One serialization for the protocol and the Pongs this machine adds.
    const layerSerialization = RpcSerialization.layerJson;
    const layerSocket = Layer.effect(
      Socket.Socket,
      Effect.gen(function* () {
        const observed = observeInbound(yield* Socket.Socket, recordInbound);
        return thisMachine
          ? yield* answerPingsWhileHeard(observed, LOOPBACK_ANSWERED_SILENCE_MS)
          : observed;
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(connection.socketUrl, {
            openTimeout: thisMachine ? LOOPBACK_SOCKET_OPEN_TIMEOUT : SOCKET_OPEN_TIMEOUT,
          }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor))),
          layerSerialization,
        ),
      ),
    );
    const layerProtocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerSocket,
          layerSerialization,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(layerProtocol).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig](
      serverConfigInput,
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              event,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.usageLimitSources !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
          }
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(
      Effect.filterOrElse(
        (config) => config.environment.environmentId === connection.environmentId,
        (config) =>
          environmentMismatchError({
            expected: connection.environmentId,
            actual: config.environment.environmentId,
          }),
      ),
      Effect.withSpan("environment.initialSync"),
    );
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const validatedInitialConfig = initialConfig.pipe(
      Effect.mapError(
        (cause) =>
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
      ),
    );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Stream.unwrap(
        validatedInitialConfig.pipe(
          Effect.as(
            Equal.equals(input, serverConfigInput)
              ? serverConfigEvents
              : protocolClient[WS_METHODS.subscribeServerConfig](input),
          ),
        ),
      );
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: protocolClient,
      initialConfig,
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
      lastInboundAt: Ref.get(lastInboundAt),
      nextInbound: Ref.get(inboundSignal).pipe(Effect.flatMap(Deferred.await)),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = (options: RpcSessionOptions) => Layer.effect(RpcSessionFactory, make(options));
