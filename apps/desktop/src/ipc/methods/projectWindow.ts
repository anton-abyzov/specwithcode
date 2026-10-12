import { DesktopOpenProjectWindowInputSchema } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const openProjectWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_PROJECT_WINDOW_CHANNEL,
  payload: DesktopOpenProjectWindowInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.projectWindow.open")(function* (input) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.openProjectWindow(input);
  }),
});
