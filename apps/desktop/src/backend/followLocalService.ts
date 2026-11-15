import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AttachedLocalService } from "./DesktopLocalService.ts";

/** How often the attached service's address is checked. */
export const FOLLOW_LOCAL_SERVICE_INTERVAL = Duration.seconds(10);
/** Checks in a row without an answer before the service's home is read again. */
export const FOLLOW_LOCAL_SERVICE_MISSES = 3;

export interface FollowLocalServiceInput {
  readonly attached: Effect.Effect<Option.Option<AttachedLocalService>>;
  /** Whether a server answers its descriptor at this origin. */
  readonly answers: (origin: string) => Effect.Effect<boolean>;
  /** The same service at a new address, read from its own home. */
  readonly relocate: (
    service: AttachedLocalService,
  ) => Effect.Effect<Option.Option<AttachedLocalService>>;
  /** Points the app, and every open window, at the service's new address. */
  readonly reattach: (
    service: AttachedLocalService,
  ) => Effect.Effect<void, { readonly _tag: string }>;
}

/**
 * One check of the service the app attached to at startup. An installed
 * service that restarts (a fleet update hands off to a new server) can come
 * back on another port; the windows would otherwise keep calling the old one
 * for good, showing "busy" and refusing attachments. After
 * `FOLLOW_LOCAL_SERVICE_MISSES` checks in a row get no answer, the service's
 * home is read again and the same environment at a new address is attached.
 * Returns the misses so far; a failed reattach fails, so the next check tries again.
 */
export const checkAttachedLocalService = Effect.fn("desktop.localService.checkAttached")(function* (
  input: FollowLocalServiceInput,
  missed: number,
) {
  const attached = yield* input.attached;
  if (Option.isNone(attached)) return 0;
  if (yield* input.answers(attached.value.httpBaseUrl.href)) return 0;
  const misses = missed + 1;
  if (misses < FOLLOW_LOCAL_SERVICE_MISSES) return misses;
  const moved = yield* input.relocate(attached.value);
  if (Option.isNone(moved)) return misses;
  yield* input.reattach(moved.value);
  return 0;
});

/** Runs `checkAttachedLocalService` for as long as the app does. */
export const followLocalService = (input: FollowLocalServiceInput) =>
  Effect.gen(function* () {
    let missed = 0;
    while (true) {
      yield* Effect.sleep(FOLLOW_LOCAL_SERVICE_INTERVAL);
      // A failed check keeps its count, so a reattach that failed runs again.
      missed = yield* checkAttachedLocalService(input, missed).pipe(
        Effect.catchCause(() => Effect.succeed(Math.max(missed, FOLLOW_LOCAL_SERVICE_MISSES - 1))),
      );
    }
  });
