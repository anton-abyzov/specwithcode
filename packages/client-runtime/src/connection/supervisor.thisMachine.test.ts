import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type ConnectionAttemptError,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

// The server on this machine, at the address the desktop app and a browser
// tab at http://127.0.0.1:8319 both use.
const LOOPBACK_TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "http://127.0.0.1:8319/",
  wsBaseUrl: "ws://127.0.0.1:8319/",
});
const LOOPBACK_ENTRY: ConnectionCatalogEntry = {
  target: LOOPBACK_TARGET,
  profile: Option.none(),
  enabled: true,
};
const REMOTE_TARGET = new PrimaryConnectionTarget({
  environmentId: LOOPBACK_TARGET.environmentId,
  label: LOOPBACK_TARGET.label,
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const REMOTE_ENTRY: ConnectionCatalogEntry = {
  target: REMOTE_TARGET,
  profile: Option.none(),
  enabled: true,
};

function preparedFor(entry: ConnectionCatalogEntry): PreparedConnection {
  return {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    httpBaseUrl: "http://127.0.0.1:8319/",
    socketUrl: "ws://127.0.0.1:8319/ws",
    httpAuthorization: null,
    target: entry.target,
  };
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const settle = Effect.fnUntraced(function* () {
  for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
});

/**
 * A driver whose sessions report inbound traffic: `frame` stands for one
 * frame arriving on the latest session.
 */
const makeHarness = Effect.fn("TestThisMachineHarness.make")(function* (options: {
  readonly setup?: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: Effect.Effect<void, ConnectionAttemptError>;
}) {
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const probeCount = yield* Ref.make(0);
  const connectOptions = yield* Ref.make<
    ReadonlyArray<ConnectionDriver.ConnectionDriverConnectOptions | undefined>
  >([]);
  const lastInboundAt = yield* Ref.make<number | undefined>(undefined);
  const inboundSignal = yield* Ref.make(yield* Deferred.make<void>());
  const closed = yield* Deferred.make<never, ConnectionTransientError>();

  const connect = Effect.fn("TestThisMachineDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
    driverOptions?: ConnectionDriver.ConnectionDriverConnectOptions,
  ) {
    yield* Ref.update(connectOptions, (current) => [...current, driverOptions]);
    yield* reportProgress({ stage: "preparing" });
    yield* options.setup ?? Effect.void;
    const prepared = preparedFor(entry);
    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: {} as WsRpcProtocolClient,
        initialConfig: Effect.die(new Error("Initial config is not used here.")),
        subscribeServerConfig: () => Stream.empty,
        ready: Effect.void,
        probe: Ref.update(probeCount, (count) => count + 1).pipe(
          Effect.andThen(options.probe ?? Effect.void),
        ),
        closed: Deferred.await(closed),
        lastInboundAt: Ref.get(lastInboundAt),
        nextInbound: Ref.get(inboundSignal).pipe(Effect.flatMap(Deferred.await)),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );
    yield* Ref.update(sessionCount, (count) => count + 1);
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({
        connect,
        checkRoute: () => Effect.succeed("unchecked"),
        preflight: () => Effect.succeed("unchecked"),
      }),
    ),
  );

  return {
    dependencies,
    sessionCount,
    releaseCount,
    probeCount,
    connectOptions,
    frame: Effect.gen(function* () {
      yield* Ref.set(lastInboundAt, yield* Clock.currentTimeMillis);
      const previous = yield* Ref.getAndSet(inboundSignal, yield* Deferred.make<void>());
      yield* Deferred.succeed(previous, undefined);
    }),
  };
});

describe("EnvironmentSupervisor setup budget for the server on this machine", () => {
  it.effect("waits for a setup that takes 25 seconds instead of giving up at 15", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ setup: Effect.sleep("25 seconds") });
      const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
        initiallyDesired: true,
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* TestClock.adjust("25 seconds");
      const connected = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(connected).toMatchObject({ attempt: 1, generation: 1, lastFailure: null });
      expect(yield* Ref.get(harness.connectOptions)).toEqual([{ thisMachine: true }]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("marks only the loopback primary as this machine for its requests", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ setup: Effect.never });
      const loopback = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));
      const remote = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));
      const plain = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );
      expect(loopback.thisMachine).toBe(true);
      expect(remote.thisMachine).toBe(false);
      expect(plain.thisMachine).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still gives up on a remote server after 15 seconds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ setup: Effect.sleep("25 seconds") });
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* TestClock.adjust("15 seconds");
      const backoff = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(backoff.lastFailure?.detail).toContain("did not respond during connection setup");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("gives a LAN route beside this machine's loopback route the remote budget", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ setup: Effect.sleep("80 seconds") });
      const supervisor = yield* EnvironmentSupervisor.make(
        {
          ...LOOPBACK_ENTRY,
          alternateRoutes: [{ target: REMOTE_TARGET, profile: Option.none() }],
        },
        { initiallyDesired: true, thisMachine: true },
      ).pipe(Effect.provide(harness.dependencies));

      // 60 seconds for the loopback route and 15 for the LAN route, not 60 each.
      yield* TestClock.adjust("74 seconds");
      yield* settle();
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      yield* TestClock.adjust("1 second");
      const backoff = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(backoff.lastFailure?.detail).toContain("did not respond during connection setup");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("EnvironmentSupervisor health checks for the server on this machine", () => {
  it.effect("keeps a session whose server sends other traffic while the probe waits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ probe: Effect.never });
      const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
        initiallyDesired: true,
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* TestClock.adjust("10 seconds");
      yield* supervisor.retryNow;
      yield* settle();
      expect(yield* Ref.get(harness.probeCount)).toBe(1);

      // The probe itself never answers, but a frame arrives 2 seconds later.
      yield* TestClock.adjust("2 seconds");
      yield* harness.frame;
      yield* TestClock.adjust("30 seconds");
      yield* settle();

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("answers a probe from traffic that just arrived without asking again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ probe: Effect.never });
      const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
        initiallyDesired: true,
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* TestClock.adjust("10 seconds");
      yield* harness.frame;
      yield* TestClock.adjust("1 second");
      yield* supervisor.retryNow;
      yield* TestClock.adjust("30 seconds");
      yield* settle();

      expect(yield* Ref.get(harness.probeCount)).toBe(0);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a session to this machine that sends nothing for the whole probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ probe: Effect.never });
      const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
        initiallyDesired: true,
        thisMachine: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* TestClock.adjust("10 seconds");
      yield* supervisor.retryNow;
      yield* settle();
      expect(yield* Ref.get(harness.probeCount)).toBe(1);

      yield* TestClock.adjust("14 seconds");
      yield* settle();
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still replaces a remote session that only sends other traffic", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ probe: Effect.never });
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.retryNow;
      yield* settle();
      yield* harness.frame;
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
