import { ExternalBrowser, OpenInExternalBrowserInput } from "@specweave-studio/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ExternalBrowsers from "../../preview/ExternalBrowsers.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Installed Chromium-family browsers and their profiles, for "Open in…" menus. */
export const listExternalBrowsers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_EXTERNAL_BROWSERS_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Array(ExternalBrowser),
  handler: Effect.fn("desktop.ipc.externalBrowser.list")(function* () {
    const externalBrowsers = yield* ExternalBrowsers.ExternalBrowsers;
    return yield* externalBrowsers.list;
  }),
});

/**
 * Opens a URL in a named browser profile. The renderer only names a browser
 * and profile; main resolves both against what it found on disk.
 */
export const openInExternalBrowser = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_IN_EXTERNAL_BROWSER_CHANNEL,
  payload: OpenInExternalBrowserInput,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.externalBrowser.open")(function* (input) {
    const externalBrowsers = yield* ExternalBrowsers.ExternalBrowsers;
    return yield* externalBrowsers.open(input);
  }),
});

/**
 * Clears the clipboard when it still holds exactly the given text: a pairing
 * code copied for Chrome is cleared after use, never something copied since.
 */
export const clearClipboardIfText = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_CLIPBOARD_IF_TEXT_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(4096)),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.externalBrowser.clearClipboardIfText")(function* (text) {
    return yield* Effect.sync(() => {
      if (text === "" || Electron.clipboard.readText() !== text) return false;
      Electron.clipboard.clear();
      return true;
    });
  }),
});
