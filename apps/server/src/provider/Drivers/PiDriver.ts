/**
 * PiDriver — v1 `ProviderDriver` for the Pi coding agent, composing the
 * orchestrator-v2 adapter (`PiAdapterV2`), the snapshot/probe layer
 * (`PiProvider`), and Pi-backed text generation.
 *
 * Pi state (sessions, settings, extensions, auth) lives in the user's own
 * `~/.pi/agent`, so continuation identity uses the default instance grouping.
 */
import { PiSettings, ProviderDriverKind, type ServerProvider } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import {
  PiAdapterV2Driver,
  type PiAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/PiAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  piStatusFolderUnavailable,
  enrichPiSnapshot,
} from "../PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@earendil-works/pi-coding-agent",
  // Pi's updater covers its own installer and npm, pnpm, yarn, and bun globals.
  nativeUpdate: { args: ["update", "--self"] },
});

export type PiDriverEnv =
  | PiAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

/**
 * Whether no other user can rename, replace, fill or write beside `folder`:
 * it and every folder above it are owned by this user or the system and closed
 * to others. A sticky folder such as /tmp does not count, because Pi also reads
 * context files from every folder above the one it runs in. Windows guards
 * folders with ACLs, not these modes.
 */
const isPrivateFolderPath = (fileSystem: FileSystem.FileSystem, path: Path.Path, folder: string) =>
  Effect.gen(function* () {
    if (process.platform === "win32") return true;
    const uid = process.getuid?.();
    let current = folder;
    for (let depth = 0; ; depth++) {
      const info = yield* fileSystem.stat(current);
      const owner = Option.getOrUndefined(info.uid);
      const closed = (info.mode & 0o022) === 0;
      const ok =
        depth === 0
          ? info.type === "Directory" && owner === uid && closed
          : (owner === uid || owner === 0) && closed;
      if (!ok) return false;
      const parent = path.dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  });

/**
 * Pi starts every extension's session hooks, and reads project MCP config and
 * context files, in the folder it runs in and the folders above it. The
 * server's folder is the home folder on the desktop app, so each status check
 * runs Pi in a new private empty folder (mode 0700, removed afterwards) under
 * the app's status cache. Pi runs in the folder's real path, and only when it
 * and every folder above it are closed to other users; otherwise the check
 * fails without starting Pi anywhere else. A relative binary path names a
 * file from the server's folder, as before.
 */
export const checkPiProviderStatusInProbeFolder = (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  folders: { readonly probeParent: string; readonly serverCwd: string },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (!settings.enabled) return yield* checkPiProviderStatus(settings, environment);
      const binaryPath = settings.binaryPath.trim();
      const probeSettings =
        binaryPath.length > 0 && /[\\/]/.test(binaryPath) && !path.isAbsolute(binaryPath)
          ? { ...settings, binaryPath: path.resolve(folders.serverCwd, binaryPath) }
          : settings;
      const probeFolder = yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(folders.probeParent, { recursive: true });
        const made = yield* fileSystem.makeTempDirectoryScoped({
          directory: folders.probeParent,
          prefix: "pi-status-probe-",
        });
        const folder = yield* fileSystem.realPath(made);
        return (yield* isPrivateFolderPath(fileSystem, path, folder)) ? folder : undefined;
      }).pipe(Effect.result);
      if (probeFolder._tag === "Failure" || probeFolder.success === undefined) {
        const reason =
          probeFolder._tag === "Failure" ? probeFolder.failure.reason._tag : "NotPrivate";
        yield* Effect.logWarning("Pi status check folder could not be made.", { reason });
        return yield* piStatusFolderUnavailable(probeSettings, reason);
      }
      return yield* checkPiProviderStatus(probeSettings, environment, probeFolder.success);
    }),
  );

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const { cwd, providerStatusCacheDir } = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const orchestrationAdapter = yield* PiAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Pi orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkPiProviderStatusInProbeFolder(effectiveConfig, processEnv, {
        probeParent: providerStatusCacheDir,
        serverCwd: cwd,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        // The command `pi --version` runs as, with its environment, so an install
        // or repair in a terminal shows without a click.
        installProbe: { command: effectiveConfig.binaryPath || "pi", environment: processEnv },
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichPiSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Pi snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        skillsControl: {
          binaryPath: effectiveConfig.binaryPath || "pi",
          environment: processEnv,
        },
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
