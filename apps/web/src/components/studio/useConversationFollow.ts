import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How close to the end, in pixels, still counts as reading the latest message.
 * Small enough that scrolling up a line or two to reread leaves the end.
 */
export const CONVERSATION_END_BAND_PX = 24;

export function conversationIsAtEnd(scroller: HTMLElement): boolean {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= CONVERSATION_END_BAND_PX
  );
}

function stickToEnd(scroller: HTMLElement): void {
  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
}

/**
 * Keeps a conversation at its end only while the reader is there. A reply, a
 * status line or a card that arrives while they read further up leaves them
 * where they are and marks the conversation as having something new below;
 * `jumpToLatest` takes them back and follows again. Their own message, named
 * by `ownSendKey`, always returns to the end. A new `resetKey` (another
 * conversation in the same scroller) opens at the end.
 */
export function useConversationFollow(
  scroller: HTMLElement | null,
  {
    contentKey,
    ownSendKey,
    resetKey,
  }: {
    /** Changes whenever something new arrives at the end. */
    readonly contentKey: string;
    /** The latest message the person sent here, or null. */
    readonly ownSendKey: string | null;
    readonly resetKey: string;
  },
): { readonly away: boolean; readonly unseen: boolean; readonly jumpToLatest: () => void } {
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  // Moving to the end fires a scroll event, which clears "away" and "unseen".
  const returnToEnd = useCallback(() => {
    following.current = true;
    if (scroller !== null) stickToEnd(scroller);
  }, [scroller]);

  // Opening a conversation lands at its end, before the first paint.
  const openedKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (scroller === null || openedKey.current === resetKey) return;
    openedKey.current = resetKey;
    returnToEnd();
  }, [returnToEnd, resetKey, scroller]);

  // The person's own message returns to the end; the first value is the history.
  const seenOwnSend = useRef(ownSendKey);
  useLayoutEffect(() => {
    if (seenOwnSend.current === ownSendKey) return;
    seenOwnSend.current = ownSendKey;
    if (ownSendKey !== null) returnToEnd();
  }, [returnToEnd, ownSendKey]);

  const seenContent = useRef(contentKey);
  useLayoutEffect(() => {
    if (seenContent.current === contentKey) return;
    seenContent.current = contentKey;
    if (following.current) {
      if (scroller !== null) stickToEnd(scroller);
    } else {
      setUnseen(true);
    }
  }, [contentKey, scroller]);

  useEffect(() => {
    if (scroller === null) return;
    // Only the reader's scrolling, or content shrinking under them, fires this:
    // growth below the viewport moves nothing, so it never breaks the follow.
    const onScroll = () => {
      const atEnd = conversationIsAtEnd(scroller);
      following.current = atEnd;
      setAway(!atEnd);
      if (atEnd) setUnseen(false);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller]);

  // Streaming text, a mounted card and a taller composer all resize without a
  // new message: follow them only while at the end.
  useEffect(() => {
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => {
      if (following.current) stickToEnd(scroller);
    });
    const observeChildren = () => {
      for (const child of scroller.children) resize.observe(child);
    };
    const children = new MutationObserver(observeChildren);
    resize.observe(scroller);
    observeChildren();
    children.observe(scroller, { childList: true });
    return () => {
      children.disconnect();
      resize.disconnect();
    };
  }, [scroller]);

  const jumpToLatest = useCallback(() => {
    setAway(false);
    setUnseen(false);
    returnToEnd();
  }, [returnToEnd]);

  return { away, unseen, jumpToLatest };
}
