import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
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

export interface PlatformReady {
  readonly await: Effect.Effect<void>;
  /** The window's own machine, from the latest report that included it. */
  readonly primary: Effect.Effect<EnvironmentId | undefined>;
  readonly reconciled: (
    registrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) => Effect.Effect<void>;
  readonly ended: Effect.Effect<void>;
}

/**
 * Open once the platform has reported, or once its source has ended (a hosted
 * page, mobile, or a desktop with its local environment off). The web source
 * reports only after its descriptor read returns, and that read has its own
 * timeout, so a report without the primary is a definite failure, not a slow
 * answer: cleanup then runs, and `primary` stays unknown, so callers fall back
 * to the own machine recorded by an earlier start. Silence means slow: wait.
 */
export const makePlatformReady = Effect.fn("EnvironmentRegistry.makePlatformReady")(function* (
  required: boolean,
): Effect.fn.Return<PlatformReady> {
  const ready = yield* Deferred.make<void>();
  if (!required) yield* Deferred.succeed(ready, undefined);
  const open = Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
  // The window's own machine, from the latest report that included it.
  const primary = yield* Ref.make<EnvironmentId | undefined>(undefined);
  return {
    await: Deferred.await(ready),
    primary: Ref.get(primary),
    reconciled: (registrations: ReadonlyArray<PlatformConnectionRegistration>) => {
      const reported = registrations.find(
        (registration) => registration._tag === "PrimaryConnectionRegistration",
      );
      return (
        reported === undefined ? Effect.void : Ref.set(primary, reported.target.environmentId)
      ).pipe(Effect.andThen(open));
    },
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
