import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EventEmitter } from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron updater events consume Node filesystem and stream handles for atomic bundle staging.
import * as FS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron updater events consume Node filesystem and stream handles for atomic bundle staging.
import * as Path from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron updater events consume Node filesystem and stream handles for atomic bundle staging.
import { Readable, Transform } from "node:stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron updater events consume Node filesystem and stream handles for atomic bundle staging.
import { pipeline } from "node:stream/promises";

import {
  fetchReleases,
  GitHubFeedError,
  isPlainAssetName,
  macUpdateManifestName,
  openReleaseAsset,
  parseUpdateManifest,
  selectMacZip,
  selectNewestRelease,
  type GitHubFeed,
  type GitHubReleaseAsset,
  type UpdateManifestFile,
} from "../updates/githubReleaseFeed.ts";
import {
  assertReplaceable,
  readBundleIdentity,
  removeTree,
  resolveRunningAppBundle,
  sha512Base64,
  startDetachedSwap,
  unpackAppZip,
} from "../updates/macSwapInstall.ts";
import { resolveSwapTarget } from "../updates/macBundleName.ts";
import { updateTokenResolver } from "../updates/updateToken.ts";
import {
  ElectronUpdater,
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
  type ElectronUpdaterFeedUrl,
} from "./ElectronUpdater.ts";

/**
 * Whether this build installs updates with the bundle swap instead of
 * Squirrel.Mac. The build stamps `studioBuild.signed` into the app's
 * package.json; anything not stamped as signed is treated as unsigned.
 */
export function shouldUseMacSwapUpdater(
  platform: NodeJS.Platform = process.platform,
  readAppPackageJson: () => string | null = () => {
    try {
      return FS.readFileSync(Path.join(Electron.app.getAppPath(), "package.json"), "utf8");
    } catch {
      return null;
    }
  },
): boolean {
  if (platform !== "darwin") return false;
  const raw = readAppPackageJson();
  if (raw === null) return true;
  try {
    const parsed = JSON.parse(raw) as { studioBuild?: { signed?: unknown } };
    return parsed.studioBuild?.signed !== true;
  } catch {
    return true;
  }
}

interface Candidate {
  readonly version: string;
  readonly releaseNotes: string | null;
  readonly zip: UpdateManifestFile;
  readonly zipAsset: GitHubReleaseAsset;
}

interface Pending {
  readonly version: string;
  readonly stagedBundle: string;
  readonly releaseNotes: string | null;
}

function readFeed(options: ElectronUpdaterFeedUrl): Omit<GitHubFeed, "token"> & {
  readonly token: string | null | undefined;
} {
  const record = options as unknown as Record<string, unknown>;
  if (
    record.provider !== "github" ||
    typeof record.owner !== "string" ||
    typeof record.repo !== "string"
  ) {
    throw new Error("The macOS update installer only reads GitHub release feeds.");
  }
  return {
    owner: record.owner,
    repo: record.repo,
    token: typeof record.token === "string" ? record.token : undefined,
    ...(typeof record.apiUrl === "string" ? { apiUrl: record.apiUrl } : {}),
  };
}

export function makeMacSwapUpdater(
  deps: {
    readonly app?: Pick<Electron.App, "getPath" | "getVersion" | "quit" | "on">;
    readonly fetch?: typeof fetch;
    readonly resolveToken?: () => Promise<string | null>;
    readonly arch?: string;
    readonly execPath?: string;
    readonly pid?: number;
  } = {},
): ElectronUpdater["Service"] {
  const app = deps.app ?? Electron.app;
  const fetchImpl = deps.fetch ?? fetch;
  const resolveToken = deps.resolveToken ?? updateTokenResolver.resolve;
  const arch = deps.arch ?? process.arch;
  const execPath = deps.execPath ?? process.execPath;
  const pid = deps.pid ?? process.pid;
  const events = new EventEmitter();
  // An updater error with no listener would throw from emit.
  events.on("error", () => undefined);

  let feedBase: ReturnType<typeof readFeed> | null = null;
  let channel = "latest";
  let allowPrerelease = false;
  let allowDowngrade = false;
  let autoInstallOnAppQuit = false;
  let candidate: Candidate | null = null;
  // The manifest of a release never changes, so it is read once per asset.
  let manifestCache: { readonly assetId: number; readonly text: string } | null = null;
  let pending: Pending | null = null;
  let installStarted = false;

  const workDir = () => Path.join(app.getPath("userData"), "pending-update");

  // Leftovers from an earlier run belong to an update that either installed
  // or was abandoned; the in-memory state is the only source of truth.
  // Downloads wait for it so the cleanup cannot delete a fresh download.
  const leftoversRemoved = removeTree(workDir()).catch(() => undefined);

  const currentFeed = async (): Promise<GitHubFeed> => {
    if (feedBase === null) throw new Error("No update feed is configured.");
    const token = feedBase.token ?? (await resolveToken());
    return { ...feedBase, token: token ?? null };
  };

  const startSwap = (relaunch: boolean) => {
    if (pending === null) throw new Error("No downloaded update is ready to install.");
    const current = resolveRunningAppBundle(execPath);
    if (current === null) throw new Error("SpecWithCode is not running from an app bundle.");
    assertReplaceable(current);
    FS.mkdirSync(workDir(), { recursive: true, mode: 0o700 });
    startDetachedSwap({
      scriptPath: Path.join(workDir(), "swap.sh"),
      pid,
      currentBundle: current,
      stagedBundle: pending.stagedBundle,
      relaunch,
      // An install still named after an earlier release moves to the new name.
      targetBundle: resolveSwapTarget(current, pending.stagedBundle),
    });
    installStarted = true;
  };

  app.on("will-quit", () => {
    if (!autoInstallOnAppQuit || pending === null || installStarted) return;
    try {
      startSwap(false);
    } catch (error) {
      // @effect-diagnostics-next-line globalConsole:off -- will-quit logging must complete synchronously after the Effect runtime shuts down.
      console.warn("[desktop-updater] could not install the update on quit", error);
    }
  });

  const check = async () => {
    events.emit("checking-for-update");
    const feed = await currentFeed();
    const releases = await fetchReleases(feed, fetchImpl);
    const selected = selectNewestRelease({
      releases,
      currentVersion: app.getVersion(),
      allowPrerelease,
      manifestName: macUpdateManifestName(channel),
    });
    if (selected === null) {
      candidate = null;
      events.emit("update-not-available");
      return;
    }
    if (manifestCache?.assetId !== selected.manifestAsset.id) {
      const manifestResponse = await openReleaseAsset(feed, selected.manifestAsset.id, fetchImpl);
      manifestCache = { assetId: selected.manifestAsset.id, text: await manifestResponse.text() };
    }
    const manifest = parseUpdateManifest(manifestCache.text);
    if (manifest === null || manifest.version !== selected.version) {
      throw new Error(
        `Release ${selected.release.tagName} has an unreadable ${selected.manifestAsset.name}.`,
      );
    }
    const zip = selectMacZip(manifest, arch);
    const zipAsset =
      zip === null ? undefined : selected.release.assets.find((asset) => asset.name === zip.url);
    if (zip === null || zipAsset === undefined || !isPlainAssetName(zip.url)) {
      throw new Error(
        `Release ${selected.release.tagName} has no app build for this Mac (${arch}).`,
      );
    }
    candidate = {
      version: selected.version,
      releaseNotes: selected.release.body,
      zip,
      zipAsset,
    };
    events.emit("update-available", {
      version: selected.version,
      releaseNotes: selected.release.body ?? undefined,
    });
  };

  const download = async () => {
    const target = candidate;
    if (target === null) throw new Error("Check for updates before downloading.");
    if (pending?.version === target.version) {
      events.emit("update-downloaded", {
        version: target.version,
        releaseNotes: target.releaseNotes ?? undefined,
      });
      return;
    }
    // The staged folder is about to be replaced, so an earlier download no
    // longer exists to install, even if this one fails.
    pending = null;
    const feed = await currentFeed();
    const dir = workDir();
    await leftoversRemoved;
    await FS.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const partPath = Path.join(dir, `${target.zip.url}.part`);
    const response = await openReleaseAsset(feed, target.zipAsset.id, fetchImpl);
    if (response.body === null) throw new Error("The update download was empty.");
    const total =
      Number.parseInt(response.headers.get("content-length") ?? "", 10) ||
      target.zip.size ||
      target.zipAsset.size ||
      0;
    let received = 0;
    let lastPercent = -1;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (total > 0) {
          const percent = Math.min(100, (received / total) * 100);
          if (Math.floor(percent) !== lastPercent) {
            lastPercent = Math.floor(percent);
            events.emit("download-progress", { percent, transferred: received, total });
          }
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
      progress,
      FS.createWriteStream(partPath, { mode: 0o600 }),
    );
    const digest = await sha512Base64(partPath);
    if (digest !== target.zip.sha512) {
      await FS.promises.rm(partPath, { force: true });
      throw new Error(
        "The downloaded update does not match the release checksum, so it was discarded.",
      );
    }
    // `.noindex` keeps Spotlight and Launch Services from listing the staged
    // copy as another installed app while it waits for the restart.
    const stagedBundle = await unpackAppZip(partPath, Path.join(dir, "staged.noindex"));
    await FS.promises.rm(partPath, { force: true });
    const current = resolveRunningAppBundle(execPath);
    const [staged, running] = await Promise.all([
      readBundleIdentity(stagedBundle),
      current === null ? Promise.resolve(null) : readBundleIdentity(current),
    ]);
    if (running !== null && staged.bundleId !== running.bundleId) {
      throw new Error("The downloaded app is not this app, so it was discarded.");
    }
    if (staged.version !== target.version) {
      throw new Error(
        `The downloaded app reports version ${staged.version ?? "unknown"}, not ${target.version}.`,
      );
    }
    pending = { version: target.version, stagedBundle, releaseNotes: target.releaseNotes };
    events.emit("update-downloaded", {
      version: target.version,
      releaseNotes: target.releaseNotes ?? undefined,
    });
  };

  const fail = (error: unknown) => {
    events.emit("error", error instanceof Error ? error : new Error(String(error)));
    if (error instanceof GitHubFeedError && error.status === 401) {
      // A stale gh token: the next check asks gh again.
      void updateTokenResolver.invalidate();
    }
    throw error;
  };

  return ElectronUpdater.of({
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedBase = readFeed(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: (value) =>
      Effect.sync(() => {
        autoInstallOnAppQuit = value;
      }),
    setChannel: (value) =>
      Effect.sync(() => {
        channel = value;
      }),
    setAllowPrerelease: (value) =>
      Effect.sync(() => {
        allowPrerelease = value;
      }),
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates: Effect.tryPromise({
      try: () => check().catch(fail),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: () => download().catch(fail),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: () => {
          startSwap(true);
          app.quit();
        },
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({ channel, isSilent, isForceRunAfter, cause }),
      }),
    on: (eventName, listener) => {
      const untyped = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untyped);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untyped);
          }),
      ).pipe(Effect.asVoid);
    },
  });
}

export const layer = Layer.sync(ElectronUpdater, () => makeMacSwapUpdater());
