import { useEffect, useRef, useState, type RefObject } from "react";
import type { EnvironmentId, FolderCopyStatus } from "@specweave-studio/contracts";
import { isAbortError, type PendingCopy } from "./handoffFolderCopyPending";
import { REPOSITORY_SETTLE_MS } from "./handoffFolderCopyRules";
import type { RepositoryChoices } from "./handoffCopySecrets";
import { messageOf } from "./useCoordinatorTransfer";

/** What a re-compare needs from the dialog, read when it runs: the dialog defines these later. */
export interface RepositoryReplanSteps {
  readonly latestPending: RefObject<PendingCopy | null>;
  readonly sendChoices: (
    environmentId: EnvironmentId,
    operationId: string,
    choices: RepositoryChoices,
  ) => Promise<void>;
  readonly pollCopy: (environmentId: EnvironmentId, operationId: string) => Promise<FolderCopyStatus>;
  readonly withoutReplaceAll: (saved: PendingCopy) => PendingCopy;
  readonly show: (next: FolderCopyStatus) => void;
  readonly setError: (message: string) => void;
}

/**
 * Clone and skip clicks on Review: they show at once and wait briefly, so several clicks
 * re-compare once. The preview stays on screen while the destination compares, with the
 * progress panel and Run in background; Copy waits for it. A click still waiting when the
 * dialog closes is sent then, so Run in background never drops it.
 */
export function useRepositoryReplan(steps: () => RepositoryReplanSteps) {
  const latest = useRef(steps);
  latest.current = steps;
  // Clone and skip choices not yet in the destination's plan, and whether it is re-comparing.
  const [choices, setChoices] = useState<RepositoryChoices | null>(null);
  const [replanning, setReplanning] = useState(false);
  const draft = useRef<RepositoryChoices | null>(null);
  const timer = useRef<number | null>(null);
  const sending = useRef(false);

  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    const { latestPending, sendChoices, pollCopy, withoutReplaceAll, show, setError } =
      latest.current();
    try {
      for (;;) {
        const sent = draft.current;
        const saved = latestPending.current;
        if (!sent || !saved) break;
        const environmentId = saved.environmentId as EnvironmentId;
        if (saved.replaceAll) withoutReplaceAll(saved);
        await sendChoices(environmentId, saved.operationId, sent);
        const next = await pollCopy(environmentId, saved.operationId);
        // Clicks made while comparing go out in one more round.
        if (draft.current !== sent) continue;
        draft.current = null;
        setChoices(null);
        if (next.state !== "previewed") show(next);
        break;
      }
    } catch (cause) {
      draft.current = null;
      setChoices(null);
      if (!isAbortError(cause)) setError(messageOf(cause));
    } finally {
      sending.current = false;
      if (timer.current === null) setReplanning(false);
    }
  };
  const latestSend = useRef(send);
  latestSend.current = send;

  const change = (next: RepositoryChoices) => {
    draft.current = next;
    setChoices(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void latestSend.current();
    }, REPOSITORY_SETTLE_MS);
    setReplanning(true);
  };

  useEffect(
    () => () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
      // Closed before the clicks settled: the destination still gets them.
      void latestSend.current();
    },
    [],
  );

  return { choices, replanning, draft, change };
}
