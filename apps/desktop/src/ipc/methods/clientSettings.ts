import { ClientSettingsSchema } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const encodeClientSettings = Schema.encodeEffect(ClientSettingsSchema);

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings, event) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    // Each app window keeps its own copy of the settings, so a change made in
    // one window is handed to the others. The window that made the change
    // already has it.
    const encoded = yield* encodeClientSettings(settings);
    for (const window of yield* electronWindow.appWindows) {
      yield* Effect.try(() => {
        if (window.isDestroyed() || window.webContents.id === event?.sender.id) return;
        window.webContents.send(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL, encoded);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not share client settings with a window", cause),
        ),
      );
    }
  }),
});
