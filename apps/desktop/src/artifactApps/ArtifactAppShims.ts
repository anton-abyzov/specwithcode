/**
 * Installed pages as their own macOS apps. Each launcher is a copy of Electron's
 * app shim loader; when it starts it connects to this app's shim server, and the
 * page's window is created inside it, so the Dock, app switcher and menu bar show
 * the page instead of SpecWithCode. Any process of this user can connect, so a
 * shim opens a window only when its bundle is an install's own launcher and the
 * running process has exactly the code hash that launcher was signed with.
 *
 * Also here: the per-page menu bar, pages reopened after a restart, launchers
 * upgraded at start, and the message for a shim that started after SpecWithCode
 * was updated on disk.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  ARTIFACT_APP_UNINSTALL_ACK_CHANNEL,
  ARTIFACT_APP_UNINSTALL_REQUEST_CHANNEL,
} from "../ipc/channels.ts";
import * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppShimRecords from "./ArtifactAppShimRecords.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-artifact-app-shims");

/** The code requirement a shim's running process must meet: its recorded code hash. */
export function artifactAppShimCodeRequirement(cdHash: string): string {
  if (!/^[0-9a-f]{40}$/.test(cdHash)) throw new Error("Invalid code hash.");
  return `cdhash H"${cdHash}"`;
}

/** What a shim that started after SpecWithCode was updated on disk tells the person. */
export function artifactAppVersionMismatchMessage(name: string): Electron.MessageBoxOptions {
  return {
    type: "info",
    message: `${name} could not open because SpecWithCode was updated.`,
    detail: `Quit and reopen SpecWithCode, then open ${name} again.`,
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  };
}

/**
 * The app menu's Uninstall confirm when the page cannot show its own: it is loading,
 * crashed or has no window. It opens as a sheet on the page's window when there is one.
 */
export function artifactAppUninstallConfirmation(name: string): Electron.MessageBoxOptions {
  return {
    type: "warning",
    message: `Uninstall ${name}?`,
    detail:
      "Its launcher is removed from this computer. The page stays in its thread, and you can install it again.",
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/** How long the page has to say it will show the Uninstall confirm itself. */
export const ARTIFACT_APP_UNINSTALL_ACK_WAIT = "1 second";

export interface ArtifactAppShimMenuActions {
  readonly showInFinder: () => void;
  /** Asks the page's window to show its uninstall confirm; nothing is removed here. */
  readonly uninstall: () => void;
}

/**
 * The page's own menu bar. Items with a role act on the shim: Quit quits the page's
 * app only, and About, Hide and Quit carry the page's name.
 */
export function artifactAppShimMenuTemplate(
  name: string,
  actions: ArtifactAppShimMenuActions,
): Array<Electron.MenuItemConstructorOptions> {
  return [
    {
      label: name,
      submenu: [
        { role: "about", label: `About ${name}` },
        { type: "separator" },
        { label: "Show App in Finder", click: actions.showInFinder },
        { label: `Uninstall ${name}…`, click: actions.uninstall },
        { type: "separator" },
        { role: "hide", label: `Hide ${name}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${name}` },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];
}

export class ArtifactAppShimServerStartError extends Schema.TaggedError<ArtifactAppShimServerStartError>()(
  "ArtifactAppShimServerStartError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The app shim server did not start.";
  }
}

/** The Electron calls this module makes, as a port so tests drive shims without Electron. */
export class ArtifactAppShimServer extends Context.Service<
  ArtifactAppShimServer,
  {
    readonly start: (name: string) => Effect.Effect<void, ArtifactAppShimServerStartError>;
    readonly onConnected: (
      listener: (shim: Electron.AppShimHost) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly onVersionMismatch: (
      listener: (bundlePath: string) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly setMenu: (
      shim: Electron.AppShimHost,
      template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
    ) => Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppShims/ArtifactAppShimServer") {}

const scopedAppListener = (event: string, listener: (...args: Array<any>) => void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Electron.app.on(event as any, listener);
    }),
    () =>
      Effect.sync(() => {
        Electron.app.removeListener(event as any, listener);
      }),
  ).pipe(Effect.asVoid);

export const layerElectronShimServer = Layer.succeed(
  ArtifactAppShimServer,
  ArtifactAppShimServer.of({
    start: (name) =>
      Effect.try({
        try: () => Electron.app.startAppShimServer({ name }),
        catch: (cause) => new ArtifactAppShimServerStartError({ cause }),
      }),
    onConnected: (listener) =>
      scopedAppListener("app-shim-connected", (_event, shim: Electron.AppShimHost) =>
        listener(shim),
      ),
    onVersionMismatch: (listener) =>
      scopedAppListener("app-shim-version-mismatch", (_event, bundlePath: string) =>
        listener(bundlePath),
      ),
    setMenu: (shim, template) =>
      Effect.sync(() => {
        shim.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
      }).pipe(Effect.ignoreCause({ log: true })),
  }),
);

const make = Effect.gen(function* () {
  const host = yield* ArtifactAppInstaller.ArtifactAppInstallerHost;
  if (host.platform !== "darwin" || Option.isNone(host.appShim)) return;
  const config = host.appShim.value;
  const server = yield* ArtifactAppShimServer;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const installer = yield* ArtifactAppInstaller.ArtifactAppInstaller;
  const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
  const records = yield* ArtifactAppRecords.ArtifactAppRecords;
  const shimRecords = yield* ArtifactAppShimRecords.ArtifactAppShimRecords;
  const desktopState = yield* DesktopState.DesktopState;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const mainWindowSeen = yield* Deferred.make<void>();
  const launchersReady = yield* Deferred.make<void>();
  // Hashes of shims rebuilt at this start: one already running when SpecWithCode was
  // started by it (or moved) still has the old hash and is still this install's.
  let replacedHashes: ReadonlyMap<string, string> = new Map();
  const mismatchShown = new Set<string>();

  // As for every launch: page windows wait for the main window (see ArtifactAppRouting).
  const checkMainWindow = Effect.gen(function* () {
    if (Option.isSome(yield* electronWindow.main)) {
      yield* Deferred.succeed(mainWindowSeen, undefined);
    }
  });
  yield* electronApp.on(
    "browser-window-created",
    (_event: unknown, window: Electron.BrowserWindow) => {
      window.webContents.once("did-finish-load", () => runFork(checkMainWindow));
    },
  );
  yield* electronApp.on("browser-window-focus", () => runFork(checkMainWindow));

  // The pages open in shims now, kept current so a crash still reopens them. The list is
  // written inside the window's close event, synchronously, so a page closed just before
  // quitting is never brought back by a write still waiting at exit. Once the app has
  // started to quit (the updater closes every window before before-quit), closing
  // windows no longer changes the list.
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const rememberOpenPages = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.shutdownBegun)) return;
    yield* shimRecords
      .writeReopen(yield* windows.shimInstallIds)
      .pipe(
        Effect.catchCause((cause) =>
          logWarning("reopen list not written", { cause: Cause.pretty(cause) }),
        ),
      );
  });
  yield* windows.onClosed(() => {
    try {
      runSync(rememberOpenPages);
    } catch {
      runFork(rememberOpenPages);
    }
  });

  const turnAway = (shim: Electron.AppShimHost, reason: string) =>
    Effect.gen(function* () {
      yield* logWarning("turned away an app shim", { reason, pid: shim.pid });
      shim.quit();
    });

  // The confirm shows inside the page's window: a native dialog from SpecWithCode, which
  // runs in the background here, could open behind the page. The page answers that it
  // will show it; a page that is loading, crashed or gone gets a native confirm instead,
  // as a sheet on its window when it has one.
  let lastUninstallRequest = 0;
  const askPage = (contents: Electron.WebContents) =>
    Effect.suspend(() => {
      const requestId = ++lastUninstallRequest;
      // Decided once: the page takes the confirm while this request waits, or it goes
      // native. A late answer is refused, so the page never opens a second confirm.
      let owner: "waiting" | "page" | "native" = "waiting";
      return Effect.callback<void>((resume) => {
        contents.ipc.removeHandler(ARTIFACT_APP_UNINSTALL_ACK_CHANNEL);
        contents.ipc.handle(ARTIFACT_APP_UNINSTALL_ACK_CHANNEL, (_event, id: unknown) => {
          if (owner !== "waiting" || id !== requestId) return false;
          owner = "page";
          resume(Effect.void);
          return true;
        });
        contents.send(ARTIFACT_APP_UNINSTALL_REQUEST_CHANNEL, requestId);
      }).pipe(
        Effect.timeoutOption(ARTIFACT_APP_UNINSTALL_ACK_WAIT),
        Effect.ensuring(
          Effect.sync(() => {
            if (owner === "waiting") owner = "native";
            contents.ipc.removeHandler(ARTIFACT_APP_UNINSTALL_ACK_CHANNEL);
          }),
        ),
        Effect.map(() => owner === "page"),
      );
    });

  // One question per page at a time: more clicks while it is asked add no second confirm.
  const uninstallAsking = new Set<string>();
  const askToUninstall = Effect.fn("desktop.artifactAppShims.askToUninstall")(function* (
    installId: string,
    shim: Electron.AppShimHost,
  ) {
    const usable = (found: Electron.BrowserWindow) =>
      !found.isDestroyed() && !found.webContents.isDestroyed();
    let window = yield* windows.windowForInstall(installId);
    if (!Option.exists(window, usable)) {
      // No page window: bring it back first, so the confirm has a window to sit on.
      yield* windows.open(installId, { appShim: shim });
      window = yield* windows.windowForInstall(installId);
    }
    const page = Option.filter(window, usable);
    if (Option.isSome(page)) {
      const contents = page.value.webContents;
      yield* Effect.sync(() => {
        if (page.value.isMinimized()) page.value.restore();
        page.value.show();
        page.value.focus();
      });
      const answered = yield* contents.isCrashed() ? Effect.succeed(false) : askPage(contents);
      if (answered) return;
    }
    const app = yield* records.get(installId);
    if (Option.isNone(app)) return;
    yield* logInfo("page did not show its uninstall confirm; asking natively", { installId });
    const choice = yield* host.showMessageBox(
      page,
      artifactAppUninstallConfirmation(app.value.name),
    );
    if (choice !== 0) return;
    yield* installer.uninstall(installId);
  });
  const requestUninstall = (installId: string, shim: Electron.AppShimHost) =>
    Effect.suspend(() => {
      if (uninstallAsking.has(installId)) return Effect.void;
      uninstallAsking.add(installId);
      return askToUninstall(installId, shim).pipe(
        Effect.ensuring(Effect.sync(() => uninstallAsking.delete(installId))),
      );
    });

  const connect = Effect.fn("desktop.artifactAppShims.connect")(function* (
    shim: Electron.AppShimHost,
  ) {
    yield* Deferred.await(launchersReady);
    yield* checkMainWindow;
    yield* Deferred.await(mainWindowSeen);
    if (!shim.isConnected()) return;
    const found = yield* installer.shimInstallFor(shim.bundlePath);
    if (Option.isNone(found)) return yield* turnAway(shim, "not an installed page");
    const { installId, cdHash } = found.value;
    const satisfies = (hash: string | undefined) => {
      if (hash === undefined) return false;
      try {
        return shim.satisfiesCodeRequirement(artifactAppShimCodeRequirement(hash));
      } catch {
        return false;
      }
    };
    const trusted = satisfies(cdHash) || satisfies(replacedHashes.get(installId));
    if (!trusted) return yield* turnAway(shim, "code hash differs from the installed launcher");
    const app = yield* records.get(installId);
    if (Option.isNone(app)) return yield* turnAway(shim, "install is no longer recorded");

    yield* server.setMenu(
      shim,
      artifactAppShimMenuTemplate(app.value.name, {
        showInFinder: () => runFork(installer.reveal(installId)),
        uninstall: () => runFork(requestUninstall(installId, shim)),
      }),
    );
    // Its Dock icon clicked, or its app opened again: the window comes forward or back.
    shim.on("activate", () => {
      runFork(windows.open(installId, { appShim: shim }));
    });
    const result = yield* windows.open(installId, { appShim: shim });
    yield* logInfo("opened installed page in its app shim", { installId, result });
    // A shim with no window (the window cap, say) would be a Dock icon with nothing in it.
    if (result !== "opened" && result !== "focused") {
      shim.quit();
      return;
    }
    yield* rememberOpenPages;
  });

  const versionMismatch = Effect.fn("desktop.artifactAppShims.versionMismatch")(function* (
    bundlePath: string,
  ) {
    if (mismatchShown.has(bundlePath)) return;
    mismatchShown.add(bundlePath);
    const found = yield* installer.shimInstallFor(bundlePath);
    if (Option.isNone(found)) return;
    const app = yield* records.get(found.value.installId);
    if (Option.isNone(app)) return;
    yield* host.showMessageBox(Option.none(), artifactAppVersionMismatchMessage(app.value.name));
  });

  yield* server.onConnected((shim) =>
    runFork(
      connect(shim).pipe(
        Effect.catchCause((cause) =>
          logWarning("app shim connection failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.andThen(Effect.sync(() => shim.quit())),
          ),
        ),
      ),
    ),
  );
  yield* server.onVersionMismatch((bundlePath) =>
    runFork(versionMismatch(bundlePath).pipe(Effect.ignoreCause({ log: true }))),
  );

  const start = Effect.gen(function* () {
    yield* electronApp.whenReady;
    yield* server.start(config.serverName);
    yield* logInfo("app shim server started", { name: config.serverName });
    // Launchers are rebuilt for this app before any shim is checked against them.
    replacedHashes = yield* installer.upgradeLaunchers;
    yield* Deferred.succeed(launchersReady, undefined);
    yield* checkMainWindow;
    yield* Deferred.await(mainWindowSeen);
    for (const installId of yield* shimRecords.takeReopen) {
      yield* installer.launch(installId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("app shim server did not start; new installs get script launchers", {
        cause: Cause.pretty(cause),
      }).pipe(
        Effect.andThen(installer.disableShims),
        Effect.andThen(Deferred.succeed(launchersReady, undefined)),
      ),
    ),
  );
  yield* Effect.forkScoped(start);
});

/** Starts the shim server on macOS when this build can make shim launchers; nothing elsewhere. */
export const layer = Layer.effectDiscard(make);
