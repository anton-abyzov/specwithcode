import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@specweave-studio/contracts";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { setClientSettings } from "./clientSettings.ts";

const settings = { ...DEFAULT_CLIENT_SETTINGS, sendShortcut: "mod-enter" as const };
const encoded = Schema.encodeSync(ClientSettingsSchema)(settings);

const appWindow = (id: number, options: { destroyed?: boolean; failing?: boolean } = {}) => ({
  webContents: {
    id,
    send: vi.fn(() => {
      if (options.failing) throw new Error("Render frame was disposed");
    }),
  },
  isDestroyed: () => options.destroyed === true,
});

const layerWith = (
  windows: ReadonlyArray<ReturnType<typeof appWindow>>,
  configure: (configured: unknown) => void = () => {},
) =>
  Layer.mergeAll(
    DesktopClientSettings.layerTest(),
    Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
      configure: (configured: unknown) => Effect.sync(() => configure(configured)),
    } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      appWindows: Effect.sync(() => windows),
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
  );

describe("client settings IPC", () => {
  it.effect("hands saved settings to every app window except the one that saved them", () => {
    const main = appWindow(1);
    const sender = appWindow(2);
    const other = appWindow(3);
    const configured: unknown[] = [];
    return Effect.gen(function* () {
      yield* setClientSettings.handler(encoded, { sender: { id: 2 } });
      const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
      expect(Option.getOrNull(yield* clientSettings.get)).toEqual(settings);
      expect(configured).toEqual([settings]);
      expect(main.webContents.send.mock.calls).toEqual([
        ["desktop:client-settings-changed", encoded],
      ]);
      expect(other.webContents.send.mock.calls).toEqual([
        ["desktop:client-settings-changed", encoded],
      ]);
      expect(sender.webContents.send).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerWith([main, sender, other], (value) => configured.push(value))));
  });

  it.effect("hands them to every app window when no window is known to have saved them", () => {
    const main = appWindow(1);
    const project = appWindow(2);
    return Effect.gen(function* () {
      yield* setClientSettings.handler(encoded);
      expect(main.webContents.send).toHaveBeenCalledTimes(1);
      expect(project.webContents.send).toHaveBeenCalledWith(
        "desktop:client-settings-changed",
        encoded,
      );
    }).pipe(Effect.provide(layerWith([main, project])));
  });

  it.effect("skips a closed window and keeps going past one that cannot be reached", () => {
    const closed = appWindow(1, { destroyed: true });
    const unreachable = appWindow(2, { failing: true });
    const project = appWindow(3);
    return Effect.gen(function* () {
      yield* setClientSettings.handler(encoded, { sender: { id: 9 } });
      expect(closed.webContents.send).not.toHaveBeenCalled();
      expect(unreachable.webContents.send).toHaveBeenCalledTimes(1);
      expect(project.webContents.send).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerWith([closed, unreachable, project])));
  });
});
