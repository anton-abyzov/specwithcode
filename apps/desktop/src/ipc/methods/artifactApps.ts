import {
  DesktopArtifactAppInstallInputSchema,
  DesktopArtifactAppInstallResultSchema,
  DesktopArtifactAppSchema,
  DesktopArtifactAppUninstallInputSchema,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ArtifactAppInstaller from "../../artifactApps/ArtifactAppInstaller.ts";
import * as ArtifactAppRecords from "../../artifactApps/ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "../../artifactApps/ArtifactAppWindows.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installArtifactApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALL_ARTIFACT_APP_CHANNEL,
  payload: DesktopArtifactAppInstallInputSchema,
  result: DesktopArtifactAppInstallResultSchema,
  handler: Effect.fn("desktop.ipc.artifactApps.install")(function* (input, event) {
    const installer = yield* ArtifactAppInstaller.ArtifactAppInstaller;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // The confirmation attaches to the window that asked.
    const owner =
      event === undefined
        ? Option.none()
        : yield* electronWindow.appWindowForWebContents(event.sender.id);
    return yield* installer.install(input, { owner });
  }),
});

export const uninstallArtifactApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UNINSTALL_ARTIFACT_APP_CHANNEL,
  payload: DesktopArtifactAppUninstallInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.artifactApps.uninstall")(function* (input) {
    const installer = yield* ArtifactAppInstaller.ArtifactAppInstaller;
    return yield* installer.uninstall(input.installId);
  }),
});

export const revealArtifactApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_ARTIFACT_APP_CHANNEL,
  payload: DesktopArtifactAppUninstallInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.artifactApps.reveal")(function* (input) {
    const installer = yield* ArtifactAppInstaller.ArtifactAppInstaller;
    return yield* installer.reveal(input.installId);
  }),
});

export const listArtifactApps = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_ARTIFACT_APPS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopArtifactAppSchema),
  handler: Effect.fn("desktop.ipc.artifactApps.list")(function* () {
    const records = yield* ArtifactAppRecords.ArtifactAppRecords;
    return yield* records.list;
  }),
});

/** The install the calling window shows; null for any window that is not an installed page. */
export const getArtifactApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_ARTIFACT_APP_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopArtifactAppSchema),
  handler: Effect.fn("desktop.ipc.artifactApps.get")(function* (_, event) {
    if (event === undefined) return null;
    const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
    const records = yield* ArtifactAppRecords.ArtifactAppRecords;
    const installId = yield* windows.installIdForWebContents(event.sender.id);
    if (Option.isNone(installId)) return null;
    return Option.getOrNull(yield* records.get(installId.value));
  }),
});
