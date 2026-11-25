/**
 * Turns a launcher's URL into an installed-page window. The URL arrives as a
 * macOS `open-url` event, in a second launch's arguments (Windows and Linux)
 * or in this process's own start arguments. Only a well-formed install id
 * that is in the record opens anything; everything else is ignored.
 *
 * Launches wait until the main window exists. The renderer is served by a
 * protocol registered after Electron is ready, and a page window open first
 * would keep the main window from opening when the backend becomes ready.
 */
import { HostProcessArguments } from "@specweave-studio/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { getDesktopScheme } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import { findArtifactAppLaunchInArgv, parseArtifactAppLaunchUrl } from "./ArtifactAppUrl.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const { logInfo } = makeComponentLogger("desktop-artifact-app-routing");

export type ArtifactAppLaunchSource =
  | { readonly argv: ReadonlyArray<string> }
  | { readonly url: string };

/** The recorded install a launch names, or null for anything else. */
export function resolveArtifactAppLaunch(input: {
  readonly source: ArtifactAppLaunchSource;
  readonly scheme: string;
  readonly knownInstallIds: ReadonlyArray<string>;
}): string | null {
  const installId =
    "url" in input.source
      ? parseArtifactAppLaunchUrl(input.source.url, input.scheme)
      : findArtifactAppLaunchInArgv(input.source.argv, input.scheme);
  return installId !== null && input.knownInstallIds.includes(installId) ? installId : null;
}

interface OpenUrlEmitter {
  on(
    event: "open-url",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
  removeListener(
    event: "open-url",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
}

export interface ArtifactAppEarlyLaunches {
  /** The launch URLs seen so far; each is returned once. */
  readonly take: () => ReadonlyArray<string>;
  readonly dispose: () => void;
}

/**
 * Electron emits the `open-url` that launched the app before any layer is
 * built, and drops it when nobody listens. Call this at the top of the main
 * module; the routing layer drains it. Both schemes are kept because the
 * build kind is not known yet; the layer filters with the real one.
 */
export function bufferEarlyArtifactAppLaunches(app: OpenUrlEmitter): ArtifactAppEarlyLaunches {
  const schemes = [getDesktopScheme(false), getDesktopScheme(true)];
  let pending: string[] = [];
  const listener = (event: { preventDefault(): void }, url: string) => {
    if (!schemes.some((scheme) => parseArtifactAppLaunchUrl(url, scheme) !== null)) return;
    event.preventDefault();
    pending.push(url);
  };
  app.on("open-url", listener);
  return {
    take: () => {
      const taken = pending;
      pending = [];
      return taken;
    },
    dispose: () => {
      app.removeListener("open-url", listener);
    },
  };
}

const make = Effect.fnUntraced(function* (early: ArtifactAppEarlyLaunches) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const records = yield* ArtifactAppRecords.ArtifactAppRecords;
  const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
  const startArgv = yield* HostProcessArguments;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const scheme = getDesktopScheme(environment.isDevelopment);
  const mainWindowSeen = yield* Deferred.make<void>();

  // Latches open for good: a page opened after the main window was closed opens at once.
  const checkMainWindow = Effect.gen(function* () {
    if (Option.isSome(yield* electronWindow.main)) {
      yield* Deferred.succeed(mainWindowSeen, undefined);
    }
  });

  const launch = Effect.fn("desktop.artifactAppRouting.launch")(function* (
    source: ArtifactAppLaunchSource,
  ) {
    // A launch is itself a chance to notice the main window, so no single missed event strands it.
    yield* checkMainWindow;
    yield* Deferred.await(mainWindowSeen);
    const known = (yield* records.list).map((app) => app.installId);
    const installId = resolveArtifactAppLaunch({ source, scheme, knownInstallIds: known });
    if (installId === null) {
      yield* logInfo("ignored a launch for an install that is not recorded");
      return;
    }
    const result = yield* windows.open(installId);
    yield* logInfo("opened installed page from its launcher", { installId, result });
  });

  // A window is set as the main window after it is created and before its page finishes loading.
  yield* electronApp.on(
    "browser-window-created",
    (_event: unknown, window: Electron.BrowserWindow) => {
      window.webContents.once("did-finish-load", () => runFork(checkMainWindow));
    },
  );
  // A second signal: the main window being focused also releases launches held at start.
  yield* electronApp.on("browser-window-focus", () => runFork(checkMainWindow));
  yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
    if (parseArtifactAppLaunchUrl(url, scheme) === null) return;
    event.preventDefault();
    runFork(launch({ url }));
  });
  yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
    if (!Array.isArray(argv) || findArtifactAppLaunchInArgv(argv, scheme) === null) return;
    runFork(launch({ argv }));
  });

  for (const url of early.take()) runFork(launch({ url }));
  early.dispose();
  if (findArtifactAppLaunchInArgv(startArgv, scheme) !== null) {
    runFork(launch({ argv: startArgv }));
  }
  yield* checkMainWindow;
});

/** Registers the launch listeners; `early` is the buffer from `bufferEarlyArtifactAppLaunches`. */
export const layer = (early: ArtifactAppEarlyLaunches) => Layer.effectDiscard(make(early));
