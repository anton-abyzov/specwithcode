import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What a screen reader hears when this page's answer reaches the agent. */
export const QUESTION_ANSWER_SENT = "Answer sent.";
/** What it hears when this page dismissed the question. */
export const QUESTION_DISMISSED = "Question dismissed.";
/** What it hears when the question settled without this page: another window, the agent, expiry. */
export const QUESTION_SETTLED_ELSEWHERE = "The question was answered or closed elsewhere.";

export interface LiveAnnouncement {
  readonly text: string;
  /** Changes on every announcement, so the same words are read again. */
  readonly key: number;
}

/** A polite announcement the page can update; render it with `QuestionLiveStatus`. */
export function useLiveAnnouncement() {
  const [announcement, setAnnouncement] = useState<LiveAnnouncement | null>(null);
  const announce = useCallback(
    (text: string) => setAnnouncement((current) => ({ text, key: (current?.key ?? 0) + 1 })),
    [],
  );
  return [announcement, announce] as const;
}

/** What the page knows about its own sends to the questions it shows. */
export interface QuestionSettleClaims {
  /** This page is sending or dismissing it: its settling is the page's own. */
  readonly claim: (requestId: string) => void;
  /** The host refused it outright: a later settle is someone else's. */
  readonly release: (requestId: string) => void;
  /**
   * The send's outcome is unknown, as when the connection dropped: once the
   * request settles, `outcome` names what happened, or null to say nothing.
   */
  readonly expect: (requestId: string, outcome: () => string | null) => void;
}

/**
 * Announces a pending question that settles without this page. Claim a request
 * before sending or dismissing it, so its settling is not read as someone
 * else's; release it when the host refused, so a later settle still is.
 *
 * `scope` names the conversation whose requests these are, or null while it is
 * not loaded. A new scope starts over silently: opening another thread, or a
 * projection still loading, settles nothing.
 */
export function useQuestionSettleAnnouncements(
  scope: string | null,
  pendingRequestIds: ReadonlyArray<string>,
  announce: (text: string) => void,
): QuestionSettleClaims {
  // By request: null for a plain claim, else what to say once it settles.
  const claimed = useRef(new Map<string, (() => string | null) | null>());
  const previous = useRef({ scope, ids: pendingRequestIds });
  const pendingKey = pendingRequestIds.join("\n");
  useEffect(() => {
    const pending = pendingKey.length === 0 ? [] : pendingKey.split("\n");
    const before = previous.current;
    previous.current = { scope, ids: pending };
    if (scope === null || before.scope !== scope) {
      claimed.current.clear();
      return;
    }
    for (const id of before.ids) {
      if (pending.includes(id)) continue;
      const claim = claimed.current.get(id);
      claimed.current.delete(id);
      const text = claim === undefined ? QUESTION_SETTLED_ELSEWHERE : (claim?.() ?? null);
      if (text !== null) announce(text);
    }
  }, [announce, pendingKey, scope]);
  const claim = useCallback((requestId: string) => {
    claimed.current.set(requestId, null);
  }, []);
  const release = useCallback((requestId: string) => {
    claimed.current.delete(requestId);
  }, []);
  const expect = useCallback((requestId: string, outcome: () => string | null) => {
    claimed.current.set(requestId, outcome);
  }, []);
  return useMemo(() => ({ claim, release, expect }), [claim, expect, release]);
}

/**
 * Always mounted beside the composer: a live region only reads changes made
 * after it is in the page, and the question card it reports on goes away.
 */
export function QuestionLiveStatus({
  announcement,
}: {
  readonly announcement: LiveAnnouncement | null;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-question-live-status
    >
      {announcement ? <span key={announcement.key}>{announcement.text}</span> : null}
    </p>
  );
}
