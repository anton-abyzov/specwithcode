import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { PlatformConnectionRegistration } from "./catalog.ts";

/**
 * Whether account cleanup waits for the window's own machine (1434, AC-04).
 * The connection layer turns it on: its platform source reports the local
 * server, and until that answers, a saved route that shares the local server's
 * environment id cannot be told from another machine. Off by default, for a
 * registry built without a platform source.
 */
export class AwaitPlatformPrimary extends Context.Reference<boolean>(
  "@specweave-studio/client-runtime/connection/platformReady/AwaitPlatformPrimary",
  { defaultValue: () => false },
) {}

/**
 * Open once the platform has reported the window's own machine, or once its
 * source has ended without one (a hosted page, mobile, or a desktop with its
 * local environment off). A report without the primary, such as a first
 * descriptor read that failed, keeps it closed.
 */
export const makePlatformReady = Effect.fn("EnvironmentRegistry.makePlatformReady")(function* (
  required: boolean,
) {
  const ready = yield* Deferred.make<void>();
  if (!required) yield* Deferred.succeed(ready, undefined);
  const open = Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
  return {
    await: Deferred.await(ready),
    reconciled: (registrations: ReadonlyArray<PlatformConnectionRegistration>) =>
      registrations.some((registration) => registration._tag === "PrimaryConnectionRegistration")
        ? open
        : Effect.void,
    ended: open,
  };
});

/** Feeds the platform source to the registry, and says when the source has ended. */
export function followPlatformSource(
  registrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>>,
  registry: {
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) => Effect.Effect<void>;
    readonly platformSourceEnded: Effect.Effect<void>;
  },
): Effect.Effect<void> {
  return registrations.pipe(
    Stream.runForEach(registry.reconcilePlatform),
    Effect.ensuring(registry.platformSourceEnded),
  );
}
