import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import { useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { requestAway } from "../../studio/awayRequest";
import { toastManager } from "../ui/toast";

const KEEP_AWAKE_REASK_MS = 30_000;
import {
  countLocalWorking,
  keepAwakeBatteryNotice,
  makeBatteryNoticeMemory,
} from "./keepAwake.logic";

interface BatteryManagerLike extends EventTarget {
  readonly level: number;
  readonly charging: boolean;
}

/**
 * The battery charge from 0 to 1 (null where the browser cannot read it) and
 * whether it charges. A change to either re-sends the report, so the desktop
 * app's answer follows an unplug.
 */
function useBattery(enabled: boolean): { level: number | null; charging: boolean | null } {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> })
      .getBattery;
    if (typeof getBattery !== "function") return;
    let battery: BatteryManagerLike | null = null;
    let disposed = false;
    const read = () => {
      if (battery === null) return;
      setLevel(battery.level);
      setCharging(battery.charging);
    };
    void getBattery
      .call(navigator)
      .then((manager) => {
        if (disposed) return;
        battery = manager;
        read();
        manager.addEventListener("levelchange", read);
        manager.addEventListener("chargingchange", read);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      battery?.removeEventListener("levelchange", read);
      battery?.removeEventListener("chargingchange", read);
    };
  }, [enabled]);
  // Whole percent steps, so a tiny drift does not re-send the report.
  return { level: level === null ? null : Math.round(level * 100) / 100, charging };
}

/**
 * Desktop only. Tells the app to hold off idle sleep while a session on this
 * machine is working and the battery choice allows it (1457). On battery it
 * says once per unplug what happens and offers Hand off; it never moves work
 * by itself.
 */
export function KeepAwakeWhileWorking() {
  const enabled = useClientSettings((settings) => settings.keepAwakeWhileWorking);
  const policy = useClientSettings((settings) => settings.keepAwakeOnBattery);
  const floorPercent = useClientSettings((settings) => settings.keepAwakeBatteryFloorPercent);
  const shells = useThreadShells(enabled);
  const ownEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const machine =
    environments.find((environment) => environment.environmentId === ownEnvironmentId)?.label ??
    "This computer";
  const { level: batteryLevel, charging } = useBattery(enabled);
  const working = useMemo(
    () =>
      enabled
        ? countLocalWorking(
            shells.map((thread) => ({
              environmentId: thread.environmentId,
              deletedAt: thread.deletedAt,
              archivedAt: thread.archivedAt,
              working: threadRuntimeIsActive(thread.runtime),
            })),
            ownEnvironmentId,
          )
        : 0,
    [enabled, ownEnvironmentId, shells],
  );
  // The answer remembers the count it was asked for, so a notice never pairs a
  // new count with an answer about the old one.
  const [power, setPower] = useState<{
    holding: boolean;
    onBattery: boolean;
    working: number;
  } | null>(null);
  const report = useMemo(
    () => ({
      active: working > 0,
      onBattery: policy,
      batteryFloorPercent: floorPercent,
      // Charging means a power adapter, where the level never matters; a
      // change of either re-sends, so the answer follows an unplug.
      batteryLevel: charging === true ? null : batteryLevel,
    }),
    [working, policy, floorPercent, batteryLevel, charging],
  );

  useEffect(() => {
    const bridge = window.desktopBridge;
    let current = true;
    // A re-send replaces this window's report; the hold is never dropped in
    // between, so a battery reading change does not restart it.
    const send = () => {
      void bridge
        ?.setKeepAwake?.(report)
        .then((state) => {
          if (current && state) setPower({ ...state, working });
        })
        .catch(() => undefined);
    };
    send();
    // While work runs, ask again now and then: the desktop app re-checks the
    // power source itself on unplug, and this is how the window learns of it
    // when the browser reports no battery events.
    const timer = working > 0 ? window.setInterval(send, KEEP_AWAKE_REASK_MS) : undefined;
    return () => {
      current = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [report, working]);

  // Let go when the window stops caring: the setting goes off or it unmounts.
  useEffect(() => {
    const bridge = window.desktopBridge;
    return () => {
      void bridge?.setKeepAwake?.({ active: false }).catch(() => undefined);
    };
  }, []);

  const memory = useRef(makeBatteryNoticeMemory());
  useEffect(() => {
    if (power === null || power.working !== working) return;
    if (!power.onBattery) {
      memory.current.pluggedIn();
      return;
    }
    const notice = keepAwakeBatteryNotice({
      onBattery: power.onBattery,
      holding: power.holding,
      working,
      machine,
    });
    if (notice === null || !memory.current.take(notice)) return;
    const id = toastManager.add({
      type: "info",
      title: notice.title,
      description: notice.description,
      timeout: 0,
      actionProps: {
        children: "Hand off…",
        onClick: () => {
          toastManager.close(id);
          requestAway("away");
        },
      },
    });
  }, [power, working, machine]);

  return null;
}
