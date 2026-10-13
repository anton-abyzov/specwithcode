import {
  DesktopUpdatePreferencesPatchSchema,
  DesktopUpdatePreferencesSchema,
  StudioServiceUpdateStateSchema,
  type StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FS from "node:fs";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../../app/DesktopObservability.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import {
  type AgentStartFailure,
  cancelServiceInstallChange,
  effectiveUpdatePreferences,
  makeServiceUpdateController,
  NO_AUTOMATIC_UPDATES,
  parseServiceInstallOptions,
  refreshThenRunAgent,
  selectAgentScriptPath,
  type ServiceAgentConfigChange,
  serviceInstallRequestRecord,
  type ServiceUpdateController,
  withAgentStartFailure,
} from "../../updates/studioServiceUpdates.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("service-updates");

const AGENT_START_DELAY = Duration.seconds(20);
const STATE_POLL_INTERVAL = Duration.seconds(20);
const AGENT_START_FAILED = "The update agent did not start. Try again in a moment.";
const REQUEST_NOT_WRITTEN = "The update request could not be saved. Try again in a moment.";

/** The cancel was not saved, so the agent still holds the install request. */
export class ServiceUpdateCancelError extends Schema.TaggedError<ServiceUpdateCancelError>()(
  "ServiceUpdateCancelError",
  {},
) {
  override get message(): string {
    return "The update could not be cancelled. Try again in a moment.";
  }
}

const controllerFor = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): ServiceUpdateController =>
  makeServiceUpdateController({
    homeDirectory: environment.homeDirectory,
    platform: environment.platform,
    agentScriptPath: () => {
      const candidates = [
        ...environment.resolveResourcePathCandidates("studio-updater/update_agent.py"),
        environment.path.join(environment.rootDir, "scripts", "studio-fleet", "update_agent.py"),
      ];
      return selectAgentScriptPath(candidates, (candidate) => FS.existsSync(candidate));
    },
  });

// Self-update follows the same build switch as the app's own updates
// (STUDIO_DISABLE_AUTO_UPDATE). While it is off the agent never acts on its
// own; "Check now" and "Install now" in Settings still run it on request.
const automaticUpdatesAllowed = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  return !config.disableAutoUpdate;
}).pipe(Effect.orElseSucceed(() => false));

/**
 * Writes the current preferences, plus one request's changes, where the
 * service's update agent reads them. Succeeds with whether the file was written.
 */
const writeServiceAgentConfig = Effect.fn("desktop.serviceUpdates.writeConfig")(function* (
  extra: ServiceAgentConfigChange = {},
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
  const allowed = yield* automaticUpdatesAllowed;
  const controller = controllerFor(environment);
  return yield* Effect.try(() =>
    controller.writeConfig({
      preferences: allowed ? settings.updatePreferences : NO_AUTOMATIC_UPDATES,
      channel: settings.updateChannel,
      ...extra,
    }),
  ).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      logWarning("could not write the service update preferences", {
        error: String(error),
      }).pipe(Effect.as(false)),
    ),
  );
});

/** Writes the current preferences where the service's update agent reads them. */
export const syncServiceAgentConfig = Effect.fn("desktop.serviceUpdates.syncConfig")(function* (
  extra: ServiceAgentConfigChange = {},
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  yield* writeServiceAgentConfig(extra);
  return controllerFor(environment);
});

export const installServiceUpdates = Effect.fn("desktop.ipc.installServiceUpdates")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const controller = controllerFor(environment);
  const syncConfig = (extra?: ServiceAgentConfigChange) =>
    writeServiceAgentConfig(extra).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopAppSettings.DesktopAppSettings, desktopSettings),
    );

  // A request whose agent could not be started shows as an error in the state
  // the renderer polls, until the agent writes a newer state of its own.
  let agentFailure: AgentStartFailure | null = null;
  const readState = () => withAgentStartFailure(controller.readState(), agentFailure);

  let lastSent = "";
  const publish = Effect.gen(function* () {
    const state = readState();
    const encoded = JSON.stringify(state);
    if (encoded === lastSent) return state;
    lastSent = encoded;
    yield* electronWindow.sendAll(IpcChannels.SERVICE_UPDATE_STATE_CHANNEL, state);
    return state;
  });

  const runAgent = (reason: string, options: { readonly reportFailure?: boolean } = {}) =>
    Effect.gen(function* () {
      // A failed refresh leaves the installed job in place, which can still run.
      yield* Effect.tryPromise(() => controller.ensureAgent()).pipe(
        Effect.catch((error) =>
          logWarning("service update agent was not refreshed", { reason, error: String(error) }),
        ),
      );
      yield* Effect.tryPromise(() => controller.runAgentNow());
      yield* logInfo("service update agent asked to run", { reason });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* logWarning("service update agent did not run", { reason, error: String(error) });
          if (!options.reportFailure) return;
          agentFailure = {
            at: DateTime.formatIso(yield* DateTime.now),
            message: AGENT_START_FAILED,
          };
          yield* publish;
        }),
      ),
      // A span puts the outcome, including a failed refresh, in desktop.trace.ndjson.
      Effect.withSpan("desktop.serviceUpdates.runAgent", { attributes: { reason } }),
    );

  // One agent refresh at a time: two installs of the launchd job must not race.
  // Requests made meanwhile coalesce into one more run after it; the agent
  // reads the newest config when it runs.
  let agentRunning = false;
  let agentAgain: { reason: string; reportFailure: boolean } | null = null;
  const startAgent = (reason: string, reportFailure: boolean) =>
    Effect.suspend(() => {
      if (agentRunning) {
        agentAgain = {
          reason,
          reportFailure: reportFailure || (agentAgain?.reportFailure ?? false),
        };
        return Effect.void;
      }
      agentRunning = true;
      return Effect.gen(function* () {
        let next: { reason: string; reportFailure: boolean } | null = { reason, reportFailure };
        while (next !== null) {
          agentAgain = null;
          yield* runAgent(next.reason, { reportFailure: next.reportFailure });
          next = agentAgain;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            agentRunning = false;
          }),
        ),
      );
    });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.UPDATE_GET_PREFERENCES_CHANNEL,
      payload: Schema.Void,
      result: DesktopUpdatePreferencesSchema,
      handler: () =>
        Effect.gen(function* () {
          const settings = yield* desktopSettings.get;
          return effectiveUpdatePreferences(
            settings.updatePreferences,
            yield* automaticUpdatesAllowed,
          );
        }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.UPDATE_SET_PREFERENCES_CHANNEL,
      payload: DesktopUpdatePreferencesPatchSchema,
      result: DesktopUpdatePreferencesSchema,
      handler: Effect.fn("desktop.ipc.updates.setPreferences")(function* (patch) {
        const allowed = yield* automaticUpdatesAllowed;
        // A build with self-update off has nothing to switch on; saving would
        // show switches that the service never sees.
        if (!allowed) {
          const settings = yield* desktopSettings.get;
          return effectiveUpdatePreferences(settings.updatePreferences, false);
        }
        const change = yield* desktopSettings.setUpdatePreferences(patch);
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.applyPreferences;
        yield* syncConfig();
        if (patch.checkAutomatically === true && controller.installation() !== null) {
          yield* startAgent("checks turned on", false).pipe(Effect.forkDetach);
        }
        return effectiveUpdatePreferences(change.settings.updatePreferences, true);
      }),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: StudioServiceUpdateStateSchema,
      handler: () => Effect.sync(readState),
    }),
  );

  // The reply carries the state as it is now; the agent's answer follows in
  // later reads. Refreshing the agent can take up to a minute, so it runs in
  // the background instead of holding the renderer's request. An install
  // first installs the bundled agent (waiting a bounded time) and kicks it,
  // which takes moments: an app restart straight after the reply (app and
  // service updated together) would end the background run before it kicks
  // the agent.
  const request = (kind: "check" | "install", raw?: unknown) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const at = DateTime.formatIso(now);
      const install = parseServiceInstallOptions(raw, DateTime.toEpochMillis(now));
      const written = yield* syncConfig(
        kind === "check"
          ? { checkRequestedAt: at }
          : {
              installRequestedAt: at,
              installMode: install.mode,
              installHoldUntil: install.mode === "force" ? install.holdUntil : null,
              // The version the user was shown: the agent installs no other, and not after 10 minutes.
              installRequest: serviceInstallRequestRecord(at, install.version, readState()),
            },
      );
      agentFailure = written ? null : { at, message: REQUEST_NOT_WRITTEN };
      if (written) {
        const reason =
          kind === "check"
            ? "check requested"
            : install.mode === "force"
              ? "forced install requested"
              : "install requested";
        if (kind === "install") {
          // The bundled agent first: the kicked pass takes the agent lock, and a
          // refresh after it would leave the older agent to handle the request.
          // A failed kick is reported by the background run below.
          yield* refreshThenRunAgent(controller).pipe(
            Effect.tap((outcome) =>
              outcome === "refreshed"
                ? Effect.void
                : logWarning("service update agent kicked without a refresh", { reason, outcome }),
            ),
            Effect.ignore,
          );
        }
        yield* startAgent(reason, kind === "install").pipe(Effect.forkDetach);
      }
      return yield* publish;
    });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_CHECK_CHANNEL,
      payload: Schema.Void,
      result: StudioServiceUpdateStateSchema,
      handler: (): Effect.Effect<StudioServiceUpdateState> => request("check"),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_INSTALL_CHANNEL,
      // Older renderers send nothing; unknown or malformed options are ignored.
      payload: Schema.Unknown,
      result: StudioServiceUpdateStateSchema,
      handler: (options): Effect.Effect<StudioServiceUpdateState> => request("install", options),
    }),
  );

  // Withdraws a pending install: the agent stops retrying and the hold ends.
  // Fails when the cancel could not be saved, so the renderer keeps the hold.
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_CANCEL_CHANNEL,
      payload: Schema.Void,
      result: StudioServiceUpdateStateSchema,
      handler: (): Effect.Effect<StudioServiceUpdateState, ServiceUpdateCancelError> =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          if (!(yield* syncConfig(cancelServiceInstallChange(at)))) {
            return yield* new ServiceUpdateCancelError();
          }
          agentFailure = null;
          yield* logInfo("service update install cancelled", {});
          return yield* publish;
        }),
    }),
  );

  // Install (or refresh) the agent once the app has settled, then keep the
  // renderer's copy of its state current. Reading one small file is cheap.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(AGENT_START_DELAY);
    if (controller.installation() === null) return;
    yield* syncConfig();
    const settings = yield* desktopSettings.get;
    if (settings.updatePreferences.checkAutomatically && (yield* automaticUpdatesAllowed)) {
      yield* startAgent("app start", false);
    } else if (controller.pendingForcedInstall(DateTime.toEpochMillis(yield* DateTime.now))) {
      // "Update now" was asked just before the app restarted; its agent run may have been cut short.
      yield* startAgent("pending forced install", true);
    }
  }).pipe(Effect.forkScoped);

  yield* publish.pipe(
    Effect.andThen(Effect.sleep(STATE_POLL_INTERVAL)),
    Effect.forever,
    Effect.ignoreCause,
    Effect.forkScoped,
  );
});
