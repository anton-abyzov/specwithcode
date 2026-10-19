/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistry.layer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      acquires `ServerSettingsService.subscribeChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "./acp/AcpRegistrySupport.ts";
import * as AcpRegistryCatalog from "./AcpRegistryCatalog.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
    >
  | Settings.ServerSettingsService;

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
/**
 * Leaves out of `configMap` the ids about to start whose leftover sign-in
 * could not be cleared first. Runs after the previous reconcile disposed
 * whatever ran under those ids, so a token a removed instance wrote while
 * shutting down is deleted before a re-added instance of the same id starts.
 * A left-out id is retried (see `BLOCKED_START_RETRY_DELAYS`).
 */
const withoutBlockedStarts = (
  serverSettings: Settings.ServerSettingsService["Service"],
  configMap: ProviderInstanceConfigMap,
  running: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const clearBeforeStart = serverSettings.clearSignInsBeforeStart;
    const none: ReadonlySet<string> = new Set();
    if (clearBeforeStart === undefined) return { configMap, blocked: none };
    const starting = Object.keys(configMap).filter((id) => !running.has(id));
    if (starting.length === 0) return { configMap, blocked: none };
    const blocked = yield* clearBeforeStart(starting);
    if (blocked.size === 0) return { configMap, blocked };
    yield* Effect.logWarning("Not starting provider instances until their old sign-in is gone", {
      instanceIds: [...blocked],
    });
    return { configMap: withoutIds(configMap, blocked), blocked };
  });

const withoutIds = (configMap: ProviderInstanceConfigMap, ids: ReadonlySet<string>) =>
  Object.fromEntries(
    Object.entries(configMap).filter(([id]) => !ids.has(id)),
  ) as ProviderInstanceConfigMap;

/** Waits before each retry of a start a failed sign-in delete held back; the last repeats. */
export const BLOCKED_START_RETRY_DELAYS: ReadonlyArray<Duration.Input> = [
  "5 seconds",
  "30 seconds",
  "2 minutes",
];

export const layerSettingsWatcher = (
  initialConfigMap: ProviderInstanceConfigMap,
  // Ids boot held back from starting; retried like any other.
  initialBlocked: ReadonlySet<string> = new Set(),
  retryDelays: ReadonlyArray<Duration.Input> = BLOCKED_START_RETRY_DELAYS,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      const settingsChanges = yield* serverSettings.subscribeChanges;
      // Ids the registry runs, as of the last finished reconcile.
      const running = yield* Ref.make<ReadonlySet<string>>(new Set(Object.keys(initialConfigMap)));
      // A settings change and a retry never reconcile at the same time.
      const syncLock = yield* Semaphore.make(1);
      // A removed instance's sign-in is deleted for good only once reconcile
      // has disposed its driver, which could otherwise write it back. One
      // fiber runs the cleanups in order, against the registry as it is when
      // each one starts, so a slow Codex sign-in lock never holds up the next
      // reconcile.
      const clearRemovedSignIns = serverSettings.clearRemovedInstanceSignIns;
      const cleanupRequests = yield* Queue.sliding<void>(1);
      if (clearRemovedSignIns !== undefined) {
        yield* Queue.take(cleanupRequests).pipe(
          Effect.andThen(Ref.get(running)),
          Effect.flatMap(clearRemovedSignIns),
          Effect.forever,
          Effect.forkScoped,
        );
        // Retries a cleanup an earlier run left unfinished.
        yield* Queue.offer(cleanupRequests, undefined);
      }
      const awaitingClear = serverSettings.instancesAwaitingSignInClear;

      /** Brings the registry to `settings`; returns the ids held back from starting. */
      const sync = (settings: ServerSettings) =>
        syncLock.withPermits(1)(
          Effect.gen(function* () {
            const desired = deriveProviderInstanceConfigMap(settings);
            // A re-added id the registry still runs from before (a reconcile
            // that would have stopped it failed) is stopped first, so its old
            // sign-in is deleted before the new instance starts and never later.
            const runningBefore = yield* Ref.get(running);
            const stillRunning = Object.keys(desired).filter((id) => runningBefore.has(id));
            const restarting =
              awaitingClear === undefined || stillRunning.length === 0
                ? new Set<string>()
                : yield* awaitingClear(stillRunning);
            if (restarting.size > 0) {
              // Only what already runs: an id that is not running yet starts
              // below, through `withoutBlockedStarts`, after its clear.
              const stopped = Object.fromEntries(
                Object.entries(desired).filter(
                  ([id]) => runningBefore.has(id) && !restarting.has(id),
                ),
              ) as ProviderInstanceConfigMap;
              yield* mutator.reconcile(stopped);
              yield* Ref.set(running, new Set(Object.keys(stopped)));
            }
            const { configMap, blocked } = yield* withoutBlockedStarts(
              serverSettings,
              desired,
              yield* Ref.get(running),
            );
            yield* mutator.reconcile(configMap);
            yield* Ref.set(running, new Set(Object.keys(configMap)));
            if (clearRemovedSignIns !== undefined) yield* Queue.offer(cleanupRequests, undefined);
            return blocked;
          }),
        );
      const syncOrLog = (settings: ServerSettings) =>
        sync(settings).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("ProviderInstanceRegistry reconcile failed", cause).pipe(
              Effect.as(new Set<string>() as ReadonlySet<string>),
            ),
          ),
        );

      // A start held back by a failed sign-in delete is retried with the
      // latest settings, rather than waiting for an unrelated settings change.
      const retryRequests = yield* Queue.sliding<void>(1);
      yield* Queue.take(retryRequests).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            for (let attempt = 0; ; attempt++) {
              yield* Effect.sleep(retryDelays[Math.min(attempt, retryDelays.length - 1)]!);
              const latest = yield* serverSettings.getSettings.pipe(
                Effect.orElseSucceed(() => undefined),
              );
              if (latest === undefined) continue;
              if ((yield* syncOrLog(latest)).size === 0) return;
            }
          }),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const retryIfBlocked = (blocked: ReadonlySet<string>) =>
        blocked.size > 0 ? Queue.offer(retryRequests, undefined) : Effect.void;

      if (initialBlocked.size > 0) yield* Queue.offer(retryRequests, undefined);
      yield* settingsChanges.pipe(
        Stream.runForEach((next) => syncOrLog(next).pipe(Effect.flatMap(retryIfBlocked))),
        Effect.forkScoped,
      );
    }),
  );

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistry.layer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator, acquires its settings
 *     subscription before forking, and runs a daemon fiber in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const layer: Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    // Nothing ran before boot, so every instance is about to start.
    const initial =
      initialSettings === undefined
        ? { configMap: {} as ProviderInstanceConfigMap, blocked: new Set<string>() }
        : yield* withoutBlockedStarts(
            serverSettings,
            deriveProviderInstanceConfigMap(initialSettings),
            new Set(),
          );
    const initialConfigMap = initial.configMap;

    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistryCatalog.layer),
    );

    return layerSettingsWatcher(initialConfigMap, initial.blocked).pipe(
      Layer.provideMerge(layerMutable),
    );
  }),
) as Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
