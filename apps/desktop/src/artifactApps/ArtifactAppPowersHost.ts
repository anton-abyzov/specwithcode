/**
 * What an installed page's powers need from Electron and this computer: the
 * native notification, the tray, global shortcuts, window stacking, and the
 * folder this machine's own pages are published in. A port, so tests fake
 * every one of them; the app uses `layerElectron`.
 *
 * Every method answers "no" when Electron throws or refuses. None of them
 * decides whether a page may use a power: `ArtifactAppPowerService` does.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLocalService from "../backend/DesktopLocalService.ts";

export interface ArtifactAppLocalPages {
  /** This machine's own environment id. */
  readonly environmentId: string;
  /** The folder its published pages are files in. */
  readonly attachmentsDir: string;
}

export interface ArtifactAppTrayInput {
  readonly title: string | undefined;
  readonly tooltip: string;
  readonly items: ReadonlyArray<{ readonly label: string; readonly onClick: () => void }>;
  readonly openLabel: string;
  readonly closeLabel: string;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}

export interface ArtifactAppTrayHandle {
  readonly destroy: () => void;
}

export class ArtifactAppPowersHost extends Context.Service<
  ArtifactAppPowersHost,
  {
    readonly platform: NodeJS.Platform;
    /**
     * Where this machine's pages are, and which environment they belong to.
     * None when that cannot be read; a page from any other machine has no
     * file here and so no powers.
     */
    readonly localPages: Effect.Effect<Option.Option<ArtifactAppLocalPages>>;
    /** False when the system shows none. */
    readonly showNotification: (input: {
      readonly title: string;
      readonly body: string;
      readonly onClick: () => void;
    }) => Effect.Effect<boolean>;
    /** None when the desktop has no tray or the icon is missing. */
    readonly createTray: (
      input: ArtifactAppTrayInput,
    ) => Effect.Effect<Option.Option<ArtifactAppTrayHandle>>;
    /** False when the system or another app holds the accelerator. */
    readonly registerShortcut: (accelerator: string, onPress: () => void) => Effect.Effect<boolean>;
    readonly unregisterShortcut: (accelerator: string) => Effect.Effect<void>;
    /** Whether this app already holds the accelerator. True when that cannot be told. */
    readonly isShortcutRegistered: (accelerator: string) => Effect.Effect<boolean>;
    /** The accelerators of the app's own menu; none when they cannot be read. */
    readonly appAccelerators: Effect.Effect<Option.Option<ReadonlyArray<string>>>;
    /** False when the window is gone or the system refused. */
    readonly setAlwaysOnTop: (
      window: Electron.BrowserWindow,
      on: boolean,
    ) => Effect.Effect<boolean>;
    readonly sendToWindow: (
      window: Electron.BrowserWindow,
      channel: string,
      payload: unknown,
    ) => Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppPowersHost") {}

const TRAY_ICON_SIZE = 18;

function menuAccelerators(menu: Electron.Menu | null): ReadonlyArray<string> {
  const found: Array<string> = [];
  const visit = (items: ReadonlyArray<Electron.MenuItem>, depth: number) => {
    if (depth > 6) return;
    for (const item of items) {
      if (typeof item.accelerator === "string") found.push(item.accelerator);
      if (item.submenu) visit(item.submenu.items, depth + 1);
    }
  };
  if (menu !== null) visit(menu.items, 0);
  return found;
}

const makeElectron = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const fileSystem = yield* FileSystem.FileSystem;
  const localService = yield* DesktopLocalService.DesktopLocalService;
  const join = environment.path.join;

  // The service this app is attached to owns the pages; otherwise the app's own backend does.
  const localPages = Effect.gen(function* () {
    const attached = yield* localService.attached;
    const stateDir = Option.match(attached, {
      onNone: () => environment.stateDir,
      onSome: (service) => service.stateDir ?? join(service.baseDir, "userdata"),
    });
    // The id the server wrote for itself, read fresh: it is what a page's install names.
    const environmentId = (yield* fileSystem.readFileString(
      join(stateDir, "environment-id"),
    )).trim();
    if (environmentId.length === 0) return Option.none<ArtifactAppLocalPages>();
    if (Option.isSome(attached) && attached.value.descriptor.environmentId !== environmentId) {
      return Option.none<ArtifactAppLocalPages>();
    }
    return Option.some<ArtifactAppLocalPages>({
      environmentId,
      attachmentsDir: join(stateDir, "attachments"),
    });
  }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<ArtifactAppLocalPages>())));

  const iconPaths = yield* assets.iconPaths;
  const trayIconPath =
    environment.platform === "win32"
      ? Option.orElse(iconPaths.ico, () => iconPaths.png)
      : iconPaths.png;

  const attempt = <A>(fallback: A, run: () => A): Effect.Effect<A> =>
    Effect.sync(() => {
      try {
        return run();
      } catch {
        return fallback;
      }
    });

  return ArtifactAppPowersHost.of({
    platform: environment.platform,
    localPages,
    showNotification: (input) =>
      attempt(false, () => {
        if (!Electron.Notification.isSupported()) return false;
        const notification = new Electron.Notification({ title: input.title, body: input.body });
        notification.on("click", input.onClick);
        notification.show();
        return true;
      }),
    createTray: (input) =>
      attempt(Option.none<ArtifactAppTrayHandle>(), () => {
        if (Option.isNone(trayIconPath)) return Option.none<ArtifactAppTrayHandle>();
        const image = Electron.nativeImage.createFromPath(trayIconPath.value);
        if (image.isEmpty()) return Option.none<ArtifactAppTrayHandle>();
        const tray = new Electron.Tray(
          environment.platform === "win32"
            ? image
            : image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE }),
        );
        try {
          tray.setToolTip(input.tooltip);
          if (environment.platform === "darwin" && input.title !== undefined) {
            tray.setTitle(input.title);
          }
          tray.setContextMenu(
            Electron.Menu.buildFromTemplate([
              ...input.items.map((item) => ({ label: item.label, click: item.onClick })),
              ...(input.items.length > 0 ? [{ type: "separator" as const }] : []),
              { label: input.openLabel, click: input.onOpen },
              { label: input.closeLabel, click: input.onClose },
            ]),
          );
          // Windows opens the context menu on right click only; a left click opens the page.
          if (environment.platform === "win32") tray.on("click", input.onOpen);
        } catch (error) {
          if (!tray.isDestroyed()) tray.destroy();
          throw error;
        }
        return Option.some<ArtifactAppTrayHandle>({
          destroy: () => {
            try {
              if (!tray.isDestroyed()) tray.destroy();
            } catch {
              // Already gone.
            }
          },
        });
      }),
    registerShortcut: (accelerator, onPress) =>
      attempt(false, () => Electron.globalShortcut.register(accelerator, onPress)),
    unregisterShortcut: (accelerator) =>
      attempt(undefined, () => Electron.globalShortcut.unregister(accelerator)),
    isShortcutRegistered: (accelerator) =>
      attempt(true, () => Electron.globalShortcut.isRegistered(accelerator)),
    appAccelerators: attempt(Option.none<ReadonlyArray<string>>(), () =>
      Option.some(menuAccelerators(Electron.Menu.getApplicationMenu())),
    ),
    setAlwaysOnTop: (window, on) =>
      attempt(false, () => {
        if (window.isDestroyed()) return false;
        window.setAlwaysOnTop(on);
        return window.isAlwaysOnTop() === on;
      }),
    sendToWindow: (window, channel, payload) =>
      attempt(undefined, () => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(channel, payload);
        }
      }),
  });
});

/** The powers host backed by Electron and the app's own state folder. */
export const layerElectron = Layer.effect(ArtifactAppPowersHost, makeElectron);
