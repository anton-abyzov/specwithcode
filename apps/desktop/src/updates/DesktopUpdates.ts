import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateRefusalReason,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@specweave-studio/contracts";
import * as Electron from "electron";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { type LocalServiceProbe, makeAppActivationControl } from "./appActivationControl.ts";
import { APP_INSTALL_APPLY_MS } from "./appFollowUp.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import { updateTokenResolver } from "./updateToken.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
// The poller wakes this often and checks once the last successful check is
// older than STALE_CHECK_MIN_AGE_MS. Timers stop while the Mac sleeps, so a
// fixed hourly sleep could leave a new release unseen for hours; comparing
// wall-clock ages catches up on the first tick after a wake.
const AUTO_UPDATE_POLL_TICK = "1 minute";
const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);
// electron-updater's download promise can stay pending after it reported the
// download (seen after an error event at 100%), holding the updater; the
// download is given up after this long so the lock cannot stay taken.
const DOWNLOAD_STALL_LIMIT = Duration.minutes(30);
// Squirrel.Mac unpacks and checks the bundle after electron-updater hands it
// the download; an install waits this long for that before giving up.
const SQUIRREL_STAGE_WAIT_POLLS = 240;
const SQUIRREL_STAGE_POLL = Duration.millis(500);
const INSTALL_NOT_STAGED = "macOS did not prepare the update. Try restarting to update again.";
const INSTALL_DID_NOT_QUIT = "SpecWithCode did not restart to install the update.";
// A new release shows in the sidebar within this long. Ten minutes keeps a
// machine at six feed requests an hour, far below GitHub's limits, and also
// bounds re-checks on wake, unlock and window focus.
export const STALE_CHECK_MIN_AGE_MS = 10 * 60 * 1000;
// While checks keep failing (offline, feed errors), those re-checks still wait
// this long after the last attempt instead of firing on every focus.
const STALE_RETRY_MIN_AGE_MS = 5 * 60 * 1000;
// Opening Settings > General, where the version row is, checks when the last
// check is older than this, so the row never shows an old "Up to date".
export const SETTINGS_CHECK_MIN_AGE_MS = 60 * 1000;

export interface DesktopUpdateStaleCheckOptions {
  /** Check when the last successful check is older than this. */
  readonly minAgeMs?: number;
  /** After a failed check, wait this long after the attempt before trying again. */
  readonly retryMinAgeMs?: number;
}

/** A system notification about a release of the app. */
export interface DesktopUpdateNotice {
  readonly kind: "available" | "downloaded";
  readonly version: string;
  readonly title: string;
  readonly body: string;
}

/** Posts `notice`; `onClick` runs when the person clicks it. */
export type DesktopUpdateNoticePoster = (notice: DesktopUpdateNotice, onClick: () => void) => void;

// A notification Electron garbage-collects no longer reports its click, so
// each one stays referenced until it is clicked or closed.
const shownUpdateNotifications = new Set<Electron.Notification>();

const postNativeUpdateNotice: DesktopUpdateNoticePoster = (notice, onClick) => {
  if (typeof Electron.Notification?.isSupported !== "function") return;
  if (!Electron.Notification.isSupported()) return;
  const notification = new Electron.Notification({ title: notice.title, body: notice.body });
  shownUpdateNotifications.add(notification);
  notification.on("click", () => {
    shownUpdateNotifications.delete(notification);
    onClick();
  });
  notification.on("close", () => shownUpdateNotifications.delete(notification));
  notification.on("failed", () => shownUpdateNotifications.delete(notification));
  notification.show();
};

/** How update notices reach the system; tests replace it. */
export const DesktopUpdateNotifier = Context.Reference<DesktopUpdateNoticePoster>(
  "@specweave-studio/desktop/updates/DesktopUpdateNotifier",
  { defaultValue: () => postNativeUpdateNotice },
);

export function describeUpdateNotice(
  kind: DesktopUpdateNotice["kind"],
  version: string,
  downloadsAutomatically: boolean,
): DesktopUpdateNotice {
  if (kind === "downloaded") {
    return {
      kind,
      version,
      title: `SpecWithCode ${version} is ready to install`,
      body: "Restart the app to update. Click to open Settings.",
    };
  }
  return {
    kind,
    version,
    title: `SpecWithCode ${version} is available`,
    body: downloadsAutomatically
      ? "It is downloading in the background. Click to open Settings."
      : "Click to open Settings and download it.",
  };
}

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);
const AnnouncedNotices = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeAnnouncedNotices = Schema.decodeEffect(AnnouncedNotices);
const encodeAnnouncedNotices = Schema.encodeEffect(AnnouncedNotices);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll", "stale"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    /** True while a check, download, install, or channel change holds the
        updater's single action reservation. */
    readonly isActionActive: Effect.Effect<boolean>;
    /** True only while an install owns the updater action reservation. */
    readonly isInstallActive: Effect.Effect<boolean>;
    /** Current state plus a stream of every later state change. */
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    /**
     * Checks (and downloads in the background) when automatic checks are on
     * and the last successful check is older than 2 minutes (or
     * `options.minAgeMs`). For wake, unlock, window-focus and Settings triggers.
     */
    readonly checkIfStale: (
      reason: string,
      options?: DesktopUpdateStaleCheckOptions,
    ) => Effect.Effect<void>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
      options?: { readonly serviceLacksRelease?: boolean },
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
    /** Re-reads the saved update preferences and applies them to the updater. */
    readonly applyPreferences: Effect.Effect<void>;
    /**
     * How to read the local service: the app swaps itself for a downloaded
     * release only once that service runs it (appActivationGate.ts). Without
     * a probe, or when it returns null, there is no service to wait for.
     */
    readonly registerLocalServiceProbe: (probe: LocalServiceProbe) => Effect.Effect<void>;
    /** Reads the local service again and applies the swap gate. */
    readonly refreshActivation: Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/updates/DesktopUpdates") {}

/**
 * The underlying error's own words, so a failed download says why. Keeps the
 * first line, adds a nested cause (e.g. ECONNRESET under "fetch failed") and
 * drops URL query strings, which can carry signed download parameters.
 */
export function describeUpdaterCause(cause: unknown): string | null {
  const firstLine = (error: unknown) =>
    error instanceof Error ? (error.message.split("\n")[0] ?? "").trim() : "";
  const own = firstLine(cause);
  if (own.length === 0) return null;
  const nested = cause instanceof Error ? firstLine(cause.cause) : "";
  const text = (nested.length > 0 && nested !== own ? `${own} (${nested})` : own).replace(
    /\?[^\s"')]*/g,
    "",
  );
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
    productionBuild: isProductionBuild(environment),
  };
}

// The same test the updater uses: a dev or unpackaged build never updates
// itself, whatever SPECWITHCODE_DISABLE_AUTO_UPDATE says.
function isProductionBuild(environment: DesktopEnvironment.DesktopEnvironment["Service"]): boolean {
  return !environment.isDevelopment && environment.isPackaged;
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
  feedIsUpstream?: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.feedIsUpstream) {
    return "Automatic updates are off because this build points at a feed SpecWithCode does not own.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the SPECWITHCODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

// Studio never updates itself from the product it was forked from.
const UPSTREAM_UPDATE_FEED_PATTERN = /pingdotgg|t3code|t3tools|t3\.codes/i;

function isUpstreamUpdateFeed(config: AppUpdateYmlConfig | undefined): boolean {
  if (config === undefined) return false;
  return [config.owner, config.repo, config.url].some(
    (value) => typeof value === "string" && UPSTREAM_UPDATE_FEED_PATTERN.test(value),
  );
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const postUpdateNotice = yield* DesktopUpdateNotifier;
  // One notification per version and kind, kept across launches so a restart
  // does not announce the same version again.
  const announcedNoticesPath = environment.path.join(environment.stateDir, "update-notices.json");
  let announcedNotices: Set<string> | null = null;
  const loadAnnouncedNotices = Effect.gen(function* () {
    if (announcedNotices !== null) return announcedNotices;
    const keys = yield* fileSystem.readFileString(announcedNoticesPath, "utf-8").pipe(
      Effect.flatMap(decodeAnnouncedNotices),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    announcedNotices = new Set(keys);
    return announcedNotices;
  });
  const rememberAnnouncedNotice = (notices: Set<string>, key: string) =>
    Effect.gen(function* () {
      notices.add(key);
      const recent = [...notices].slice(-20);
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(
        announcedNoticesPath,
        yield* encodeAnnouncedNotices(recent),
      );
    }).pipe(Effect.catch(() => logUpdaterWarning("Could not record a shown update notification.")));

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  // Background work (automatic downloads) runs in the scope `configure` opened.
  const backgroundScopeRef = yield* Ref.make<Option.Option<Scope.Scope>>(Option.none());
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  // Only a check that reached the feed counts; a failed offline check must
  // not hold back the next wake or focus re-check.
  const lastSuccessfulCheckAtRef = yield* Ref.make<number | null>(null);
  const markCheckSucceeded = DateTime.now.pipe(
    Effect.flatMap((now) => Ref.set(lastSuccessfulCheckAtRef, DateTime.toEpochMillis(now))),
  );
  const lastCheckAttemptAtRef = yield* Ref.make<number | null>(null);
  const markCheckAttempted = DateTime.now.pipe(
    Effect.flatMap((now) => Ref.set(lastCheckAttemptAtRef, DateTime.toEpochMillis(now))),
  );
  const updateStateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
    productionBuild: isProductionBuild(environment),
  });

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Makes ref writes + publishes atomic against subscribe, so a snapshot
  // never overlaps with the first change a subscriber receives.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // The .deb carries electron-builder's resources/package-type marker.
  // electron-updater reads the same file and installs updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        isDebPackage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
        feedIsUpstream: isUpstreamUpdateFeed(
          Option.getOrUndefined(yield* Ref.get(appUpdateYmlConfigRef)),
        ),
      }),
    );
  });

  const activeUpdateAction = Ref.get(activeUpdateActionRef);
  const isInstallActive = activeUpdateAction.pipe(
    Effect.map((action) => Option.isSome(action) && action.value === "install"),
  );

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished ? PubSub.publish(finishedUpdateActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  // Private GitHub releases need a token. Studio stores none: it asks the
  // `gh` login on this computer before each check and hands the value only
  // to the updater, which sends it to the GitHub API.
  const refreshGitHubFeed = Effect.gen(function* () {
    if (config.mockUpdates) return;
    const appUpdateYmlConfig = yield* Ref.get(appUpdateYmlConfigRef);
    if (Option.isNone(appUpdateYmlConfig)) return;
    const { provider, owner, repo } = appUpdateYmlConfig.value;
    if (provider !== "github" || !owner || !repo) return;
    const token = yield* Effect.promise(() => updateTokenResolver.resolve());
    yield* electronUpdater.setFeedURL({
      provider: "github",
      owner,
      repo,
      ...(token ? { private: true, token } : {}),
    } as ElectronUpdater.ElectronUpdaterFeedUrl);
  }).pipe(Effect.withSpan("desktop.updates.refreshGitHubFeed"));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;
    yield* markCheckAttempted;

    const check = Effect.gen(function* () {
      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
      yield* logUpdaterInfo("checking for updates", { reason });
      yield* refreshGitHubFeed;

      return yield* electronUpdater.checkForUpdates.pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(
          Effect.onInterrupt(() => setState(state)),
          // Any other failure must not leave the state on "checking", which
          // would hide a downloaded update until the next launch.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : currentIsoTimestamp.pipe(
                  Effect.flatMap((failedAt) =>
                    updateState((current) =>
                      current.status === "checking"
                        ? reduceDesktopUpdateStateOnCheckFailure(
                            current,
                            "The update check failed unexpectedly.",
                            failedAt,
                          )
                        : current,
                    ),
                  ),
                  Effect.asVoid,
                ),
          ),
          Effect.ensuring(finishUpdateAction("check")),
        );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }

    if (!(yield* tryStartUpdateAction("download"))) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      // Squirrel stages the download for install-on-quit if the flag is set
      // when it finishes: set it now, for this version.
      yield* Effect.suspend(() => activation.applyActivation);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      const finished = yield* electronUpdater.downloadUpdate.pipe(
        Effect.timeoutOption(DOWNLOAD_STALL_LIMIT),
      );
      if (Option.isNone(finished)) {
        const current = yield* Ref.get(updateStateRef);
        if (current.status === "downloaded") return { accepted: true, completed: true };
        const message = "The update download stopped responding.";
        yield* updateState((latest) => reduceDesktopUpdateStateOnDownloadFailure(latest, message));
        yield* logUpdaterError(message, { errorTag: "DownloadStalled" });
        return { accepted: true, completed: false };
      }
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            const detail = describeUpdaterCause(error.cause);
            const message = detail === null ? error.message : `${error.message} ${detail}`;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
              ...(detail === null ? {} : { detail }),
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  // With "download in the background" on, a found update starts downloading
  // as soon as the check that found it releases the updater.
  const startAutomaticDownload = Effect.gen(function* () {
    const settings = yield* desktopSettings.get;
    if (!settings.updatePreferences.downloadAutomatically) return;
    const state = yield* Ref.get(updateStateRef);
    if (state.status !== "available") return;
    const scope = yield* Ref.get(backgroundScopeRef);
    if (Option.isNone(scope)) return;
    yield* logUpdaterInfo("downloading update in the background", {
      version: state.availableVersion,
    });
    yield* downloadAvailableUpdate.pipe(Effect.asVoid, Effect.forkIn(scope.value));
  }).pipe(Effect.withSpan("desktop.updates.startAutomaticDownload"));

  const checkThenDownload = (reason: string) =>
    checkForUpdates(reason).pipe(Effect.tap(() => startAutomaticDownload));

  const automaticChecksEnabled = desktopSettings.get.pipe(
    Effect.map((settings) => settings.updatePreferences.checkAutomatically),
  );

  const checkIfStale = Effect.fn("desktop.updates.checkIfStale")(
    function* (reason: string, options?: DesktopUpdateStaleCheckOptions) {
      if (!(yield* Ref.get(updaterConfiguredRef))) return;
      if (!(yield* automaticChecksEnabled)) return;
      // An update being fetched needs no new check; a downloaded one still
      // does, so a newer release replaces it.
      if ((yield* Ref.get(updateStateRef)).status === "downloading") return;
      const last = yield* Ref.get(lastSuccessfulCheckAtRef);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (last !== null && now - last < (options?.minAgeMs ?? STALE_CHECK_MIN_AGE_MS)) return;
      const lastAttempt = yield* Ref.get(lastCheckAttemptAtRef);
      // Only an attempt newer than the last success failed (or is running).
      if (
        lastAttempt !== null &&
        (last === null || lastAttempt > last) &&
        now - lastAttempt < (options?.retryMinAgeMs ?? STALE_RETRY_MIN_AGE_MS)
      ) {
        return;
      }
      yield* checkThenDownload(reason);
    },
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void;
      const error = new DesktopUpdatePollerError({ poller: "stale", cause });
      return logUpdaterError(error.message, { errorTag: error._tag, poller: error.poller });
    }),
  );

  // Install-on-quit follows the saved preference and the app swap gate.
  const activation = makeAppActivationControl({
    updaterConfigured: Ref.get(updaterConfiguredRef),
    getState: Ref.get(updateStateRef),
    updateState,
    installAutomatically: desktopSettings.get.pipe(
      Effect.map((settings) => settings.updatePreferences.installAutomatically),
    ),
    holdInstallOnQuit: Effect.sync(() => stagingForInstall),
    setAutoInstallOnAppQuit: electronUpdater.setAutoInstallOnAppQuit,
    backgroundScope: Ref.get(backgroundScopeRef),
    checkForUpdates: (reason) => checkForUpdates(reason),
    startAutomaticDownload,
    tryStartDownload: tryStartUpdateAction("download"),
    finishDownload: finishUpdateAction("download"),
    downloadUpdate: electronUpdater
      .setDisableDifferentialDownload(isArm64HostRunningIntelBuild(environment.runtimeInfo))
      .pipe(Effect.andThen(electronUpdater.downloadUpdate)),
    downloadStallLimit: DOWNLOAD_STALL_LIMIT,
  });
  const applyInstallPreference = activation.applyActivation;

  // Tells the primary backend that the coming stop is an update restart, so it
  // keeps its managed tunnel for the backend the updated app starts. Best
  // effort: without the marker the backend only re-provisions its tunnel.
  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  // A failed or interrupted install brings no updated backend, so a later
  // quit must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      removeUpdateRestartMarker,
    ],
    { discard: true },
  );

  // While an install stages the download, an updater error belongs to that
  // download (it fails on its own), not to a quit that has not started.
  let stagingForInstall = false;
  // Each accepted install arms one watch; a later install disarms older ones.
  let installAttempt = 0;

  const waitForStaging = Effect.gen(function* () {
    for (let poll = 0; poll < SQUIRREL_STAGE_WAIT_POLLS; poll++) {
      if (yield* electronUpdater.installReady) return true;
      yield* Effect.sleep(SQUIRREL_STAGE_POLL);
    }
    return yield* electronUpdater.installReady;
  });

  // Squirrel.Mac stages a download only when it finishes with install-on-quit
  // set; quitAndInstall on an unstaged one never quits by itself. Fetch it
  // again (from electron-updater's cache) with the flag set so Squirrel
  // stages it, then wait for that. A restage that just handed it over may
  // still be unpacking, so that one is waited for instead of fetched again.
  const stageForInstall = (restaged: boolean) =>
    Effect.gen(function* () {
      if (restaged && (yield* waitForStaging)) return true;
      yield* logUpdaterInfo("staging the downloaded update before installing it");
      yield* electronUpdater.setAutoInstallOnAppQuit(true);
      const finished = yield* electronUpdater
        .setDisableDifferentialDownload(isArm64HostRunningIntelBuild(environment.runtimeInfo))
        .pipe(
          Effect.andThen(electronUpdater.downloadUpdate),
          Effect.timeoutOption(DOWNLOAD_STALL_LIMIT),
        );
      if (Option.isNone(finished)) return false;
      return yield* waitForStaging;
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: (error) =>
          logUpdaterError(error.message, { errorTag: error._tag, channel: error.channel }).pipe(
            Effect.as(false),
          ),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          stagingForInstall = false;
        }),
      ),
      Effect.withSpan("desktop.updates.stageForInstall"),
    );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
  ) {
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    yield* Ref.set(desktopState.quitting, false);
    yield* removeUpdateRestartMarker;
    yield* Effect.gen(function* () {
      const instances = yield* pool.list;
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  const recoverStalledInstall = Effect.gen(function* () {
    if (!(yield* isInstallActive)) return;
    yield* logUpdaterWarning(INSTALL_DID_NOT_QUIT);
    yield* recoverFailedInstall(INSTALL_DID_NOT_QUIT);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : logUpdaterError("Could not recover from an install that did not quit."),
    ),
    Effect.withSpan("desktop.updates.recoverStalledInstall"),
  );

  const installDownloadedUpdate = (expectedVersion?: string, serviceLacksRelease = false) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (yield* activation.refusesInstall(expectedVersion, serviceLacksRelease)) {
          return {
            accepted: false,
            completed: false,
            failed: false,
            reason: "service-behind" as const,
          };
        }
        // The gate that just opened may have forked a restage; installing
        // ahead of it would leave Squirrel without the staged bundle.
        const restaged = yield* activation.awaitRestage(PREPARED_INSTALL_CHECK_WAIT);
        const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
        let admission: "admitted" | "refused" | "wait-for-check" = "wait-for-check";
        let refusal: DesktopUpdateRefusalReason = "busy";
        const refuse = (reason: DesktopUpdateRefusalReason) => {
          refusal = reason;
          return "refused" as const;
        };
        while (admission === "wait-for-check") {
          admission = yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(updateStateRef);
              const activeAction = yield* Ref.get(activeUpdateActionRef);
              const hasExpectedDownload =
                state.downloadedVersion !== null &&
                (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
              if (yield* Ref.get(desktopState.quitting)) return refuse("quitting");
              if (!(yield* Ref.get(updaterConfiguredRef))) return refuse("disabled");
              if (!hasExpectedDownload) return refuse("no-download");
              if (Option.isSome(activeAction)) {
                // A check or a download ends on its own: wait for it instead of refusing.
                return (activeAction.value === "check" && expectedVersion !== undefined) ||
                  activeAction.value === "download"
                  ? ("wait-for-check" as const)
                  : refuse("busy");
              }
              const hasInstallableDownload =
                state.status === "downloaded" ||
                (state.status === "error" &&
                  (state.errorContext === null || state.errorContext === "install"));
              if (!hasInstallableDownload) return refuse("no-download");
              return (yield* tryStartUpdateAction("install"))
                ? ("admitted" as const)
                : refuse("busy");
            }),
          );
          if (admission === "wait-for-check") {
            const finishedAction = yield* PubSub.take(actionCompletions).pipe(
              Effect.timeoutOption(PREPARED_INSTALL_CHECK_WAIT),
            );
            if (Option.isNone(finishedAction)) {
              admission = refuse("busy");
            }
          }
        }
        if (admission === "refused") {
          return { accepted: false, completed: false, failed: false, reason: refusal };
        }

        // Taken at admission, so an older install's watch never acts on this one.
        const attempt = ++installAttempt;

        if (!(yield* electronUpdater.installReady)) {
          stagingForInstall = true;
          const staged = yield* stageForInstall(restaged).pipe(
            Effect.onInterrupt(() =>
              finishUpdateAction("install").pipe(Effect.andThen(activation.applyActivation)),
            ),
          );
          if (!staged) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnInstallFailure(current, INSTALL_NOT_STAGED),
            );
            yield* finishUpdateAction("install");
            // Back to the install-on-quit setting the preference and gate allow.
            yield* activation.applyActivation;
            yield* logUpdaterError(INSTALL_NOT_STAGED);
            return { accepted: true, completed: false, failed: true };
          }
        }

        yield* Ref.set(desktopState.quitting, true);

        return yield* Effect.gen(function* () {
          yield* writeUpdateRestartMarker;
          // Stop every backend in the pool, not just the primary. With
          // parallel WSL + Windows backends, leaving the WSL instance up
          // means quitAndInstall's app.quit() exits before the pool's
          // scope cascade has a chance to run its stop finalizer, so the
          // WSL child gets hard-killed by the OS instead of receiving
          // SIGTERM + grace. Stops run concurrently with the same 5s
          // budget the primary had on its own.
          const instances = yield* pool.list;
          yield* Effect.forEach(
            instances,
            (instance) => instance.stop({ timeout: Duration.seconds(5) }),
            { concurrency: "unbounded" },
          );
          yield* electronUpdater.quitAndInstall({
            isSilent: true,
            isForceRunAfter: true,
          });
          // An accepted install quits within seconds. Still running after
          // APP_INSTALL_APPLY_MS, the app gets its updater and backends back.
          const scope = yield* Ref.get(backgroundScopeRef);
          if (Option.isSome(scope)) {
            yield* Effect.sleep(Duration.millis(APP_INSTALL_APPLY_MS)).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  attempt === installAttempt ? recoverStalledInstall : Effect.void,
                ),
              ),
              Effect.forkIn(scope.value),
            );
          }
          return { accepted: true, completed: false, failed: false };
        }).pipe(
          Effect.catchTags({
            ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
              function* (error) {
                yield* recoverFailedInstall(error.message);
                yield* logUpdaterError(error.message, {
                  errorTag: error._tag,
                  channel: error.channel,
                  isSilent: error.isSilent,
                  isForceRunAfter: error.isForceRunAfter,
                });
                return { accepted: true, completed: false, failed: true };
              },
            ),
          }),
          Effect.onInterrupt(() => resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
    serviceLacksRelease = false,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        reason: "quitting" as const,
        state: yield* Ref.get(updateStateRef),
      };
    }
    const result: {
      accepted: boolean;
      completed: boolean;
      failed: boolean;
      reason?: DesktopUpdateRefusalReason;
    } = yield* installDownloadedUpdate(expectedVersion, serviceLacksRelease);
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      ...(result.reason ? { reason: result.reason } : {}),
      state: yield* Ref.get(updateStateRef),
    };
  });

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    // Counts as an attempt so the first window focus at launch leaves the
    // check to the startup pass instead of skipping its delay.
    yield* markCheckAttempted;
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(Effect.when(checkThenDownload("startup"), automaticChecksEnabled)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    // checkIfStale handles its own failure, so one bad pass never ends polling.
    yield* Effect.sleep(AUTO_UPDATE_POLL_TICK).pipe(
      Effect.andThen(checkIfStale("poll")),
      Effect.forever,
      Effect.ignoreCause,
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  // Brings an app window forward on Settings > General, where the version
  // row shows the update.
  const openUpdateSettings = Effect.gen(function* () {
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window) || window.value.isDestroyed()) return;
    yield* electronWindow.reveal(window.value);
    window.value.webContents.send(IpcChannels.MENU_ACTION_CHANNEL, "open-settings");
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : logUpdaterWarning("Could not open Settings from an update notification."),
    ),
  );

  const announceUpdate = Effect.fn("desktop.updates.announceUpdate")(function* (
    kind: DesktopUpdateNotice["kind"],
    version: string,
  ) {
    const key = `${kind}:${version}`;
    const notices = yield* loadAnnouncedNotices;
    if (notices.has(key)) return;
    const settings = yield* desktopSettings.get;
    // Notices follow "Check for updates automatically": with it off the
    // person looks for releases from Settings.
    if (!settings.updatePreferences.checkAutomatically) return;
    yield* rememberAnnouncedNotice(notices, key);
    const notice = describeUpdateNotice(
      kind,
      version,
      settings.updatePreferences.downloadAutomatically,
    );
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    yield* Effect.try(() =>
      postUpdateNotice(notice, () => {
        void runPromise(openUpdateSettings);
      }),
    ).pipe(
      Effect.catch(() => logUpdaterWarning("Could not show an update notification.", { kind })),
    );
    yield* logUpdaterInfo("update notice posted", { kind, version });
  });

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          yield* markCheckSucceeded;
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
            info.releaseNotes,
            info.version,
            state.channel,
          );
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(
              state,
              info.version,
              checkedAt,
              releaseNotes,
              omittedReleaseCount,
            ),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
            omittedReleaseCount,
          });
          yield* announceUpdate("available", info.version);
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    yield* markCheckSucceeded;
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.match(activeAction, {
        onNone: () => "background" as const,
        onSome: (action) => (action === "install-recovery" ? "install" : action),
      }),
      cause,
    });
    if (Option.isSome(activeAction) && activeAction.value === "install" && !stagingForInstall) {
      yield* recoverFailedInstall(error.message);
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
          yield* activation.applyActivation;
          yield* announceUpdate("downloaded", info.version);
          // Downloaded is done, even when the updater's download promise never
          // settles: release the updater so a restart can install it.
          yield* finishUpdateAction("download");
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive,
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const settings = yield* desktopSettings.get;
      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(createBaseUpdateState(settings.updateChannel, enabled, environment));
      if (!enabled) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);
      yield* Ref.set(backgroundScopeRef, Option.some(yield* Effect.scope));

      yield* electronUpdater.setAutoDownload(false);
      yield* activation.applyActivation;
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* tryStartChannelChange;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        if (nextChannel === state.channel) {
          return state;
        }

        yield* desktopSettings
          .setUpdateChannel(nextChannel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
            ),
          );

        const enabled = yield* shouldEnableAutoUpdates;
        yield* setState(createBaseUpdateState(nextChannel, enabled, environment));

        if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel);
        const allowDowngrade = yield* electronUpdater.allowDowngrade;
        yield* electronUpdater.setAllowDowngrade(true);
        yield* checkForUpdates("channel-change", "held").pipe(
          Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
        );
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkThenDownload(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion(),
    installPrepared: (expectedVersion, options) =>
      installWithExpectedVersion(expectedVersion, options?.serviceLacksRelease === true),
    checkIfStale,
    applyPreferences: applyInstallPreference,
    registerLocalServiceProbe: activation.registerProbe,
    refreshActivation: activation.applyActivation,
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
