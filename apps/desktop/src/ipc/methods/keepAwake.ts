import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_KEEP_AWAKE_CHANNEL } from "../channels.ts";

const KeepAwakeState = Schema.Struct({ active: Schema.Boolean });

export interface PowerBlocker {
  readonly start: () => number;
  readonly stop: (id: number) => void;
}

/**
 * One idle-sleep blocker for the whole app, held while any window reports
 * working sessions. A window that closes or crashes stops counting, so a
 * stale report never keeps the machine awake.
 */
export function makeKeepAwakeController(blocker: PowerBlocker) {
  const active = new Set<number>();
  let blockerId: number | null = null;
  const sync = () => {
    if (active.size > 0 && blockerId === null) {
      blockerId = blocker.start();
    } else if (active.size === 0 && blockerId !== null) {
      blocker.stop(blockerId);
      blockerId = null;
    }
  };
  return {
    set: (sender: number, isActive: boolean) => {
      if (isActive) active.add(sender);
      else active.delete(sender);
      sync();
    },
    release: (sender: number) => {
      active.delete(sender);
      sync();
    },
    releaseAll: () => {
      active.clear();
      sync();
    },
    isBlocking: () => blockerId !== null,
  };
}

export const installKeepAwake = Effect.fn("desktop.ipc.installKeepAwake")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  // "prevent-app-suspension" keeps the system from idle sleep but lets the
  // display sleep; lid close still sleeps, which is the user's call.
  const controller = makeKeepAwakeController({
    start: () => Electron.powerSaveBlocker.start("prevent-app-suspension"),
    stop: (id) => {
      if (Electron.powerSaveBlocker.isStarted(id)) Electron.powerSaveBlocker.stop(id);
    },
  });
  const watched = new Set<number>();
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_KEEP_AWAKE_CHANNEL,
      payload: KeepAwakeState,
      result: Schema.Void,
      handler: ({ active }, event) =>
        Effect.sync(() => {
          if (event === undefined) return;
          const senderId = event.sender.id;
          if (!watched.has(senderId)) {
            const contents = Electron.webContents.fromId(senderId);
            if (contents === undefined) return;
            watched.add(senderId);
            contents.once("destroyed", () => {
              watched.delete(senderId);
              controller.release(senderId);
            });
          }
          controller.set(senderId, active);
        }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(controller.releaseAll));
});
