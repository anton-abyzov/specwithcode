import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  type OrchestrationV2Command,
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
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
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

const makeSession = (dispatch: DispatchHandler): RpcSession.RpcSession => {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: dispatch,
  } as unknown as WsRpcProtocolClient;
  return {
    client,
    initialConfig: Effect.succeed({
      environment: { capabilities: { serverResolvedCommandContext: true } },
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
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
  dispatchMode: "auto" | "start" = "auto",
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

      expect(error._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-socket-killer",
        "command-socket-killer",
        "command-socket-killer",
      ]);
    }),
  );

  it.effect("holds a lost send through reconnect backoff and fails once the app disconnects", () =>
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
      yield* TestClock.adjust("2 minutes");
      expect(waiting.pollUnsafe()).toBeUndefined();

      yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);
      expect((yield* Fiber.join(waiting))._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual(["command-host-gone"]);
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
      expect(error._tag).toBe("EnvironmentRpcUnavailableError");
      expect(error.message).toBe("Test environment did not confirm the message within 60 seconds.");
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
