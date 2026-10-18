import { expect, it } from "@effect/vitest";
import {
  type ComputerUseActionResult,
  type ComputerUseHostEvent,
  computerUseRpcs,
  WS_METHODS,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { RpcGroup, RpcTest } from "effect/rpc";

import * as ComputerUseBroker from "./ComputerUseBroker.ts";

const result: ComputerUseActionResult = {
  platform: "macos",
  permissions: { screenRecording: true, accessibility: true },
  display: { width: 1512, height: 982 },
  cursor: { x: 10, y: 20 },
  frontmostApplication: "System Settings",
};

/** Connects a host and returns its events as a queue the test reads from. */
const connectHost = (broker: ComputerUseBroker.ComputerUseBroker["Service"]) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ComputerUseHostEvent>();
    const fiber = yield* broker.host({ label: "test desktop", platform: "macos" }).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkChild,
    );
    const connected = yield* Queue.take(events);
    if (connected.type !== "connected") throw new Error("expected a connected event first");
    return { hostId: connected.hostId, events, fiber };
  });

it.effect("tells the agent to open the desktop app when no host is connected", () =>
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker.make;
    expect(yield* broker.hasHost).toBe(false);
    const exit = yield* broker.invoke({ kind: "screenshot" }).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("desktop app is not open");
    }
  }),
);

it.effect("routes an action to the host and returns its answer", () =>
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker.make;
    const host = yield* connectHost(broker);
    expect(yield* broker.hasHost).toBe(true);

    const pending = yield* broker.invoke({ kind: "click", x: 5, y: 6 }).pipe(Effect.forkChild);
    const request = yield* Queue.take(host.events);
    expect(request.type).toBe("request");
    if (request.type !== "request") return;
    expect(request.request.action).toEqual({ kind: "click", x: 5, y: 6 });

    yield* broker.respond({ hostId: host.hostId, requestId: request.request.requestId, result });
    expect(yield* Fiber.join(pending)).toEqual(result);
    yield* Fiber.interrupt(host.fiber);
  }),
);

it.effect("passes the host's error message to the agent", () =>
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker.make;
    const host = yield* connectHost(broker);
    const pending = yield* broker.invoke({ kind: "type", text: "hi" }).pipe(Effect.forkChild);
    const request = yield* Queue.take(host.events);
    if (request.type !== "request") throw new Error("expected a request");
    yield* broker.respond({
      hostId: host.hostId,
      requestId: request.request.requestId,
      error: "SpecWithCode does not have Accessibility permission",
    });
    const exit = yield* Fiber.await(pending);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Accessibility permission");
    yield* Fiber.interrupt(host.fiber);
  }),
);

it.effect("refuses an answer from a different host", () =>
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker.make;
    const host = yield* connectHost(broker);
    const pending = yield* broker.invoke({ kind: "status" }).pipe(Effect.forkChild);
    const request = yield* Queue.take(host.events);
    if (request.type !== "request") throw new Error("expected a request");
    const wrong = yield* broker
      .respond({ hostId: "someone-else", requestId: request.request.requestId, result })
      .pipe(Effect.exit);
    expect(Exit.isFailure(wrong)).toBe(true);
    yield* broker.respond({ hostId: host.hostId, requestId: request.request.requestId, result });
    expect(yield* Fiber.join(pending)).toEqual(result);
    yield* Fiber.interrupt(host.fiber);
  }),
);

it.effect("fails a pending action when its host disconnects", () =>
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker.make;
    const host = yield* connectHost(broker);
    const pending = yield* broker.invoke({ kind: "screenshot" }).pipe(Effect.forkChild);
    yield* Queue.take(host.events);
    yield* Fiber.interrupt(host.fiber);
    const exit = yield* Fiber.await(pending);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("disconnected");
    expect(yield* broker.hasHost).toBe(false);
  }),
);

it.effect("sends actions to the newest host", () =>
  Effect.gen(function* () {
    const broker = yield* ComputerUseBroker.make;
    const older = yield* connectHost(broker);
    const newer = yield* connectHost(broker);
    const pending = yield* broker.invoke({ kind: "status" }).pipe(Effect.forkChild);
    const request = yield* Queue.take(newer.events);
    if (request.type !== "request") throw new Error("expected a request");
    expect(yield* Queue.size(older.events)).toBe(0);
    yield* broker.respond({ hostId: newer.hostId, requestId: request.request.requestId, result });
    expect(yield* Fiber.join(pending)).toEqual(result);
    yield* Fiber.interrupt(older.fiber);
    yield* Fiber.interrupt(newer.fiber);
  }),
);

it.effect("serves the host RPCs from handlers provided by the enclosing context", () =>
  Effect.gen(function* () {
    // server.ts provides the handlers globally; each connection's RPC server reads them from
    // the request context, as this client's in-memory server does here.
    const client = yield* RpcTest.makeClient(RpcGroup.make(...computerUseRpcs));
    const broker = yield* ComputerUseBroker.ComputerUseBroker;
    const events = yield* Queue.unbounded<ComputerUseHostEvent>();
    const hostFiber = yield* client[WS_METHODS.computerUseHost]({
      label: "test desktop",
      platform: "macos",
    }).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkChild,
    );
    const connected = yield* Queue.take(events);
    if (connected.type !== "connected") throw new Error("expected a connected event first");

    const pending = yield* broker.invoke({ kind: "status" }).pipe(Effect.forkChild);
    const request = yield* Queue.take(events);
    if (request.type !== "request") throw new Error("expected a request");
    yield* client[WS_METHODS.computerUseRespond]({
      hostId: connected.hostId,
      requestId: request.request.requestId,
      result,
    });
    expect(yield* Fiber.join(pending)).toEqual(result);
    yield* Fiber.interrupt(hostFiber);
  }).pipe(
    Effect.provide(
      ComputerUseBroker.layerRpcHandlers.pipe(Layer.provideMerge(ComputerUseBroker.layer)),
    ),
  ),
);
