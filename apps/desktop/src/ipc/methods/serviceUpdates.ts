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
  effectiveUpdatePreferences,
  makeServiceUpdateController,
  NO_AUTOMATIC_UPDATES,
  selectAgentScriptPath,
  type ServiceUpdateController,
} from "../../updates/studioServiceUpdates.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("service-updates");

const AGENT_START_DELAY = Duration.seconds(20);
const STATE_POLL_INTERVAL = Duration.seconds(20);

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

/** Writes the current preferences where the service's update agent reads them. */
export const syncServiceAgentConfig = Effect.fn("desktop.serviceUpdates.syncConfig")(function* (
  extra: { readonly installRequestedAt?: string; readonly checkRequestedAt?: string } = {},
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
  const allowed = yield* automaticUpdatesAllowed;
  const controller = controllerFor(environment);
  yield* Effect.try(() =>
    controller.writeConfig({
      preferences: allowed ? settings.updatePreferences : NO_AUTOMATIC_UPDATES,
      channel: settings.updateChannel,
      ...extra,
    }),
  ).pipe(
    Effect.catch((error) =>
      logWarning("could not write the service update preferences", { error: String(error) }),
    ),
  );
  return controller;
});

export const installServiceUpdates = Effect.fn("desktop.ipc.installServiceUpdates")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const controller = controllerFor(environment);
  const syncConfig = (extra?: Parameters<typeof syncServiceAgentConfig>[0]) =>
    syncServiceAgentConfig(extra).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopAppSettings.DesktopAppSettings, desktopSettings),
    );

  let lastSent = "";
  const publish = Effect.gen(function* () {
    const state = controller.readState();
    const encoded = JSON.stringify(state);
    if (encoded === lastSent) return state;
    lastSent = encoded;
    yield* electronWindow.sendAll(IpcChannels.SERVICE_UPDATE_STATE_CHANNEL, state);
    return state;
  });

  const runAgent = (reason: string) =>
    Effect.tryPromise(() => controller.ensureAgent()).pipe(
      Effect.andThen(Effect.tryPromise(() => controller.runAgentNow())),
      Effect.tap(() => logInfo("service update agent asked to run", { reason })),
      Effect.catch((error) =>
        logWarning("service update agent did not run", { reason, error: String(error) }),
      ),
      // A span puts the outcome, including a failed refresh, in desktop.trace.ndjson.
      Effect.withSpan("desktop.serviceUpdates.runAgent", { attributes: { reason } }),
    );

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
          yield* runAgent("checks turned on").pipe(Effect.forkDetach);
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
      handler: () => Effect.sync(() => controller.readState()),
    }),
  );

  const request = (kind: "check" | "install") =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* syncConfig(kind === "check" ? { checkRequestedAt: now } : { installRequestedAt: now });
      yield* runAgent(kind === "check" ? "check requested" : "install requested");
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
      payload: Schema.Void,
      result: StudioServiceUpdateStateSchema,
      handler: (): Effect.Effect<StudioServiceUpdateState> => request("install"),
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
      yield* runAgent("app start");
    }
  }).pipe(Effect.forkScoped);

  yield* publish.pipe(
    Effect.andThen(Effect.sleep(STATE_POLL_INTERVAL)),
    Effect.forever,
    Effect.ignoreCause,
    Effect.forkScoped,
  );
});
