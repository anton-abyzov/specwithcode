import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ServerSettingsError,
  UsageLimitSourceId,
  type ServerSettings,
  type UsageLimitSourceSnapshot,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import * as Sources from "./UsageLimitSources.ts";
import { makeHub, transport as hubTransport } from "./usageLimitHub.test-fixtures.ts";

// Sources.make also owns local hub detection, which needs FileSystem and Path.
const transport = Layer.mergeAll(hubTransport, NodeServices.layer);

const sourceId = UsageLimitSourceId.make("synthetic-hub");
const makeFixture = Effect.gen(function* () {
  const hub = yield* makeHub;
  const base = yield* Settings.ServerSettingsService;
  const changes = yield* PubSub.unbounded<ServerSettings>();
  const subscribed = yield* Deferred.make<void>();
  const flags = { failSettings: false, allowBackground: true, policyChecks: 0 };
  const settings: Settings.ServerSettingsService["Service"] = {
    ...base,
    getSettings: Effect.suspend(() =>
      flags.failSettings
        ? Effect.fail(
            new ServerSettingsError({ settingsPath: "synthetic-settings", operation: "read-file" }),
          )
        : base.getSettings,
    ),
    updateSettings: (patch) =>
      base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        yield* Deferred.succeed(subscribed, undefined);
        return Stream.fromSubscription(subscription);
      }),
    ),
  };
  const policy = BackgroundPolicy.BackgroundPolicy.of({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.die("Unused host observation"),
    streamChanges: Stream.empty,
    subscribe: Effect.die("Unused host subscription"),
    hasDemand: () => Effect.succeed(false),
    shouldRunOpportunisticWork: Effect.succeed(false),
    shouldRunScopeWork: (scope) =>
      Effect.sync(() => {
        expect(scope).toEqual({ type: "provider-status" });
        flags.policyChecks++;
        return flags.allowBackground;
      }),
  });
  const service = yield* Sources.make.pipe(
    Effect.provideService(Settings.ServerSettingsService, settings),
    Effect.provideService(BackgroundPolicy.BackgroundPolicy, policy),
  );
  yield* Deferred.await(subscribed);
  yield* service.refresh;
  return { hub, flags, settings, service };
}).pipe(Effect.provide(Settings.layerTest()));

function observe(
  service: Sources.UsageLimitSources["Service"],
  predicate: (rows: ReadonlyArray<UsageLimitSourceSnapshot>) => boolean,
) {
  return Effect.gen(function* () {
    const seen = yield* Deferred.make<ReadonlyArray<UsageLimitSourceSnapshot>>();
    yield* service.streamChanges.pipe(
      Stream.runForEach((rows) => (predicate(rows) ? Deferred.succeed(seen, rows) : Effect.void)),
      Effect.forkScoped,
    );
    return Deferred.await(seen);
  });
}

describe("UsageLimitSources composed loopback integration", () => {
  it.effect(
    "publishes enabled sources, explicit missing-key/error rows, and labels without probing disabled sources",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        yield* f.settings.updateSettings({
          usageLimitSources: {
            [sourceId]: { ...f.hub.config, label: "Owned fake hub" },
            [UsageLimitSourceId.make("missing")]: { ...f.hub.config, managementKey: "" },
            [UsageLimitSourceId.make("disabled")]: { ...f.hub.config, enabled: false },
            [UsageLimitSourceId.make("invalid")]: { ...f.hub.config, url: "invalid-url" },
          },
        });
        yield* f.service.refresh;
        const rows = yield* f.service.current;
        expect(rows.map((s) => s.id)).toEqual([sourceId, "missing", "invalid"]);
        expect(rows[0]).toMatchObject({
          label: "Owned fake hub",
          accounts: [{ id: "codex.json" }, { id: "claude.json" }],
        });
        expect(rows[1]).toMatchObject({
          label: new URL(f.hub.config.url).host,
          accounts: [],
          error: "No management key configured.",
        });
        expect(rows[2]).toMatchObject({
          label: "invalid",
          accounts: [],
          error: "The hub could not list accounts.",
        });
        expect(f.hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "streams initial/current snapshots and reacts to settings add/remove without manual refresh",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        const initial = yield* observe(f.service, (rows) => rows.length === 0);
        expect(yield* initial).toEqual([]);
        const added = yield* observe(f.service, (rows) => rows[0]?.id === sourceId);
        yield* f.settings.updateSettings({ usageLimitSources: { [sourceId]: f.hub.config } });
        expect((yield* added)[0]?.accounts).toHaveLength(2);
        const removed = yield* observe(f.service, (rows) => rows.length === 0);
        yield* f.settings.updateSettings({ usageLimitSources: { [sourceId]: null } });
        expect(yield* removed).toEqual([]);
        expect(yield* f.service.current).toEqual([]);
        expect(f.hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "queues refresh behind a held real HTTP response so removed settings cannot resurrect a source",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        yield* f.settings.updateSettings({ usageLimitSources: { [sourceId]: f.hub.config } });
        yield* f.service.refresh;
        const held = f.hub.holdNextList();
        const stale = yield* f.service.refresh.pipe(Effect.forkScoped);
        yield* Effect.promise(() => held.entered);
        yield* f.settings.updateSettings({ usageLimitSources: { [sourceId]: null } });
        const removal = yield* f.service.refresh.pipe(Effect.forkScoped);
        held.release();
        yield* Fiber.join(stale);
        yield* Fiber.join(removal);
        expect(yield* f.service.current).toEqual([]);
        expect(f.hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "serializes credit mutation with pending refresh and republishes the refreshed account",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        yield* f.settings.updateSettings({ usageLimitSources: { [sourceId]: f.hub.config } });
        yield* f.service.refresh;
        const held = f.hub.holdNextList();
        const oldRead = yield* f.service.refresh.pipe(Effect.forkScoped);
        yield* Effect.promise(() => held.entered);
        const redeem = yield* f.service
          .consumeResetCredit({ sourceId, accountId: "codex.json", creditId: "first" })
          .pipe(Effect.forkScoped);
        expect(f.hub.requests.some((r) => r.body?.url?.endsWith("/consume"))).toBe(false);
        held.release();
        yield* Fiber.join(oldRead);
        expect(yield* Fiber.join(redeem)).toEqual({ outcome: "reset" });
        expect((yield* f.service.current)[0]?.accounts[0]?.usageLimits.resetCredits).toEqual({
          availableCount: 0,
        });
        expect(f.hub.requests.filter((r) => r.body?.url?.endsWith("/consume"))).toHaveLength(1);
        expect(f.hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "fails closed on missing/disabled/settings errors and keeps refresh failures as observable state",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        const input = { sourceId, accountId: "codex.json", creditId: "first" };
        expect((yield* f.service.consumeResetCredit(input).pipe(Effect.flip)).detail).toBe(
          "The usage limit source is missing or disabled.",
        );
        yield* f.settings.updateSettings({
          usageLimitSources: { [sourceId]: { ...f.hub.config, enabled: false } },
        });
        expect((yield* f.service.consumeResetCredit(input).pipe(Effect.flip)).detail).toBe(
          "The usage limit source is missing or disabled.",
        );
        expect(f.hub.requests).toHaveLength(0);
        yield* f.settings.updateSettings({ usageLimitSources: { [sourceId]: f.hub.config } });
        yield* f.service.refresh;
        f.hub.state.authStatus = 503;
        yield* f.service.refresh;
        expect((yield* f.service.current)[0]).toMatchObject({
          id: sourceId,
          accounts: [],
          error: "The hub could not list accounts.",
        });
        f.flags.failSettings = true;
        expect((yield* f.service.consumeResetCredit(input).pipe(Effect.flip)).detail).toBe(
          "Could not read hub settings.",
        );
        yield* f.service.refresh;
        expect(yield* f.service.current).toEqual([]);
        expect(f.hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect("honors the real periodic lifecycle's background policy before issuing HTTP", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.settings.updateSettings({
        backgroundActivity: {
          profile: "custom",
          baseProfile: "balanced",
          overrides: { providerHealthRefreshInterval: Duration.seconds(1) },
        },
        usageLimitSources: { [sourceId]: f.hub.config },
      });
      yield* f.service.refresh;
      f.flags.allowBackground = false;
      // Drain initialization/settings-triggered refreshes before measuring periodic work.
      yield* TestClock.adjust("20 minutes");
      yield* f.service.refresh;
      const before = f.hub.requests.length;
      yield* TestClock.adjust("2 seconds");
      expect(f.flags.policyChecks).toBeGreaterThan(0);
      expect(f.hub.requests).toHaveLength(before);
      f.flags.allowBackground = true;
      const held = f.hub.holdNextList();
      yield* TestClock.adjust("1 second");
      yield* Effect.promise(() => held.entered);
      held.release();
      yield* f.service.refresh;
      expect(f.hub.requests.length).toBeGreaterThan(before);
      expect(f.hub.violations).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(transport)),
  );
});
