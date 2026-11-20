import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  RunId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type ConnectionAttemptError,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { startThreadTurn } from "./commands.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};

const BACKOFF_STATE: SupervisorConnectionState = { ...CONNECTED_STATE, phase: "backoff" };

const layerTestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

type DispatchHandler = (command: OrchestrationV2Command) => Effect.Effect<unknown, unknown>;

const socketClosed = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "socket closed",
      cause: new Error("socket closed"),
    }),
  });

interface SessionOptions {
  readonly closed?: RpcSession.RpcSession["closed"];
  /** A host without server-resolved command context: the client reads the projection. */
  readonly projection?: () => OrchestrationV2ThreadProjection;
  /** Replaces the projection read, for a read that loses its socket. */
  readonly readProjection?: () => Effect.Effect<
    OrchestrationV2ThreadProjection,
    RpcClientError.RpcClientError
  >;
}

const makeSession = (
  dispatch: DispatchHandler,
  options: SessionOptions = {},
): RpcSession.RpcSession => {
  const projection = options.projection;
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: dispatch,
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () =>
      options.readProjection?.() ?? Effect.sync(() => projection?.() ?? v2Projection),
  } as unknown as WsRpcProtocolClient;
  return {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: { serverResolvedCommandContext: projection === undefined },
      },
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: options.closed ?? Effect.never,
  };
};

const ACTIVE_RUN_ID = RunId.make("active-run");

const PROJECTION_WITH_ACTIVE_RUN: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runs: [
    {
      id: ACTIVE_RUN_ID,
      threadId: v2ThreadId,
      ordinal: 1,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("active-message"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: v2Now,
      startedAt: v2Now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  ],
};

const makeSupervisor = Effect.fn("TestSendResend.makeSupervisor")(function* () {
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_STATE),
    session: yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>()),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

const send = (
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
  id: string,
  dispatchMode: "auto" | "start" | "steer" = "auto",
) =>
  startThreadTurn({
    commandId: CommandId.make(`command-${id}`),
    threadId: v2ThreadId,
    message: {
      messageId: MessageId.make(`message-${id}`),
      role: "user",
      text: "hello",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    dispatchMode,
  }).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provide(layerTestCrypto),
  );

describe("message sends across a lost socket", () => {
  // A dead socket reaches the caller as a protocol error, or as an interrupt when
  // the supervisor closes the session before the protocol reports the error.
  it.effect.each([
    ["protocol error", "auto", Effect.fail(socketClosed())],
    ["session close", "auto", Effect.failCause(Cause.interrupt())],
    ["protocol error", "start", Effect.fail(socketClosed())],
  ] as const)(
    "resends a send lost to a %s (%s mode) on the next session with the same command id",
    ([, dispatchMode, loss]) =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor();
        const healthy = makeSession((command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        );
        const firstAttemptLost = yield* Deferred.make<void>();
        const lost = makeSession((command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* loss;
          }),
        );
        yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

        const sendFiber = yield* send(supervisor, "lost-reply", dispatchMode).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(firstAttemptLost);
        yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
        yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));
        const exit = yield* Fiber.await(sendFiber);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(commands.map((command) => [command.type, command.commandId])).toEqual([
          ["message.dispatch", "command-lost-reply"],
          ["message.dispatch", "command-lost-reply"],
        ]);
      }),
  );

  it.effect("stops after two resends when every attempt loses the socket", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const dying = (): RpcSession.RpcSession =>
        makeSession((command) =>
          Effect.gen(function* () {
            commands.push(command);
            // Every reconnect brings a fresh session that the same frame kills again.
            yield* SubscriptionRef.set(supervisor.session, Option.some(dying()));
            return yield* socketClosed();
          }),
        );
      yield* SubscriptionRef.set(supervisor.session, Option.some(dying()));

      const error = yield* send(supervisor, "socket-killer").pipe(Effect.flip);

      expect(error._tag).toBe("EnvironmentSendUnconfirmedError");
      expect(error.message).toBe(
        "Test environment lost the connection before it confirmed the message. It may still arrive, so check the thread before sending it again.",
      );
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-socket-killer",
        "command-socket-killer",
        "command-socket-killer",
      ]);
    }),
  );

  it.effect("fails a lost send after 2 minutes while every reconnect keeps failing", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const lost = makeSession((command) =>
        Effect.gen(function* () {
          commands.push(command);
          yield* SubscriptionRef.set(supervisor.session, Option.none());
          return yield* socketClosed();
        }),
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

      const waiting = yield* send(supervisor, "host-gone").pipe(Effect.flip, Effect.forkChild);
      yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);
      yield* TestClock.adjust("119 seconds");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");

      const error = yield* Fiber.join(waiting);
      expect(error._tag).toBe("EnvironmentSendUnconfirmedError");
      expect(error.message).toBe(
        "Test environment did not confirm the message within 2 minutes. It may still arrive, so check the thread before sending it again.",
      );
      expect(commands.map((command) => command.commandId)).toEqual(["command-host-gone"]);
    }),
  );

  it.effect("still delivers a lost send when the reconnect comes back within the deadline", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const healthy = makeSession((command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      );
      const lost = makeSession((command) =>
        Effect.gen(function* () {
          commands.push(command);
          yield* SubscriptionRef.set(supervisor.session, Option.none());
          return yield* socketClosed();
        }),
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

      const sendFiber = yield* send(supervisor, "slow-reconnect").pipe(Effect.forkChild);
      yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);
      yield* TestClock.adjust("90 seconds");
      expect(sendFiber.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));

      expect(yield* Fiber.join(sendFiber)).toEqual({ sequence: 2 });
    }),
  );

  it.effect.each([
    ["protocol error", Effect.fail(socketClosed())],
    ["session close", Effect.failCause(Cause.interrupt())],
  ] as const)(
    "ends a send lost to a %s with an error the composer shows once the app disconnects",
    ([, loss]) =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor();
        const lost = makeSession((command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);
            return yield* loss;
          }),
        );
        yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

        const waiting = yield* send(supervisor, "app-disconnected").pipe(
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 second");
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);

        const exit = yield* Fiber.await(waiting);
        expect(Exit.isSuccess(exit) && exit.value._tag).toBe("EnvironmentSendUnconfirmedError");
        expect(Exit.isSuccess(exit) && exit.value.message).toBe(
          "Test environment lost the connection before it confirmed the message. It may still arrive, so check the thread before sending it again.",
        );
        expect(commands.map((command) => command.commandId)).toEqual(["command-app-disconnected"]);
      }),
  );

  it.effect("returns a defect at once while the socket stays up", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      // A reply that fails to decode: the protocol reports a defect, but the
      // session stays current and its socket stays open.
      const undecodable = makeSession((command) =>
        Effect.sync(() => commands.push(command)).pipe(Effect.andThen(Effect.fail(socketClosed()))),
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(undecodable));

      const sendFiber = yield* send(supervisor, "undecodable").pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const exit = sendFiber.pollUnsafe();

      expect(exit !== undefined && Exit.isSuccess(exit) && exit.value._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual(["command-undecodable"]);
    }),
  );

  it.effect("resends when the socket closed before the supervisor let go of the session", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const socketGone = yield* Deferred.make<never, ConnectionAttemptError>();
      const healthy = makeSession((command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      );
      const closing = makeSession(
        (command) =>
          Effect.gen(function* () {
            commands.push(command);
            // The protocol fails `closed` before it fails the request on that socket.
            yield* Deferred.fail(
              socketGone,
              new ConnectionTransientError({ reason: "transport", detail: "disconnected" }),
            );
            return yield* socketClosed();
          }),
        { closed: Deferred.await(socketGone) },
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(closing));

      const sendFiber = yield* send(supervisor, "closing").pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(sendFiber.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));

      expect(yield* Fiber.join(sendFiber)).toEqual({ sequence: 2 });
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-closing",
        "command-closing",
      ]);
    }),
  );

  it.effect("never resends a send its caller interrupted", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const attemptStarted = yield* Deferred.make<void>();
      const healthy = makeSession((command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      );
      const pending = makeSession((command) =>
        Effect.gen(function* () {
          commands.push(command);
          yield* Deferred.succeed(attemptStarted, undefined);
          return yield* Effect.never;
        }),
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(pending));

      const sendFiber = yield* send(supervisor, "cancelled").pipe(Effect.forkChild);
      yield* Deferred.await(attemptStarted);
      const interrupting = yield* Fiber.interrupt(sendFiber).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      // A session that shows up later must not pick the cancelled send back up.
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));
      yield* Fiber.join(interrupting);

      const exit = yield* Fiber.await(sendFiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(commands.map((command) => command.commandId)).toEqual(["command-cancelled"]);
    }),
  );

  it.effect("works the dispatch mode out again before a resend to a client-resolved host", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      let projection: OrchestrationV2ThreadProjection = PROJECTION_WITH_ACTIVE_RUN;
      const firstAttemptLost = yield* Deferred.make<void>();
      const healthy = makeSession(
        (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        { projection: () => projection },
      );
      const lost = makeSession(
        (command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* socketClosed();
          }),
        { projection: () => projection },
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

      const sendFiber = yield* send(supervisor, "steer", "steer").pipe(Effect.forkChild);
      yield* Deferred.await(firstAttemptLost);
      // The run the steer named finished while the socket was down.
      projection = v2Projection;
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));
      yield* Fiber.join(sendFiber);

      expect(
        commands.map((command) =>
          command.type === "message.dispatch" ? [command.commandId, command.dispatchMode] : [],
        ),
      ).toEqual([
        ["command-steer", { type: "steer_active", targetRunId: ACTIVE_RUN_ID }],
        ["command-steer", { type: "start_immediately" }],
      ]);
    }),
  );

  it.effect(
    "waits for the next session when the projection read before a resend loses its socket",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor();
        const firstAttemptLost = yield* Deferred.make<void>();
        const refreshLost = yield* Deferred.make<void>();
        const healthy = makeSession(
          (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          { projection: () => v2Projection },
        );
        const lost = makeSession(
          (command) =>
            Effect.gen(function* () {
              commands.push(command);
              yield* SubscriptionRef.set(supervisor.session, Option.none());
              yield* Deferred.succeed(firstAttemptLost, undefined);
              return yield* socketClosed();
            }),
          { projection: () => v2Projection },
        );
        // The next socket drops while the client reads the projection for the resend.
        const droppedDuringRefresh = makeSession(
          (command) => Effect.sync(() => commands.push(command)),
          {
            projection: () => v2Projection,
            readProjection: () =>
              Effect.gen(function* () {
                yield* SubscriptionRef.set(supervisor.session, Option.none());
                yield* Deferred.succeed(refreshLost, undefined);
                return yield* socketClosed();
              }),
          },
        );
        yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

        const sendFiber = yield* send(supervisor, "refresh-lost").pipe(Effect.forkChild);
        yield* Deferred.await(firstAttemptLost);
        yield* SubscriptionRef.set(supervisor.session, Option.some(droppedDuringRefresh));
        yield* Deferred.await(refreshLost);
        yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));

        expect(yield* Fiber.join(sendFiber)).toEqual({ sequence: 2 });
        expect(commands.map((command) => command.commandId)).toEqual([
          "command-refresh-lost",
          "command-refresh-lost",
        ]);
      }),
  );

  it.effect(
    "waits for the next session when the socket drops between the refresh and the resend",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor();
        const firstAttemptLost = yield* Deferred.make<void>();
        const refreshedThenDropped = yield* Deferred.make<void>();
        const healthy = makeSession(
          (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          { projection: () => v2Projection },
        );
        const lost = makeSession(
          (command) =>
            Effect.gen(function* () {
              commands.push(command);
              yield* SubscriptionRef.set(supervisor.session, Option.none());
              yield* Deferred.succeed(firstAttemptLost, undefined);
              return yield* socketClosed();
            }),
          { projection: () => v2Projection },
        );
        // The next socket answers the projection read, then drops before the resend.
        const dropsAfterRefresh = makeSession(
          (command) => Effect.sync(() => commands.push(command)),
          {
            projection: () => v2Projection,
            readProjection: () =>
              Effect.gen(function* () {
                yield* SubscriptionRef.set(supervisor.session, Option.none());
                yield* Deferred.succeed(refreshedThenDropped, undefined);
                return v2Projection;
              }),
          },
        );
        yield* SubscriptionRef.set(supervisor.session, Option.some(lost));

        const sendFiber = yield* send(supervisor, "refresh-then-drop").pipe(Effect.forkChild);
        yield* Deferred.await(firstAttemptLost);
        yield* SubscriptionRef.set(supervisor.session, Option.some(dropsAfterRefresh));
        yield* Deferred.await(refreshedThenDropped);
        yield* TestClock.adjust("1 second");
        expect(sendFiber.pollUnsafe()).toBeUndefined();
        yield* SubscriptionRef.set(supervisor.session, Option.some(healthy));

        expect(yield* Fiber.join(sendFiber)).toEqual({ sequence: 2 });
        expect(commands.map((command) => command.commandId)).toEqual([
          "command-refresh-then-drop",
          "command-refresh-then-drop",
        ]);
      }),
  );

  it.effect("fails a send the host never answers on a live socket after 60 seconds", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const silent = makeSession((command) =>
        Effect.sync(() => commands.push(command)).pipe(Effect.andThen(Effect.never)),
      );
      yield* SubscriptionRef.set(supervisor.session, Option.some(silent));

      const sendFiber = yield* send(supervisor, "unanswered").pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      expect(sendFiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(sendFiber.pollUnsafe()).toBeDefined();

      const error = yield* Fiber.join(sendFiber);
      expect(error._tag).toBe("EnvironmentSendUnconfirmedError");
      expect(error.message).toBe(
        "Test environment did not confirm the message within 60 seconds. It may still arrive, so check the thread before sending it again.",
      );
      expect(commands.map((command) => command.commandId)).toEqual(["command-unanswered"]);
    }),
  );

  it.effect("never resends a send that got its reply or a refusal from the host", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor();
      const answering = makeSession((command) =>
        Effect.gen(function* () {
          commands.push(command);
          // The socket drops right after the reply arrives.
          yield* SubscriptionRef.set(supervisor.session, Option.none());
          if (command.commandId === "command-refused") {
            return yield* new OrchestrationDispatchCommandError({ message: "Refused." });
          }
          return { sequence: commands.length };
        }),
      );

      yield* SubscriptionRef.set(supervisor.session, Option.some(answering));
      const result = yield* send(supervisor, "answered");
      yield* SubscriptionRef.set(supervisor.session, Option.some(answering));
      const refusal = yield* send(supervisor, "refused").pipe(Effect.flip);
      yield* SubscriptionRef.set(supervisor.session, Option.some(answering));

      expect(result).toEqual({ sequence: 1 });
      expect(refusal._tag).toBe("OrchestrationDispatchCommandError");
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-answered",
        "command-refused",
      ]);
    }),
  );
});
