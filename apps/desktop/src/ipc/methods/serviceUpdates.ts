import {
  type DesktopUpdateState,
  DesktopUpdatePreferencesPatchSchema,
  DesktopUpdatePreferencesSchema,
  type StudioServiceUpdateState,
  StudioServiceUpdateStateSchema,
} from "@specweave-studio/contracts";
import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Read the native updater helper receipt with the existing synchronous IPC boundary.
import * as FS from "node:fs";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLocalService from "../../backend/DesktopLocalService.ts";
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
  repairServiceAgent,
  selectAgentScriptPath,
  ServiceAgentError,
  serviceAgentFailureMessage,
  type ServiceAgentConfigChange,
  serviceInstallRequestRecord,
  type ServiceUpdateController,
  withAgentStartFailure,
} from "../../updates/studioServiceUpdates.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

/** A release service older than this app (never a dev or nightly build). */
export function isStaleService(serviceVersion: string | undefined, appVersion: string): boolean {
  const service = serviceVersion === undefined ? null : parseSemver(serviceVersion);
  const app = parseSemver(appVersion);
  if (
    service === null ||
    app === null ||
    service.prerelease.length > 0 ||
    app.prerelease.length > 0
  )
    return false;
  return compareSemverVersions(serviceVersion!, appVersion) < 0;
}

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("service-updates");

/**
 * Whether the app, at start, should ask the agent to install its own version
 * on a service older than the app. Never over a pending request that would
 * install that version anyway, and never over a forced one: "Update now"
 * stopped and held the work for it, and replacing it with a normal request
 * would end the agent's forced retries and leave the install to its next
 * scheduled pass, up to 10 minutes later.
 */
export function shouldRequestAppVersion(input: {
  readonly allowed: boolean;
  readonly serviceVersion: string | undefined;
  readonly appVersion: string;
  readonly state: Pick<StudioServiceUpdateState, "status" | "pendingInstall">;
}): boolean {
  if (!input.allowed || !isStaleService(input.serviceVersion, input.appVersion)) return false;
  if (input.state.status === "installing" || input.state.status === "waiting-for-quiet") {
    return false;
  }
  const pending = input.state.pendingInstall ?? null;
  return (
    pending === null ||
    (pending.mode === "normal" && pending.version !== null && pending.version !== input.appVersion)
  );
}

/**
 * The agent checks the feed about once an hour. When the app finds a release
 * the service does not run yet, the agent is asked to check now, so it
 * downloads the service's half in the background too and one "Update now"
 * installs both. Returns the version to ask about, once per version.
 */
export function serviceCheckFor(input: {
  readonly appState: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">;
  readonly service: Pick<
    StudioServiceUpdateState,
    "status" | "installedVersion" | "availableVersion" | "downloadedVersion"
  >;
  readonly asked: ReadonlySet<string>;
}): string | null {
  const version = input.appState.downloadedVersion ?? input.appState.availableVersion;
  if (version === null || input.asked.has(version)) return null;
  const { service } = input;
  if (
    service.status === "not-managed" ||
    service.status === "downloading" ||
    service.status === "installing"
  ) {
    return null;
  }
  const installed = service.installedVersion ?? undefined;
  if (!isStaleService(installed, version)) return null;
  // The agent already has it, or something newer.
  const known = service.downloadedVersion ?? service.availableVersion;
  if (known !== null && !isStaleService(known, version)) return null;
  return version;
}

/**
 * The agent run the app starts once it has settled, if any. Every one reports
 * a failure: a job launchd turned off, or one that cannot load, otherwise
 * leaves Settings showing a frozen "up to date" for hours.
 */
export function appStartAgentRun(input: {
  readonly checkAutomatically: boolean;
  readonly automaticUpdatesAllowed: boolean;
  readonly pendingForcedInstall: boolean;
}): { readonly reason: string; readonly reportFailure: true } | null {
  if (input.checkAutomatically && input.automaticUpdatesAllowed) {
    return { reason: "app start", reportFailure: true };
  }
  // "Update now" was asked just before the app restarted; its agent run may have been cut short.
  if (input.pendingForcedInstall) return { reason: "pending forced install", reportFailure: true };
  return null;
}

const AGENT_START_DELAY = Duration.seconds(20);
const STATE_POLL_INTERVAL = Duration.seconds(20);
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

export const controllerForAttachedService = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  service: DesktopLocalService.AttachedLocalService | null,
): ServiceUpdateController =>
  makeServiceUpdateController({
    homeDirectory: environment.homeDirectory,
    platform: environment.platform,
    // A fleet service started by launchd never says serviceManaged; its
    // installation receipt does.
    attachedStudioHome:
      service !== null && DesktopLocalService.isInstalledService(service) ? service.baseDir : null,
    agentScriptPath: () => {
      const candidates = [
        ...environment.resolveResourcePathCandidates("studio-updater/update_agent.py"),
        environment.path.join(environment.rootDir, "scripts", "studio-fleet", "update_agent.py"),
      ];
      return selectAgentScriptPath(candidates, (candidate) => FS.existsSync(candidate));
    },
  });

const controllerFor = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  Effect.gen(function* () {
    const service = yield* (yield* DesktopLocalService.DesktopLocalService).attached;
    return controllerForAttachedService(environment, Option.getOrNull(service));
  });

// Self-update follows the same build switch as the app's own updates
// (SPECWITHCODE_DISABLE_AUTO_UPDATE or STUDIO_DISABLE_AUTO_UPDATE). While it is off the agent never acts on its
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
  const controller = yield* controllerFor(environment);
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
  return yield* controllerFor(environment);
});

export const installServiceUpdates = Effect.fn("desktop.ipc.installServiceUpdates")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const syncConfig = (extra?: ServiceAgentConfigChange) =>
    writeServiceAgentConfig(extra).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopAppSettings.DesktopAppSettings, desktopSettings),
    );

  // A request whose agent could not be started shows as an error in the state
  // the renderer polls, until the agent writes a newer state of its own.
  let agentFailure: AgentStartFailure | null = null;
  const readState = Effect.gen(function* () {
    const controller = yield* controllerFor(environment);
    return withAgentStartFailure(controller.readState(), agentFailure);
  });

  let lastSent = "";
  const publish = Effect.gen(function* () {
    const state = yield* readState;
    const encoded = yield* Schema.encodeEffect(
      Schema.fromJsonString(StudioServiceUpdateStateSchema),
    )(state);
    if (encoded === lastSent) return state;
    lastSent = encoded;
    yield* electronWindow.sendAll(IpcChannels.SERVICE_UPDATE_STATE_CHANNEL, state);
    return state;
  });

  // Records a failed agent step where the renderer reads it, with launchctl's
  // or the helper's own reason.
  const reportAgentFailure = (reason: string, error: unknown) =>
    Effect.gen(function* () {
      agentFailure = {
        at: DateTime.formatIso(yield* DateTime.now),
        message: serviceAgentFailureMessage(error),
      };
      yield* logWarning("service update agent failure shown", {
        reason,
        error: agentFailure.message,
      });
      yield* publish;
    });

  const runAgent = (reason: string, options: { readonly reportFailure?: boolean } = {}) =>
    Effect.gen(function* () {
      // A failed refresh leaves the installed job in place, which can still run;
      // a label launchd has turned off cannot, so that fails unkicked. The
      // refresh is awaited in full here: nothing waits on this background run.
      const outcome = yield* refreshThenRunAgent(
        yield* controllerFor(environment),
        Duration.infinity,
      );
      if (outcome !== "refreshed") {
        yield* logWarning("service update agent kicked without a refresh", { reason, outcome });
      }
      yield* logInfo("service update agent asked to run", { reason });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* logWarning("service update agent did not run", {
            reason,
            error: serviceAgentFailureMessage(error),
          });
          if (!options.reportFailure) return;
          yield* reportAgentFailure(reason, error);
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
        yield* updates.applyPreferences;
        yield* syncConfig();
        if (
          patch.checkAutomatically === true &&
          (yield* controllerFor(environment)).installation() !== null
        ) {
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
      handler: () => readState,
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
      const state = yield* readState;
      const written = yield* syncConfig(
        kind === "check"
          ? { checkRequestedAt: at }
          : {
              installRequestedAt: at,
              installMode: install.mode,
              installHoldUntil: install.mode === "force" ? install.holdUntil : null,
              // The version the user was shown: the agent installs no other, and not after 10 minutes.
              installRequest: serviceInstallRequestRecord(at, install.version, state),
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
          // A failure is shown at once, in the state this reply carries.
          const outcome = yield* refreshThenRunAgent(yield* controllerFor(environment)).pipe(
            Effect.tap((outcome) =>
              outcome === "refreshed"
                ? Effect.void
                : logWarning("service update agent kicked without a refresh", { reason, outcome }),
            ),
            Effect.catch((error) => reportAgentFailure(reason, error).pipe(Effect.as(null))),
          );
          // Nothing would handle the request: running the agent again only repeats the failure.
          if (outcome === null) return yield* publish;
          // The refreshed agent is running the request: a second refresh and
          // kick would only find it busy. One that did not finish refreshing in
          // time completes in the background, so the next pass runs the new agent.
          if (outcome === "refreshed") return yield* publish;
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
      handler: () => request("check"),
    }),
  );

  // Settings' Repair, only on a person's click: launchctl enable, bootstrap and
  // kickstart of the agent's job. Nothing else ever turns a disabled label back
  // on: its owner may have turned it off on purpose.
  const repair = Effect.gen(function* () {
    const controller = yield* controllerFor(environment);
    const failure = yield* repairServiceAgent(controller);
    if (failure === null) {
      agentFailure = null;
      yield* logInfo("service update agent repaired", {});
    } else {
      yield* reportAgentFailure(
        "repair requested",
        new ServiceAgentError({ step: "repair", message: failure }),
      );
    }
    return yield* publish;
  });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_INSTALL_CHANNEL,
      // Older renderers send nothing; unknown or malformed options are ignored.
      payload: Schema.Unknown,
      result: StudioServiceUpdateStateSchema,
      handler: (options) => request("install", options),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_REPAIR_CHANNEL,
      payload: Schema.Void,
      result: StudioServiceUpdateStateSchema,
      handler: () => repair,
    }),
  );

  // Withdraws a pending install: the agent stops retrying and the hold ends.
  // Fails when the cancel could not be saved, so the renderer keeps the hold.
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SERVICE_UPDATE_CANCEL_CHANNEL,
      payload: Schema.Void,
      result: StudioServiceUpdateStateSchema,
      handler: () =>
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
    const controller = yield* controllerFor(environment);
    if (controller.installation() === null) return;
    yield* syncConfig();
    // The service outlives the app, so an app update leaves the older service
    // running. Ask its agent to install the app's version at its next quiet
    // moment (never mid-task), instead of showing a separate server update.
    const attached = Option.getOrNull(
      yield* (yield* DesktopLocalService.DesktopLocalService).attached,
    );
    const serviceVersion = DesktopLocalService.isInstalledService(attached)
      ? attached?.descriptor.serverVersion
      : undefined;
    const current = yield* readState;
    if (
      shouldRequestAppVersion({
        allowed: yield* automaticUpdatesAllowed,
        serviceVersion,
        appVersion: environment.appVersion,
        state: current,
      })
    ) {
      yield* logInfo("service is older than the app; installing the app's version when idle", {
        serviceVersion,
        appVersion: environment.appVersion,
      });
      yield* request("install", { version: environment.appVersion });
      return;
    }
    const settings = yield* desktopSettings.get;
    const start = appStartAgentRun({
      checkAutomatically: settings.updatePreferences.checkAutomatically,
      automaticUpdatesAllowed: yield* automaticUpdatesAllowed,
      pendingForcedInstall: controller.pendingForcedInstall(
        DateTime.toEpochMillis(yield* DateTime.now),
      ),
    });
    if (start !== null) yield* startAgent(start.reason, start.reportFailure);
  }).pipe(Effect.forkScoped);

  // The app and the service download the same release on their own clocks.
  // Once the app finds one the service does not run yet, its agent checks now
  // (and downloads, when downloads run in the background), so "Update now"
  // finds both halves on disk. Nobody asked for this check, so it never shows
  // or clears a failure: a turned-off agent keeps saying so in Settings.
  const asked = new Set<string>();
  const askAgentToCheck = (appState: DesktopUpdateState) =>
    Effect.gen(function* () {
      if ((yield* controllerFor(environment)).installation() === null) return;
      const version = serviceCheckFor({ appState, service: yield* readState, asked });
      if (version === null) return;
      asked.add(version);
      yield* logInfo("the app found a release the service does not run; asking its agent", {
        version,
      });
      const written = yield* syncConfig({
        checkRequestedAt: DateTime.formatIso(yield* DateTime.now),
      });
      if (written) yield* startAgent("app found a release", false).pipe(Effect.forkDetach);
      yield* publish;
    });
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.sleep(AGENT_START_DELAY);
      const { latest, changes } = yield* updates.subscribe;
      yield* askAgentToCheck(latest);
      yield* Stream.runForEach(changes, askAgentToCheck);
    }),
  ).pipe(Effect.ignoreCause, Effect.forkScoped);

  yield* publish.pipe(
    Effect.andThen(Effect.sleep(STATE_POLL_INTERVAL)),
    Effect.forever,
    Effect.ignoreCause,
    Effect.forkScoped,
  );
});
