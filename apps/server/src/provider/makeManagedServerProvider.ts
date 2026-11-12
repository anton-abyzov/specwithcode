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
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_STATUS_CHECK_FAILED } from "./providerSnapshot.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";
import type { ServerProviderShape } from "./ServerProvider.ts";
import {
  identitiesDiffer,
  nextIdentity,
  signedInIdentity,
  type SubscriptionIdentity,
  type SubscriptionMemory,
} from "./subscriptionIdentity.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  /** The subscription the last signed-in probe reported (see `subscriptionIdentity.ts`). */
  readonly accountIdentity?: SubscriptionIdentity | undefined;
  /**
   * When that subscription replaced a different one. Kept here, not only on
   * the published usage, so a sign-out (whose read carries no mark) followed
   * by signing in to the same subscription still publishes it.
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

/**
 * True when the probe is signed in to another subscription than the one the
 * published usage belongs to. Usage, denials and credits describe one
 * subscription, so none of it carries over to the next.
 */
function loginChanged(published: ServerProvider, probed: ServerProvider): boolean {
  const before = signedInIdentity(published);
  const after = signedInIdentity(probed);
  return before !== undefined && after !== undefined && identitiesDiffer(before, after);
}

/**
 * A check that failed to read the sign-in keeps the last answer that did, for
 * the row to show instead of "Not reported". `auth` itself stays "unknown":
 * what may run is decided by what was read, never by what was remembered.
 *
 * Only a failed check remembers. An agent that answers and reports no sign-in
 * ("unknown" is the normal state of several agents, and of one signed out) has
 * said what there is to know. `forget` drops the memory when the settings the
 * check runs with changed: another home or command is another account.
 */
export function withLastKnownAuth(
  published: ServerProvider,
  probed: ServerProvider,
  forget = false,
): ServerProvider {
  const { lastKnownAuth: _reported, ...rest } = probed;
  const checkFailed = probed.status === "error" || probed.auth.type === CLAUDE_STATUS_CHECK_FAILED;
  if (forget || !probed.enabled || !probed.installed) return rest;
  if (probed.auth.status !== "unknown" || !checkFailed) return rest;
  const lastKnownAuth =
    published.auth.status === "unknown" ? published.lastKnownAuth : published.auth;
  return lastKnownAuth ? { ...rest, lastKnownAuth } : rest;
}

/** How often a row that is not signed in is asked about again while it is on screen. */
const SIGN_IN_PROBE_INTERVAL: Duration.Input = "5 seconds";
/** How long one such question may take before it counts as no answer. */
const SIGN_IN_MARK_LIMIT: Duration.Input = "12 seconds";

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
  /** Keeps the signed-in subscription across restarts, so a change during one is noticed. */
  readonly subscriptionMemory?: SubscriptionMemory;
  /**
   * A cheap question asked every few seconds while this agent's row is on
   * screen and not signed in, so a sign-in done in a terminal shows without a
   * manual refresh. `mark` is any text that changes when the sign-in may have
   * changed (undefined: no answer this time). A changed mark runs the full
   * check; so does the first mark after the row appears. `beforeCheck` drops
   * whatever the full check would otherwise answer from memory.
   */
  readonly signInProbe?: {
    readonly mark: Effect.Effect<string | undefined>;
    readonly beforeCheck?: Effect.Effect<void>;
    readonly interval?: Duration.Input;
  };
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
  const remembered = input.subscriptionMemory ? yield* input.subscriptionMemory.load : undefined;
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
    accountIdentity: remembered?.identity ?? signedInIdentity(initialSnapshot),
    accountChangedAt: remembered?.changedAt,
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
    const settingsChanged = input.haveSettingsChanged(previousSettings, nextSettings);
    if (!forceRefresh && !settingsChanged) {
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
    const {
      snapshot: nextSnapshot,
      generation: nextGeneration,
      remember,
    } = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      // The last subscription seen signed in, so a sign-out or an unreadable
      // read between two subscriptions still counts as a switch.
      const probedIdentity = signedInIdentity(probedSnapshot);
      const switched =
        probedIdentity !== undefined &&
        state.accountIdentity !== undefined &&
        identitiesDiffer(probedIdentity, state.accountIdentity);
      const sameAccount =
        probedIdentity !== undefined && state.accountIdentity !== undefined && !switched;
      // A different signed-in subscription stamps this probe's read; the
      // same one keeps the earlier stamp, also after a sign-out in between.
      const accountChangedAt = switched
        ? (probedSnapshot.usageLimits?.checkedAt ?? probedSnapshot.checkedAt)
        : state.accountChangedAt;
      const snapshot = withUsageLimits(
        withLastKnownAuth(state.snapshot, probedSnapshot, settingsChanged),
        withAccountChange(
          switched || loginChanged(state.snapshot, probedSnapshot)
            ? probedSnapshot.usageLimits
            : resolveUsageLimitsAfterProbe({
                driver: probedSnapshot.driver,
                published: state.snapshot.usageLimits,
                probed: probedSnapshot.usageLimits,
              }),
          switched || sameAccount ? accountChangedAt : undefined,
        ),
      );
      const accountIdentity = nextIdentity(state.accountIdentity, probedIdentity);
      const changed =
        accountChangedAt !== state.accountChangedAt ||
        JSON.stringify(accountIdentity) !== JSON.stringify(state.accountIdentity);
      return [
        {
          snapshot,
          generation,
          remember:
            changed && accountIdentity !== undefined
              ? { identity: accountIdentity, changedAt: accountChangedAt }
              : undefined,
        },
        {
          snapshot,
          enrichmentGeneration: generation,
          accountIdentity,
          accountChangedAt,
        },
      ] as const;
    });
    if (remember && input.subscriptionMemory) yield* input.subscriptionMemory.save(remember);
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
    // One failed check must not end the loop and drop later settings changes.
    Effect.asVoid(applySnapshot(nextSettings)).pipe(Effect.ignoreCause({ log: true })),
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

  const signInProbe = input.signInProbe;
  if (signInProbe) {
    // The mark the last full check here went with; null until the row is first
    // looked at. It is kept while nobody looks: a window that comes back to an
    // unchanged sign-in asks the cheap question again and nothing more.
    let checkedMark: string | null = null;
    yield* Effect.sleep(signInProbe.interval ?? SIGN_IN_PROBE_INTERVAL).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const { snapshot } = yield* Ref.get(snapshotStateRef);
          const watching =
            snapshot.enabled &&
            snapshot.installed &&
            snapshot.auth.status !== "authenticated" &&
            (yield* backgroundPolicy.shouldRunScopeWork({
              type: "provider-status",
              instanceId: snapshot.instanceId,
            }));
          if (!watching) return;
          // A question that hangs (a stalled disk, a command that never ends)
          // counts as no answer, and the next look asks again.
          const mark = yield* signInProbe.mark.pipe(
            Effect.timeoutOption(SIGN_IN_MARK_LIMIT),
            Effect.map(Option.getOrUndefined),
          );
          if (mark === undefined || mark === checkedMark) return;
          checkedMark = mark;
          if (signInProbe.beforeCheck) yield* signInProbe.beforeCheck;
          yield* refreshSnapshot();
        }),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forever,
      Effect.forkScoped,
    );
  }

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
