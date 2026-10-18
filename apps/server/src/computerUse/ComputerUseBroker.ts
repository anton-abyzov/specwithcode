import {
  COMPUTER_USE_PERMISSION_WAIT_MS,
  type ComputerUseAction,
  type ComputerUseActionResult,
  ComputerUseHostError,
  type ComputerUseHostEvent,
  type ComputerUseHostInput,
  type ComputerUseRespondInput,
  ComputerUseToolError,
  WS_METHODS,
  WsComputerUseRpcGroup,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";

/**
 * Routes agents' `computer_*` actions to the desktop app on this machine.
 *
 * The desktop app subscribes to `computerUse.host` and performs each request
 * natively, so the operating system attributes screen capture and input to
 * the app the user granted permissions to, not to this background service.
 * The newest host wins; one action runs at a time because there is only one
 * pointer and one keyboard.
 */
export class ComputerUseBroker extends Context.Service<
  ComputerUseBroker,
  {
    readonly host: (input: ComputerUseHostInput) => Stream.Stream<ComputerUseHostEvent>;
    readonly respond: (input: ComputerUseRespondInput) => Effect.Effect<void, ComputerUseHostError>;
    readonly invoke: (
      action: ComputerUseAction,
    ) => Effect.Effect<ComputerUseActionResult, ComputerUseToolError>;
    /** Whether a desktop app is connected to answer actions. */
    readonly hasHost: Effect.Effect<boolean>;
  }
>()("specweave-studio/computerUse/ComputerUseBroker") {}

/** What the agent is told when no desktop app is hosting. */
export const NO_HOST_REASON =
  "The SpecWithCode desktop app is not open on this machine, so there is no desktop to control. Ask the user to open the SpecWithCode app on this computer, then try again.";

const ACTION_TIMEOUT_MS: Record<ComputerUseAction["kind"], number> = {
  status: 10_000,
  screenshot: 20_000,
  click: 10_000,
  move: 10_000,
  drag: 15_000,
  scroll: 10_000,
  type: 30_000,
  key: 15_000,
  open: 30_000,
};

interface Host {
  readonly id: string;
  readonly label: string;
  readonly queue: Queue.Queue<ComputerUseHostEvent>;
}

interface Pending {
  readonly hostId: string;
  readonly deferred: Deferred.Deferred<ComputerUseActionResult, ComputerUseToolError>;
}

export const make = Effect.gen(function* () {
  const hosts: Array<Host> = [];
  const pending = new Map<string, Pending>();
  const turn = yield* Semaphore.make(1);
  let sequence = 0;

  const failPendingFor = (hostId: string, reason: string) =>
    Effect.forEach(
      Array.from(pending.entries()).filter(([, entry]) => entry.hostId === hostId),
      ([requestId, entry]) => {
        pending.delete(requestId);
        return Deferred.fail(entry.deferred, new ComputerUseToolError({ reason }));
      },
      { discard: true },
    );

  const host = (input: ComputerUseHostInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ComputerUseHostEvent>();
        const id = `computer-host-${++sequence}`;
        hosts.push({ id, label: input.label, queue });
        yield* Effect.logInfo("Computer use host connected", { hostId: id, label: input.label });
        yield* Queue.offer(queue, { type: "connected", hostId: id });
        const release = Effect.suspend(() => {
          const index = hosts.findIndex((entry) => entry.id === id);
          if (index !== -1) hosts.splice(index, 1);
          return failPendingFor(
            id,
            "The SpecWithCode desktop app disconnected before it finished the action.",
          ).pipe(
            Effect.andThen(Queue.shutdown(queue)),
            Effect.andThen(Effect.logInfo("Computer use host disconnected", { hostId: id })),
          );
        });
        return Stream.fromQueue(queue).pipe(Stream.ensuring(release));
      }),
    );

  const respond = (input: ComputerUseRespondInput) =>
    Effect.gen(function* () {
      const entry = pending.get(input.requestId);
      if (entry === undefined || entry.hostId !== input.hostId) {
        return yield* new ComputerUseHostError({ reason: "No such computer use request." });
      }
      pending.delete(input.requestId);
      if (input.result !== undefined && input.error === undefined) {
        yield* Deferred.succeed(entry.deferred, input.result);
      } else {
        yield* Deferred.fail(
          entry.deferred,
          new ComputerUseToolError({
            reason: input.error ?? "The desktop app returned no result.",
          }),
        );
      }
    });

  const invoke = (action: ComputerUseAction) =>
    turn.withPermits(1)(
      Effect.gen(function* () {
        const target = hosts.at(-1);
        if (target === undefined) {
          return yield* new ComputerUseToolError({ reason: NO_HOST_REASON });
        }
        const requestId = `computer-${++sequence}`;
        const deferred = yield* Deferred.make<ComputerUseActionResult, ComputerUseToolError>();
        pending.set(requestId, { hostId: target.id, deferred });
        yield* Queue.offer(target.queue, { type: "request", request: { requestId, action } });
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            // The host may hold an action while the user allows a permission.
            duration: ACTION_TIMEOUT_MS[action.kind] + COMPUTER_USE_PERMISSION_WAIT_MS,
            orElse: () =>
              Effect.fail(
                new ComputerUseToolError({
                  reason: `The desktop app did not finish the ${action.kind} action in time.`,
                }),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        );
      }),
    );

  return ComputerUseBroker.of({
    host,
    respond,
    invoke,
    hasHost: Effect.sync(() => hosts.length > 0),
  });
});

export const layer = Layer.effect(ComputerUseBroker, make);

/**
 * The `computerUse.*` handlers, registered apart from the rest of the
 * WebSocket API (see `WsComputerUseRpcGroup`).
 */
export const layerRpcHandlers = WsComputerUseRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker;
    return {
      [WS_METHODS.computerUseHost]: (input) => broker.host(input),
      [WS_METHODS.computerUseRespond]: (input) => broker.respond(input).pipe(Effect.as({})),
    };
  }),
);
