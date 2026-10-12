import { ExternalBrowser, OpenInExternalBrowserInput } from "@specweave-studio/contracts";
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
