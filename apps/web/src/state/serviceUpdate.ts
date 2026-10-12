import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

const INITIAL_READ_ATTEMPTS = 3;

/**
 * State of the Studio service's update agent on this computer, as the desktop
 * app reports it. Null outside the desktop app or before the first read.
 */
export function useStudioServiceUpdateState(): StudioServiceUpdateState | null {
  const [state, setState] = useState<StudioServiceUpdateState | null>(null);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    const getServiceUpdateState = bridge?.getServiceUpdateState;
    if (!bridge || !getServiceUpdateState) return;
    let active = true;
    let received = false;
    // The desktop only broadcasts changes, so a lost first read would hide a
    // waiting service update until the agent's state moves; retry it.
    const read = async () => {
      for (let attempt = 1; attempt <= INITIAL_READ_ATTEMPTS; attempt += 1) {
        if (!active) return;
        try {
          const value = await getServiceUpdateState();
          if (active && !received) setState(value);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    };
    void read();
    const unsubscribe = bridge.onServiceUpdateState?.((value) => {
      received = true;
      if (active) setState(value);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return state;
}
