import {
  DEFAULT_KEEP_AWAKE_BATTERY_FLOOR_PERCENT,
  DEFAULT_KEEP_AWAKE_ON_BATTERY,
  KeepAwakeBatteryFloorPercent,
  KeepAwakeOnBattery,
  keepAwakeAllowedOnPower,
  type DesktopKeepAwakeState,
} from "@specweave-studio/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_KEEP_AWAKE_CHANNEL } from "../channels.ts";

const KeepAwakeReport = Schema.Struct({
  active: Schema.Boolean,
  onBattery: Schema.optional(KeepAwakeOnBattery),
  batteryFloorPercent: Schema.optional(KeepAwakeBatteryFloorPercent),
  batteryLevel: Schema.optional(Schema.NullOr(Schema.Number)),
});
const KeepAwakeState = Schema.Struct({ holding: Schema.Boolean, onBattery: Schema.Boolean });

export interface PowerBlocker {
  readonly start: () => number;
  readonly stop: (id: number) => void;
}

export interface KeepAwakeSenderReport {
  readonly active: boolean;
  readonly onBattery?: KeepAwakeOnBattery | undefined;
  readonly batteryFloorPercent?: number | undefined;
  readonly batteryLevel?: number | null | undefined;
}

/**
 * One idle-sleep blocker for the whole app, held while any window reports
 * working sessions and its battery choice allows it (1457). A window that
 * closes or crashes stops counting, so a stale report never keeps the machine
 * awake. The power source is this process's own reading, never the window's,
 * so unplugging releases the hold even when the window says nothing new.
 */
export function makeKeepAwakeController(
  blocker: PowerBlocker,
  isOnBattery: () => boolean = () => false,
) {
  const reports = new Map<number, KeepAwakeSenderReport>();
  let blockerId: number | null = null;
  const wanted = () => {
    const onBattery = isOnBattery();
    for (const report of reports.values()) {
      if (!report.active) continue;
      const allowed = keepAwakeAllowedOnPower(
        report.onBattery ?? DEFAULT_KEEP_AWAKE_ON_BATTERY,
        report.batteryFloorPercent ?? DEFAULT_KEEP_AWAKE_BATTERY_FLOOR_PERCENT,
        { onBattery, level: report.batteryLevel ?? null },
      );
      if (allowed) return true;
    }
    return false;
  };
  const sync = () => {
    const hold = wanted();
    if (hold && blockerId === null) {
      blockerId = blocker.start();
    } else if (!hold && blockerId !== null) {
      blocker.stop(blockerId);
      blockerId = null;
    }
  };
  const state = (): DesktopKeepAwakeState => ({
    holding: blockerId !== null,
    onBattery: isOnBattery(),
  });
  return {
    set: (sender: number, report: KeepAwakeSenderReport | boolean): DesktopKeepAwakeState => {
      const next = typeof report === "boolean" ? { active: report } : report;
      if (next.active) reports.set(sender, next);
      else reports.delete(sender);
      sync();
      return state();
    },
    release: (sender: number) => {
      reports.delete(sender);
      sync();
    },
    releaseAll: () => {
      reports.clear();
      sync();
    },
    /** Re-reads the power source, for on-battery and on-ac. */
    resync: sync,
    isBlocking: () => blockerId !== null,
  };
}

export const installKeepAwake = Effect.fn("desktop.ipc.installKeepAwake")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  // "prevent-app-suspension" keeps the system from idle sleep but lets the
  // display sleep; lid close still sleeps, which is the user's call.
  const controller = makeKeepAwakeController(
    {
      start: () => Electron.powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id) => {
        if (Electron.powerSaveBlocker.isStarted(id)) Electron.powerSaveBlocker.stop(id);
      },
    },
    () => Electron.powerMonitor.isOnBatteryPower(),
  );
  const resync = () => controller.resync();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      Electron.powerMonitor.on("on-battery", resync);
      Electron.powerMonitor.on("on-ac", resync);
    }),
    () =>
      Effect.sync(() => {
        Electron.powerMonitor.removeListener("on-battery", resync);
        Electron.powerMonitor.removeListener("on-ac", resync);
      }),
  );
  const watched = new Set<number>();
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_KEEP_AWAKE_CHANNEL,
      payload: KeepAwakeReport,
      result: KeepAwakeState,
      handler: (report, event) =>
        Effect.sync(() => {
          if (event === undefined) return { holding: controller.isBlocking(), onBattery: false };
          const senderId = event.sender.id;
          if (!watched.has(senderId)) {
            const contents = Electron.webContents.fromId(senderId);
            if (contents === undefined) {
              return { holding: controller.isBlocking(), onBattery: false };
            }
            watched.add(senderId);
            contents.once("destroyed", () => {
              watched.delete(senderId);
              controller.release(senderId);
            });
          }
          return controller.set(senderId, report);
        }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(controller.releaseAll));
});
