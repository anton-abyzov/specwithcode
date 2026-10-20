import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type HostPowerSnapshot,
  type ServerSettings as ContractServerSettings,
  type ClientActivityReportInput,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const TEST_NOW = DateTime.makeUnsafe("2026-05-13T00:00:00.000Z");

const nominalHostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: TEST_NOW,
};

const constrainedHostPower: HostPowerSnapshot = {
  ...nominalHostPower,
  lowPowerMode: "true",
  stale: false,
};

function makeReport(overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput {
  return {
    clientId: "client-1",
    clientKind: "web",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "vcs-status", cwd: "/repo" }],
    ttlMs: 45_000,
    observedAt: TEST_NOW,
    ...overrides,
  };
}

function layerFor(
  hostPower: HostPowerSnapshot,
  settingsOverrides: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  const layerHost = Layer.effect(
    HostPowerMonitor.HostPowerMonitor,
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);
      let snapshot = hostPower;
      return HostPowerMonitor.HostPowerMonitor.of({
        snapshot: Effect.sync(() => snapshot),
        report: (next) =>
          Effect.sync(() => {
            snapshot = next;
          }).pipe(Effect.andThen(PubSub.publish(changes, next)), Effect.asVoid),
        streamChanges: Stream.fromPubSub(changes),
      });
    }),
  );
  return BackgroundPolicy.layer.pipe(
    Layer.provide(Layer.merge(layerHost, ServerSettings.layerTest(settingsOverrides))),
  );
}

describe("BackgroundPolicy", () => {
  it.effect("records foreground scoped client demand", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/other" }), false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/other" }), false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("removes all leases for a disconnected websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );
      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1));

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, []);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps leases from another session when rpc client ids are reused", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientId = RpcClientId.make(1);
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        rpcClientId,
        makeReport({ clientId: "client-1" }),
      );
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        rpcClientId,
        makeReport({ clientId: "client-2" }),
      );

      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), rpcClientId);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.leases[0]?.sessionId, AuthSessionId.make("session-2"));
      assert.equal(snapshot.leases[0]?.clientId, "client-2");
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("serializes lease mutation publications", () =>
    Effect.gen(function* () {
      const firstSnapshotStarted = yield* Deferred.make<void>();
      const releaseFirstSnapshot = yield* Deferred.make<void>();
      const snapshotReads = yield* Ref.make(0);
      const layerHost = Layer.succeed(
        HostPowerMonitor.HostPowerMonitor,
        HostPowerMonitor.HostPowerMonitor.of({
          snapshot: Ref.updateAndGet(snapshotReads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(firstSnapshotStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstSnapshot)),
                    Effect.as(nominalHostPower),
                  )
                : Effect.succeed(nominalHostPower),
            ),
          ),
          report: () => Effect.void,
          streamChanges: Stream.empty,
        }),
      );
      const layer = BackgroundPolicy.layer.pipe(
        Layer.provide(Layer.merge(layerHost, ServerSettings.layerTest())),
      );

      yield* Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        const updatesFiber = yield* policy.streamChanges.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const reportFiber = yield* policy
          .reportClientActivity(AuthSessionId.make("session-1"), RpcClientId.make(1), makeReport())
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const removeFiber = yield* policy
          .removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFirstSnapshot, undefined);
        yield* Fiber.join(reportFiber);
        yield* Fiber.join(removeFiber);
        const updates = Array.from(yield* Fiber.join(updatesFiber));

        assert.equal(updates.at(-1)?.activeForegroundLeaseCount, 0);
        assert.deepStrictEqual(updates.at(-1)?.activeScopeKeys, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("reads settings outside the publish lock and keeps them until they change", () =>
    Effect.gen(function* () {
      const settingsReads = yield* Ref.make(0);
      const firstReadStarted = yield* Deferred.make<void>();
      const releaseFirstRead = yield* Deferred.make<void>();
      const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
      const layerSettings = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const base = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...base,
            getSettings: Ref.updateAndGet(settingsReads, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 1
                  ? Deferred.succeed(firstReadStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirstRead)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(base.getSettings),
            ),
            subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
              Effect.map((subscription) => Stream.fromSubscription(subscription)),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest()));
      const layerHost = Layer.succeed(
        HostPowerMonitor.HostPowerMonitor,
        HostPowerMonitor.HostPowerMonitor.of({
          snapshot: Effect.succeed(nominalHostPower),
          report: () => Effect.void,
          streamChanges: Stream.empty,
        }),
      );
      const layer = BackgroundPolicy.layer.pipe(
        Layer.provide(Layer.merge(layerHost, layerSettings)),
      );

      yield* Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        const sessionId = AuthSessionId.make("session-1");
        // The first report waits on a slow settings read without holding the lock,
        // so a subscriber (which takes the lock) is not stuck behind it.
        const reportFiber = yield* policy
          .reportClientActivity(sessionId, RpcClientId.make(1), makeReport())
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstReadStarted);
        const subscribed = yield* Effect.scoped(policy.subscribe).pipe(
          Effect.timeoutOption("5 seconds"),
        );
        assert.isTrue(Option.isSome(subscribed));
        yield* Deferred.succeed(releaseFirstRead, undefined);
        yield* Fiber.join(reportFiber);
        const readsBeforeReports = yield* Ref.get(settingsReads);

        for (let report = 0; report < 50; report++) {
          yield* policy.reportClientActivity(
            sessionId,
            RpcClientId.make(1),
            makeReport({ focused: false, visible: false, recentlyInteracted: false }),
          );
        }
        assert.equal(yield* Ref.get(settingsReads), readsBeforeReports);
        assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);

        // A settings change replaces the kept value without another read.
        const performance = yield* ServerSettings.ServerSettingsService.pipe(
          Effect.flatMap((settings) => settings.getSettings),
          Effect.provide(ServerSettings.layerTest({ backgroundActivityProfile: "performance" })),
        );
        const published = yield* policy.streamChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* PubSub.publish(settingsChanges, performance);
        yield* Fiber.join(published);
        assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
        assert.equal(yield* Ref.get(settingsReads), readsBeforeReports);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("bounds client-id churn for one websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("session-1");
      const rpcClientId = RpcClientId.make(1);
      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          rpcClientId,
          makeReport({ clientId: `client-${index}` }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
      assert.isTrue(
        snapshot.leases.some(
          (lease) =>
            lease.clientId ===
            `client-${BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT}`,
        ),
      );
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("host low power mode disables opportunistic work without dropping scoped demand", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor(constrainedHostPower))),
  );

  it.effect("host suspension disables scoped and opportunistic work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor({
          ...nominalHostPower,
          suspended: true,
          stale: false,
        }),
      ),
    ),
  );

  it.effect("keeps background demand visible while preventing scoped work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, visible: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(yield* policy.hasDemand({ type: "vcs-status", cwd: "/repo" }), true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps scoped work active after a recently used visible window loses focus", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: true }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("pauses scoped work for a visible unfocused client without recent interaction", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect(
    "performance profile allows background scoped work while a scoped lease is active",
    () =>
      Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        yield* policy.reportClientActivity(
          AuthSessionId.make("session-1"),
          RpcClientId.make(1),
          makeReport({ focused: false, visible: false }),
        );

        assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
      }).pipe(
        Effect.provide(layerFor(nominalHostPower, { backgroundActivityProfile: "performance" })),
      ),
  );

  it.effect("battery saver profile pauses scoped work on battery", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            onBattery: "true",
            stale: false,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );

  it.effect("does not gate work on stale host power values", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            locked: "true",
            onBattery: "true",
            lowPowerMode: "true",
            thermalState: "critical",
            stale: true,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );
});
