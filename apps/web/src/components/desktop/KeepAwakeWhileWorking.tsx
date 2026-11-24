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
function useBattery(enabled: boolean): {
  level: number | null;
  charging: boolean | null;
  /** True once the reading is in, or known to be unavailable. */
  ready: boolean;
} {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> })
      .getBattery;
    if (typeof getBattery !== "function") {
      setReady(true);
      return;
    }
    let battery: BatteryManagerLike | null = null;
    let disposed = false;
    const read = () => {
      if (battery === null) return;
      setLevel(battery.level);
      setCharging(battery.charging);
      setReady(true);
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
      .catch(() => setReady(true));
    return () => {
      disposed = true;
      battery?.removeEventListener("levelchange", read);
      battery?.removeEventListener("chargingchange", read);
    };
  }, [enabled]);
  // Whole percent steps, so a tiny drift does not re-send the report.
  return { level: level === null ? null : Math.round(level * 100) / 100, charging, ready };
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
  const { level: batteryLevel, charging, ready: batteryReady } = useBattery(enabled);
  // Work counts only while this machine's own backend is connected: a backend
  // that went away leaves threads shown as running with nothing running.
  const ownConnected =
    environments.find((environment) => environment.environmentId === ownEnvironmentId)?.connection
      .phase === "connected";
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
            ownConnected ? ownEnvironmentId : null,
          )
        : 0,
    [enabled, ownConnected, ownEnvironmentId, shells],
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
      // Always the real level: the desktop app ignores it on a power adapter
      // and needs it the moment the machine is unplugged.
      batteryLevel,
      // A charging change re-sends, so the answer follows an unplug.
      charging,
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
    // Ask again now and then, idle too: the desktop app re-checks the power
    // source itself, and this is how the window learns of a plug-in or unplug
    // when the browser reports no battery events.
    const timer = window.setInterval(send, KEEP_AWAKE_REASK_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
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
  const shownToast = useRef<ReturnType<typeof toastManager.add> | null>(null);
  // One window speaks for the app: project windows stay quiet.
  const speaks = window.desktopBridge?.getWindowRole?.() !== "project";
  useEffect(() => {
    const closeShown = () => {
      if (shownToast.current !== null) toastManager.close(shownToast.current);
      shownToast.current = null;
    };
    if (power === null) return;
    // Any answer that says plugged in ends the battery session, whatever count it was for.
    if (!power.onBattery) {
      memory.current.pluggedIn();
      closeShown();
      return;
    }
    if (power.working !== working) return;
    if (working === 0) {
      closeShown();
      return;
    }
    // Wait for the battery reading, so a first answer made without it never
    // says the wrong thing.
    if (!speaks || !batteryReady) return;
    const notice = keepAwakeBatteryNotice({
      onBattery: power.onBattery,
      holding: power.holding,
      working,
      machine,
    });
    if (notice === null || !memory.current.take(notice)) return;
    closeShown();
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
    shownToast.current = id;
  }, [power, working, machine, speaks, batteryReady]);

  return null;
}
