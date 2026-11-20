import { useSession } from "@clerk/react";
import { useEffect, useState } from "react";

import {
  type SessionEndStage,
  sessionEndRecheckMs,
  sessionEndStage,
} from "../../cloud/connectSessionEnd";

/** setTimeout fires at once past this many milliseconds. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Where this window's Connect sign-in is on its way to Clerk's end (1417,
 * AC-11). One timer to the next change; a sleeping machine stalls timers, so
 * focus and a visible window read the clock again.
 */
export function useConnectSessionEnd(): {
  readonly stage: SessionEndStage;
  readonly expireAt: number | null;
  readonly now: number;
} {
  const { session } = useSession();
  const expireAt = session?.expireAt?.getTime() ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const delay = sessionEndRecheckMs(expireAt, now);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [expireAt, now]);

  return { stage: sessionEndStage(expireAt, now), expireAt, now };
}
