import * as Context from "effect/Context";

import * as Electron from "electron";

export interface ElectronTrayInput {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly openLabel: string;
  readonly quitLabel: string;
  readonly onOpen: () => void;
  readonly onQuit: () => void;
}

export interface ElectronTrayHandle {
  readonly destroy: () => void;
}

export type ElectronTrayFactory = (input: ElectronTrayInput) => ElectronTrayHandle;

const createElectronTray: ElectronTrayFactory = (input) => {
  const tray = new Electron.Tray(input.iconPath);
  tray.setToolTip(input.tooltip);
  tray.setContextMenu(
    Electron.Menu.buildFromTemplate([
      { label: input.openLabel, click: input.onOpen },
      { type: "separator" },
      { label: input.quitLabel, click: input.onQuit },
    ]),
  );
  // Windows opens the context menu on right click only; a left click opens the app.
  tray.on("click", input.onOpen);
  return {
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
};

/** Creates the notification-area icon; tests replace it. Call only after the app is ready. */
export const ElectronTray = Context.Reference<ElectronTrayFactory>(
  "@specweave-studio/desktop/electron/ElectronTray",
  { defaultValue: () => createElectronTray },
);
