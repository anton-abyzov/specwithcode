import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateInstallOptionsSchema,
  DesktopUpdateStateSchema,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { syncServiceAgentConfig } from "./serviceUpdates.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const state = yield* updates.setChannel(channel);
    // The service follows the same track as the app.
    yield* syncServiceAgentConfig();
    return state;
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.UndefinedOr(DesktopUpdateInstallOptionsSchema),
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* (options) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return options?.expectedVersion === undefined
      ? yield* updates.install
      : yield* updates.installPrepared(options.expectedVersion, {
          serviceLacksRelease: options.serviceLacksRelease === true,
        });
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});

/** Settings > General opened: check unless the last check is under a minute old. */
export const checkForUpdateIfStale = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_IF_STALE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.checkIfStale")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.checkIfStale("settings", {
      minAgeMs: DesktopUpdates.SETTINGS_CHECK_MIN_AGE_MS,
      retryMinAgeMs: DesktopUpdates.SETTINGS_CHECK_MIN_AGE_MS,
    });
  }),
});
