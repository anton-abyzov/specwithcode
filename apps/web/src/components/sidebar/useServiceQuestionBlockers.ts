import type { ServiceUpdateBlocker, StudioServiceUpdateRun } from "@specweave-studio/contracts";
import { useEffect, useRef, useState } from "react";

import { callPrepare, onServiceUpdateLook, QUICK_CALL_MS } from "../serviceUpdateCalls";

/** How often a waiting run asks the service what still runs. */
export const QUESTION_BLOCKER_POLL_MS = 30_000;
/**
 * How often a window asks while an automatic install waits for quiet, which
 * can last hours: only while the window is shown, and once when it is shown again.
 */
export const AUTOMATIC_WAIT_POLL_MS = 120_000;
/**
 * How soon after the live shell shows a thread start or stop waiting on the
 * person the service is asked again, so a burst of changes asks once.
 */
export const LIVE_CHANGE_LOOK_MS = 1_000;

/** The page's document, when there is one that reports being shown (not in every runtime). */
const pageDocument = (): Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
> | null =>
  typeof document === "undefined" || typeof document.addEventListener !== "function"
    ? null
    : document;
const windowHidden = () => pageDocument()?.visibilityState === "hidden";

const NONE: ReadonlyArray<ServiceUpdateBlocker> = [];

/**
 * What keeps a live run, or an automatic install waiting for quiet
 * (`automaticWait`, 0991), from installing, so the toast and the sidebar name
 * the threads whose questions it waits on. Only reads: it never stops work.
 * `liveWaitingKey` (`waitingKey`) changes when the live shell shows a thread
 * start or stop waiting on the person; the service is then asked again at once.
 */
export function useServiceQuestionBlockers(
  run: StudioServiceUpdateRun | null,
  automaticWait = false,
  liveWaitingKey: string | null = null,
): ReadonlyArray<ServiceUpdateBlocker> {
  const [blockers, setBlockers] = useState<ReadonlyArray<ServiceUpdateBlocker>>(NONE);
  const waiting =
    (run === null && automaticWait) ||
    (run !== null &&
      !run.terminal &&
      (run.phase === "requested" || run.phase === "waiting" || run.phase === "preparing"));
  const runLooks = run !== null;
  useEffect(() => {
    if (!waiting) {
      setBlockers(NONE);
      return;
    }
    let active = true;
    // Any look this window makes (its own, a press's) says it too.
    const stopHearing = onServiceUpdateLook((found) => {
      if (active) setBlockers(found);
    });
    // A run asks at once; an automatic wait already has the window's own look
    // as it adopts the agent's state. A run asks again every
    // QUESTION_BLOCKER_POLL_MS. An automatic wait, which can last hours, asks
    // every AUTOMATIC_WAIT_POLL_MS and only while this window is shown (and
    // once when it is shown again), so a question asked after the automatic
    // install began waiting shows too without every window asking all along.
    const look = () => void callPrepare({ stopWork: false }, QUICK_CALL_MS);
    if (runLooks) look();
    const tick = () => {
      if (!runLooks && windowHidden()) return;
      look();
    };
    const timer = window.setInterval(
      tick,
      runLooks ? QUESTION_BLOCKER_POLL_MS : AUTOMATIC_WAIT_POLL_MS,
    );
    const shown = () => {
      if (!windowHidden()) look();
    };
    const shownDocument = runLooks ? null : pageDocument();
    shownDocument?.addEventListener("visibilitychange", shown);
    return () => {
      active = false;
      stopHearing();
      window.clearInterval(timer);
      shownDocument?.removeEventListener("visibilitychange", shown);
    };
  }, [runLooks, waiting]);
  const lastKey = useRef(liveWaitingKey);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = liveWaitingKey;
    if (!waiting || liveWaitingKey === null || previous === null || previous === liveWaitingKey)
      return;
    const timer = window.setTimeout(() => {
      if (!runLooks && windowHidden()) return;
      void callPrepare({ stopWork: false }, QUICK_CALL_MS);
    }, LIVE_CHANGE_LOOK_MS);
    return () => window.clearTimeout(timer);
  }, [liveWaitingKey, runLooks, waiting]);
  return blockers;
}
