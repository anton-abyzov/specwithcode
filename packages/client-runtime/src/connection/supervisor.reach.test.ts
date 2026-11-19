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
  type SupervisorConnectionState,
} from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const ENTRY: ConnectionCatalogEntry = { target: TARGET, profile: Option.none(), enabled: true };

const silent = new ConnectionTransientError({ reason: "timeout", detail: "No answer." });
const dropped = new ConnectionTransientError({ reason: "transport", detail: "Session closed." });

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
 * A driver for another machine. `setup` decides each attempt (1-based), and
 * `close` ends the latest session the way a dropped socket does.
 */
const makeHarness = Effect.fn("TestReachHarness.make")(function* (options: {
  readonly setup?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: Effect.Effect<void, ConnectionAttemptError>;
}) {
  const attempts = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connect = Effect.fn("TestReachDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
    yield* options.setup?.(attempt) ?? Effect.void;
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);
    yield* Ref.update(sessionCount, (count) => count + 1);
    return {
      prepared: {
        environmentId: entry.target.environmentId,
        label: entry.target.label,
        httpBaseUrl: "https://environment.example.test/",
        socketUrl: "wss://environment.example.test/ws",
        httpAuthorization: null,
        target: entry.target,
      },
      session: {
        client: {} as WsRpcProtocolClient,
        initialConfig: Effect.die(new Error("Initial config is not used here.")),
        subscribeServerConfig: () => Stream.empty,
        ready: Effect.void,
        probe: options.probe ?? Effect.void,
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession,
    } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const dependencies = Layer.mergeAll(
    // Jitter at its maximum, so each retry waits exactly its ceiling.
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
    attempts,
    sessionCount,
    close: (error: ConnectionTransientError = dropped) =>
      Ref.get(closedSessions).pipe(
        Effect.flatMap((sessions) => {
          const latest = sessions.at(-1);
          return latest === undefined ? Effect.void : Deferred.fail(latest, error);
        }),
      ),
  };
});

const makeSupervisor = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  EnvironmentSupervisor.make(ENTRY, { initiallyDesired: true }).pipe(
    Effect.provide(harness.dependencies),
  );

describe("EnvironmentSupervisor reach facts", () => {
  it.effect("counts a wanted connection as lost from the moment it was asked for", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      const harness = yield* makeHarness({ setup: () => Effect.never });
      const supervisor = yield* makeSupervisor(harness);

      const connecting = yield* SubscriptionRef.get(supervisor.state);
      expect(connecting).toMatchObject({
        phase: "connecting",
        lostAt: 5_000,
        lastConnectedAt: null,
        lossFailure: null,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("clears the loss while connected and dates it from the session's end", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (attempt) => (attempt === 1 ? Effect.sleep("2 seconds") : Effect.fail(silent)),
      });
      const supervisor = yield* makeSupervisor(harness);
      yield* TestClock.adjust("2 seconds");
      const connected = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(connected).toMatchObject({ lostAt: null, lastConnectedAt: 2_000, lossFailure: null });

      yield* TestClock.adjust("40 seconds");
      yield* harness.close();
      const lost = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(lost).toMatchObject({ lostAt: 42_000, lastConnectedAt: 42_000 });
      expect(lost.lossFailure?.message).toBe("Session closed.");

      // Later attempts keep the moment the loss began and take the newest cause.
      yield* TestClock.adjust("2 seconds");
      const failedAgain = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.lastFailure?.message === "No answer.",
      );
      expect(failedAgain).toMatchObject({ lostAt: 42_000, lastConnectedAt: 42_000 });
      expect(failedAgain.lossFailure?.message).toBe("No answer.");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the loss and its cause while an explicit retry runs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (attempt) => (attempt === 1 ? Effect.fail(silent) : Effect.never),
      });
      const supervisor = yield* makeSupervisor(harness);
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("1 second");

      yield* supervisor.retryNow;
      const retrying = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.lastFailure === null,
      );
      // The attempt starts over, but what a person reads does not blank.
      expect(retrying.attempt).toBe(1);
      expect(retrying.lostAt).toBe(0);
      expect(retrying.lossFailure?.message).toBe("No answer.");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forgets the loss once nobody wants the connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ setup: () => Effect.fail(silent) });
      const supervisor = yield* makeSupervisor(harness);
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      yield* supervisor.disconnect;
      const idle = yield* awaitState(supervisor.state, (state) => state.phase === "available");
      expect(idle).toMatchObject({ lostAt: null, lossFailure: null });

      yield* TestClock.adjust("10 seconds");
      yield* supervisor.connect;
      const again = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(again.lostAt).toBe(10_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("EnvironmentSupervisor recovery of a machine that was just connected", () => {
  it.effect("retries at most a minute apart for 30 minutes, then on the long ladder", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (attempt) => (attempt === 1 ? Effect.void : Effect.fail(silent)),
      });
      const supervisor = yield* makeSupervisor(harness);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.close();

      const waits: Array<{ readonly sinceLostMs: number; readonly waitMs: number }> = [];
      let attempt = 0;
      while (waits.length === 0 || waits.at(-1)!.sinceLostMs < 40 * 60_000) {
        const backoff = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt > attempt,
        );
        attempt = backoff.attempt;
        const now = yield* Clock.currentTimeMillis;
        const waitMs = backoff.retryAt! - now;
        waits.push({ sinceLostMs: now - backoff.lostAt!, waitMs });
        yield* TestClock.adjust(waitMs);
      }

      const recent = waits.filter((wait) => wait.sinceLostMs < 30 * 60_000);
      const later = waits.filter((wait) => wait.sinceLostMs >= 30 * 60_000);
      expect(recent.slice(0, 7).map((wait) => wait.waitMs)).toEqual([
        2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
      ]);
      expect(Math.max(...recent.map((wait) => wait.waitMs))).toBe(60_000);
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((wait) => wait.waitMs === 300_000)).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a session that answers an explicit retry within 15 seconds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ probe: Effect.sleep("14 seconds") });
      const supervisor = yield* makeSupervisor(harness);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      yield* supervisor.retryNow;
      yield* settle();
      // The old 3 second limit would have replaced the session here.
      yield* TestClock.adjust("3 seconds");
      yield* settle();
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
      yield* TestClock.adjust("11 seconds");
      yield* TestClock.adjust("60 seconds");
      yield* settle();
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
        lostAt: null,
      });
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a session that stays silent for 15 seconds after an explicit retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ probe: Effect.never });
      const supervisor = yield* makeSupervisor(harness);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      yield* supervisor.retryNow;
      yield* settle();
      yield* TestClock.adjust("14999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      const replaced = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(replaced.lostAt).toBeNull();
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
