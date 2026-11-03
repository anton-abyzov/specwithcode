import type {
  DesktopUpdatePreferences,
  DesktopUpdateState,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const IDLE_RESTART_SECONDS = 5 * 60;
export const IDLE_RETRY_MS = 10 * 60_000;

type Prepare = (
  input: ServerPrepareServiceUpdateInput,
) => Effect.Effect<ServerPrepareServiceUpdateResult | null>;
export interface IdleUpdateSession {
  readonly prepare: Prepare;
  /** Still the same local service and supported backend set, after staging. */
  readonly current: Effect.Effect<boolean>;
}
export interface IdleAppUpdateDeps {
  readonly preferences: Effect.Effect<DesktopUpdatePreferences>;
  readonly state: Effect.Effect<DesktopUpdateState>;
  readonly idleSeconds: Effect.Effect<number>;
  readonly session: Effect.Effect<IdleUpdateSession | null>;
  readonly install: (
    version: string,
    beforeQuit: Effect.Effect<boolean>,
    afterFailure: Effect.Effect<void>,
  ) => Effect.Effect<{
    readonly accepted: boolean;
    readonly failed?: boolean;
  }>;
}

/** One main-process owner, independent of renderer windows and their timers. */
export function makeIdleAppUpdate(deps: IdleAppUpdateDeps) {
  let running = false;
  let retryAt = 0;
  const eligible = Effect.gen(function* () {
    const preferences = yield* deps.preferences;
    if (
      !preferences.checkAutomatically ||
      !preferences.installAutomatically ||
      preferences.restartWhenIdle === false ||
      preferences.automaticUpdatesAllowed === false
    )
      return null;
    const idle = yield* deps.idleSeconds;
    if (!Number.isFinite(idle) || idle < IDLE_RESTART_SECONDS) return null;
    const state = yield* deps.state;
    if (
      state.status !== "downloaded" ||
      state.downloadedVersion === null ||
      state.swapGate?.gate === "closed"
    )
      return null;
    return state.downloadedVersion;
  });
  const tick = Effect.gen(function* () {
    if (running || (yield* Clock.currentTimeMillis) < retryAt) return;
    running = true;
    yield* Effect.gen(function* () {
      const version = yield* eligible;
      if (version === null) return;
      const session = yield* deps.session;
      if (session === null) return;
      let token: string | null = null;
      let accepted = false;
      const release = Effect.gen(function* () {
        if (token === null) return;
        const owned = token;
        token = null;
        yield* session.prepare({
          stopWork: false,
          releaseHold: true,
          holdToken: owned,
          reason: "app-restart",
        });
      });
      const beforeQuit = Effect.gen(function* () {
        if ((yield* eligible) !== version || !(yield* session.current)) return false;
        const held = yield* session.prepare({
          stopWork: false,
          hold: true,
          ifIdle: true,
          reason: "app-restart",
        });
        if (held === null || held.held !== true || !held.holdToken) return false;
        token = held.holdToken;
        if (!held.idle || held.blockers.length > 0) return false;
        // Never interpret another caller's hold, or an older service's held flag, as ours.
        const confirmed = yield* session.prepare({
          stopWork: false,
          hold: true,
          ifIdle: true,
          holdToken: token,
          reason: "app-restart",
        });
        return (
          confirmed !== null &&
          confirmed.idle &&
          confirmed.held === true &&
          confirmed.holdToken === token &&
          confirmed.blockers.length === 0 &&
          (yield* eligible) === version &&
          (yield* session.current)
        );
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));
      yield* Effect.gen(function* () {
        const answer = yield* deps.install(version, beforeQuit, release);
        accepted = answer.accepted && answer.failed !== true;
        // No rapid restart loops after a failed installer or lost admission.
        retryAt = (yield* Clock.currentTimeMillis) + IDLE_RETRY_MS;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!accepted) yield* release;
          }),
        ),
      );
    }).pipe(
      Effect.catchCause(() =>
        Effect.gen(function* () {
          retryAt = (yield* Clock.currentTimeMillis) + IDLE_RETRY_MS;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          running = false;
        }),
      ),
    );
  });
  return { tick };
}
