import type { DesktopUpdateState } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import type { ElectronUpdaterDownloadUpdateError } from "../electron/ElectronUpdater.ts";
import {
  describeAppActivation,
  evaluateAppActivation,
  installOnQuitAllowed,
  LocalServiceProbeError,
  type LocalServiceSnapshot,
  sameActivation,
} from "./appActivationGate.ts";

/**
 * Applies the app swap gate (appActivationGate.ts) to the updater: the
 * install-on-quit flag follows the gate for the version on disk or being
 * fetched, a restart into a release the local service does not run is
 * refused, and a download made while the gate was closed is staged again
 * once it opens. Kept apart from DesktopUpdates.ts, which only wires it.
 */

const { logInfo, logWarning, logError } =
  DesktopObservability.makeComponentLogger("desktop-updater");

const LOCAL_SERVICE_PROBE_TIMEOUT = Duration.seconds(5);

export type LocalServiceProbe = Effect.Effect<LocalServiceSnapshot | null, LocalServiceProbeError>;

export interface AppActivationControlDeps {
  readonly updaterConfigured: Effect.Effect<boolean>;
  readonly getState: Effect.Effect<DesktopUpdateState>;
  readonly updateState: (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ) => Effect.Effect<DesktopUpdateState>;
  /** The saved "install automatically" preference. */
  readonly installAutomatically: Effect.Effect<boolean>;
  /** True while an install stages the download: install-on-quit stays on. */
  readonly holdInstallOnQuit: Effect.Effect<boolean>;
  readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
  readonly backgroundScope: Effect.Effect<Option.Option<Scope.Scope>>;
  readonly checkForUpdates: (reason: string) => Effect.Effect<boolean>;
  readonly startAutomaticDownload: Effect.Effect<void>;
  /** Takes the updater for a download; false when another action holds it. */
  readonly tryStartDownload: Effect.Effect<boolean>;
  readonly finishDownload: Effect.Effect<void>;
  /** Sets the differential-download flag for this host, then downloads. */
  readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
  readonly downloadStallLimit: Duration.Duration;
  /** True once Squirrel.Mac staged the latest download; always true off macOS. */
  readonly installReady: Effect.Effect<boolean>;
}

// "busy": another action held the updater, so a later pass tries again.
type RestageOutcome = "handed" | "not-handed" | "busy";

// The version the gate decides for: the download on disk, else the one being fetched.
const activationTarget = (state: DesktopUpdateState) =>
  state.downloadedVersion ?? state.availableVersion;

export function makeAppActivationControl(deps: AppActivationControlDeps) {
  let probe: LocalServiceProbe | null = null;
  // A restage (a second, cached download) runs once per opened gate. It is
  // owed from the opening until it runs: a pass that finds the updater
  // checking or held by another action leaves it to the next pass (the
  // 20-second activation poll) instead of dropping it.
  let lastGate: "open" | "closed" | null = null;
  let restageOwed = false;
  // Set in the tick that forks a restage, so an install made in that same
  // tick (the update run's follow-up) waits for it instead of racing it.
  // Holds whether the restage handed the download to Squirrel.
  let restaging: Deferred.Deferred<boolean> | null = null;
  // The app release a live Update now run installs once its service is
  // verified (stageForRun). Its download is staged as soon as the gate opens,
  // whatever the install preference, so the run's install does not stage it
  // after the service is verified.
  let runInstalls: string | null = null;

  const readActivation = (targetVersion: string | null, serviceLacksRelease = false) =>
    Effect.gen(function* () {
      if (probe === null) return evaluateAppActivation({ targetVersion, snapshot: null });
      const read = yield* probe.pipe(
        Effect.timeoutOption(LOCAL_SERVICE_PROBE_TIMEOUT),
        Effect.map(
          Option.match({
            onNone: () => new LocalServiceProbeError({ detail: "reading it timed out" }),
            onSome: (snapshot): LocalServiceSnapshot | LocalServiceProbeError | null => snapshot,
          }),
        ),
        Effect.catch((error) => Effect.succeed(error)),
      );
      return evaluateAppActivation({ targetVersion, snapshot: read, serviceLacksRelease });
    });

  // Squirrel.Mac stages an update only when electron-updater's download
  // finishes with install-on-quit set. A download made while the gate was
  // closed is therefore fetched again (electron-updater serves it from its
  // cache) after a fresh check, even though the state already says
  // "downloaded"; the regular download path skips that state.
  const restageDownloadedUpdate = Effect.gen(function* () {
    const checked = yield* deps.checkForUpdates("service caught up");
    if (!checked) return "busy" as const;
    const state = yield* deps.getState;
    if (state.status === "available") {
      // A newer release appeared: the normal download stages it with the flag set.
      yield* deps.startAutomaticDownload;
      return "not-handed" as const;
    }
    if (state.status !== "downloaded" || state.downloadedVersion === null) {
      return "not-handed" as const;
    }
    if (!(yield* deps.tryStartDownload)) return "busy" as const;
    return yield* Effect.gen(function* () {
      yield* logInfo("staging downloaded update for install on quit", {
        version: state.downloadedVersion,
      });
      const finished = yield* deps.downloadUpdate.pipe(
        Effect.timeoutOption(deps.downloadStallLimit),
      );
      if (Option.isNone(finished)) {
        yield* logWarning("Staging the downloaded update stopped responding.");
        return "not-handed" as const;
      }
      return "handed" as const;
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: (error) =>
          logError(error.message, { errorTag: error._tag, channel: error.channel }).pipe(
            Effect.as("not-handed" as const),
          ),
      }),
      Effect.ensuring(deps.finishDownload),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : logWarning("Could not stage the downloaded update.").pipe(
            Effect.as<RestageOutcome>("not-handed"),
          ),
    ),
    Effect.withSpan("desktop.updates.restageDownloadedUpdate"),
  );

  // The app installs a downloaded update when it quits, once the local service
  // runs that release; the user can also restart into it from Settings then.
  const applyActivation: Effect.Effect<void> = Effect.gen(function* () {
    if (!(yield* deps.updaterConfigured)) return;
    const before = yield* deps.getState;
    const target = activationTarget(before);
    const swapGate = yield* readActivation(target);
    // A run installs this very release within seconds: stage it now, on an open gate.
    const forRun = runInstalls !== null && runInstalls === target && swapGate.gate === "open";
    const installOnQuit =
      installOnQuitAllowed(yield* deps.installAutomatically, swapGate) || forRun;
    yield* deps.setAutoInstallOnAppQuit(installOnQuit || (yield* deps.holdInstallOnQuit));
    const after = yield* deps.getState;
    if (!sameActivation(after.swapGate, swapGate)) {
      yield* deps.updateState((current) => ({ ...current, swapGate }));
    }
    const opened = lastGate === "closed" && swapGate.gate === "open";
    if (lastGate !== swapGate.gate) {
      yield* logInfo("app swap gate", {
        gate: swapGate.gate,
        reason: swapGate.reason,
        targetVersion: swapGate.targetVersion,
        serviceVersion: swapGate.serviceVersion,
      });
    }
    lastGate = swapGate.gate;
    restageOwed = swapGate.gate === "open" && (opened || restageOwed);
    if (restageOwed && installOnQuit && after.status === "downloaded" && restaging === null) {
      const scope = yield* deps.backgroundScope;
      if (Option.isNone(scope)) return;
      restageOwed = false;
      // Downloaded with the gate open, Squirrel already holds it.
      if (yield* deps.installReady) return;
      const done = yield* Deferred.make<boolean>();
      restaging = done;
      yield* restageDownloadedUpdate.pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            if (restaging === done) restaging = null;
            const outcome = Exit.isSuccess(exit) ? exit.value : "not-handed";
            if (outcome === "busy") restageOwed = true;
            return Deferred.succeed(done, outcome === "handed");
          }),
        ),
        Effect.forkIn(scope.value),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : logWarning("Could not apply the app swap gate."),
    ),
    Effect.withSpan("desktop.updates.applyActivation"),
  );

  /**
   * The local service updates first: a restart into a release it does not run
   * yet is refused (true), and the state says why. A press made because the
   * agent lacks the release may go ahead of the service (`serviceLacksRelease`).
   */
  const refusesInstall = (expectedVersion: string | undefined, serviceLacksRelease = false) =>
    Effect.gen(function* () {
      const requested = expectedVersion ?? (yield* deps.getState).downloadedVersion;
      const swapGate = yield* readActivation(requested, serviceLacksRelease);
      if (swapGate.gate === "open") {
        if (swapGate.reason === "service-lacks-release") {
          yield* logInfo("app installs ahead of a service whose agent lacks the release", {
            targetVersion: swapGate.targetVersion,
            serviceVersion: swapGate.serviceVersion,
          });
        }
        return false;
      }
      yield* deps.updateState((current) => ({ ...current, swapGate }));
      yield* logWarning("app install waits for the local service", {
        message: describeAppActivation(swapGate),
      });
      return true;
    });

  const registerProbe = (next: LocalServiceProbe) =>
    Effect.sync(() => {
      probe = next;
    }).pipe(Effect.andThen(applyActivation));

  /**
   * Waits up to `limit` for a restage forked by the gate opening; true when
   * it handed the download to Squirrel, which may still be unpacking it.
   */
  const awaitRestage = (limit: Duration.Duration) =>
    Effect.suspend(() =>
      restaging === null
        ? Effect.succeed(false)
        : Deferred.await(restaging).pipe(
            Effect.timeoutOption(limit),
            Effect.map(Option.getOrElse(() => false)),
          ),
    );

  /**
   * Called on every look at a live run (2 seconds) with the app release it
   * installs next, so the gate is read as soon as the service moves rather
   * than at the 20-second poll; null once no run does, and install-on-quit
   * goes back to what the preference allows.
   */
  const stageForRun = (version: string | null) =>
    Effect.suspend(() => {
      const changed = runInstalls !== version;
      runInstalls = version;
      return version !== null || changed ? applyActivation : Effect.void;
    });

  return { applyActivation, awaitRestage, refusesInstall, registerProbe, stageForRun };
}
