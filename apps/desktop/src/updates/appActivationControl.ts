import type { DesktopUpdateState } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
}

// The version the gate decides for: the download on disk, else the one being fetched.
const activationTarget = (state: DesktopUpdateState) =>
  state.downloadedVersion ?? state.availableVersion;

export function makeAppActivationControl(deps: AppActivationControlDeps) {
  let probe: LocalServiceProbe | null = null;
  // A restage (a second, cached download) runs only once per opened gate.
  let lastGate: "open" | "closed" | null = null;

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
    if (!checked) return;
    const state = yield* deps.getState;
    if (state.status === "available") {
      // A newer release appeared: the normal download stages it with the flag set.
      yield* deps.startAutomaticDownload;
      return;
    }
    if (state.status !== "downloaded" || state.downloadedVersion === null) return;
    if (!(yield* deps.tryStartDownload)) return;
    yield* Effect.gen(function* () {
      yield* logInfo("staging downloaded update for install on quit", {
        version: state.downloadedVersion,
      });
      const finished = yield* deps.downloadUpdate.pipe(
        Effect.timeoutOption(deps.downloadStallLimit),
      );
      if (Option.isNone(finished)) {
        yield* logWarning("Staging the downloaded update stopped responding.");
      }
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: (error) =>
          logError(error.message, { errorTag: error._tag, channel: error.channel }),
      }),
      Effect.ensuring(deps.finishDownload),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : logWarning("Could not stage the downloaded update."),
    ),
    Effect.withSpan("desktop.updates.restageDownloadedUpdate"),
  );

  // The app installs a downloaded update when it quits, once the local service
  // runs that release; the user can also restart into it from Settings then.
  const applyActivation: Effect.Effect<void> = Effect.gen(function* () {
    if (!(yield* deps.updaterConfigured)) return;
    const before = yield* deps.getState;
    const swapGate = yield* readActivation(activationTarget(before));
    const installOnQuit = installOnQuitAllowed(yield* deps.installAutomatically, swapGate);
    yield* deps.setAutoInstallOnAppQuit(installOnQuit);
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
    if (opened && installOnQuit && after.status === "downloaded") {
      const scope = yield* deps.backgroundScope;
      if (Option.isSome(scope)) {
        yield* restageDownloadedUpdate.pipe(Effect.forkIn(scope.value));
      }
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

  return { applyActivation, refusesInstall, registerProbe };
}
