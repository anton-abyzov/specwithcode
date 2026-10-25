import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@specweave-studio/contracts";
import { resolveServerBackgroundActivitySettings } from "@specweave-studio/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";
import type { ServerProviderShape } from "./ServerProvider.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  /** The account the last signed-in probe reported. */
  readonly accountEmail?: string | undefined;
  /**
   * When that account replaced a different one. Kept here, not only on the
   * published usage, so a sign-out (whose read carries no mark) followed by
   * signing in to the same account still publishes it.
   */
  readonly accountChangedAt?: string | undefined;
}

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

function loginEmail(snapshot: ServerProvider): string | undefined {
  return snapshot.auth.email?.trim().toLowerCase() || undefined;
}

/**
 * True when the probe is signed in as someone other than the account the
 * published usage belongs to. Usage, denials and credits describe one login,
 * so none of it carries over to the next.
 */
function loginChanged(published: ServerProvider, probed: ServerProvider): boolean {
  const before = loginEmail(published);
  return (
    before !== undefined && probed.auth.status === "authenticated" && loginEmail(probed) !== before
  );
}

/**
 * The usage a probe publishes, marked with when this server first saw the
 * account it belongs to (see `ProviderSnapshotState.accountChangedAt`).
 */
export function withAccountChange(
  usageLimits: ServerProvider["usageLimits"],
  accountChangedAt: string | undefined,
): ServerProvider["usageLimits"] {
  if (!usageLimits) return usageLimits;
  if (accountChangedAt === undefined || usageLimits.accountChangedAt === accountChangedAt)
    return usageLimits;
  return { ...usageLimits, accountChangedAt };
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ServerProviderShape["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean;
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | BackgroundPolicy.BackgroundPolicy | ServerSettings.ServerSettingsService
> {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
    accountEmail:
      initialSnapshot.auth.status === "authenticated" ? loginEmail(initialSnapshot) : undefined,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment derives from the snapshot it was handed; a runtime usage
      // update that landed since must not be reverted by it.
      const merged = withUsageLimits(nextSnapshot, state.snapshot.usageLimits);
      if (Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* Ref.get(snapshotStateRef);
      const nextGeneration = state.enrichmentGeneration + 1;
      yield* Ref.set(snapshotStateRef, {
        ...state,
        enrichmentGeneration: nextGeneration,
      });
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const probedSnapshot = yield* input.checkProvider;
    const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
      snapshotStateRef,
      (state) => {
        const generation = input.enrichSnapshot
          ? state.enrichmentGeneration + 1
          : state.enrichmentGeneration;
        // The last account seen signed in, so a sign-out between two accounts
        // still counts as a switch.
        const probedEmail =
          probedSnapshot.auth.status === "authenticated" ? loginEmail(probedSnapshot) : undefined;
        const switched =
          probedEmail !== undefined &&
          state.accountEmail !== undefined &&
          probedEmail !== state.accountEmail;
        // A different signed-in account stamps this probe's read; the same
        // account keeps the earlier stamp, also after a sign-out in between.
        const accountChangedAt = switched
          ? (probedSnapshot.usageLimits?.checkedAt ?? probedSnapshot.checkedAt)
          : state.accountChangedAt;
        const snapshot = withUsageLimits(
          probedSnapshot,
          withAccountChange(
            switched || loginChanged(state.snapshot, probedSnapshot)
              ? probedSnapshot.usageLimits
              : resolveUsageLimitsAfterProbe({
                  driver: probedSnapshot.driver,
                  published: state.snapshot.usageLimits,
                  probed: probedSnapshot.usageLimits,
                }),
            switched || (probedEmail !== undefined && probedEmail === state.accountEmail)
              ? accountChangedAt
              : undefined,
          ),
        );
        return [
          { snapshot, generation },
          {
            snapshot,
            enrichmentGeneration: generation,
            accountEmail: probedEmail ?? state.accountEmail,
            accountChangedAt,
          },
        ] as const;
      },
    );
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  /**
   * Runtime usage updates arrive between probes. They patch only
   * `usageLimits` on whatever snapshot is published and leave the enrichment
   * generation alone, so an in-flight enrichment still lands.
   */
  const applyUsageLimits: ServerProviderShape["applyUsageLimits"] = (update) =>
    Effect.gen(function* () {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = applyUsageLimitsUpdate({
          previous: state.snapshot.usageLimits,
          update,
          checkedAt: update.checkedAt,
        });
        // `applyUsageLimitsUpdate` hands back the same object when nothing
        // moved, which is the common case for Codex's per-tick notification.
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* serverSettings.subscribeChanges;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((refreshInterval) =>
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races the interval against a settings-change signal, not a timeout
        Effect.raceFirst(
          Effect.sleep(
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) <= 0
              ? "60 seconds"
              : refreshInterval,
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            input.refreshOnInterval !== false &&
            intervalElapsed &&
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? hasProviderStatusDemand.pipe(
                  Effect.flatMap((shouldRefresh) =>
                    shouldRefresh ? refreshSnapshot().pipe(Effect.asVoid) : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
