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

/** Marks a row the reader's place can be kept by; the value names it across renders. */
export const FOLLOW_ANCHOR_ATTRIBUTE = "data-follow-anchor";

/**
 * Where the reader was in a conversation: at its end, or at a row and how far
 * its top sat from the conversation's top.
 */
type ReadingPlace =
  | { readonly following: true }
  | { readonly following: false; readonly anchor: string | null; readonly offset: number };

/**
 * Each conversation's last place, by `resetKey`, kept for the page's lifetime:
 * a project page left for another is hidden (`display: none` loses every scroll
 * offset under it) or, after enough others, unmounted.
 */
const readingPlaces = new Map<string, ReadingPlace>();

/** Forgets every kept place, as a fresh page load would (tests share one module). */
export function forgetReadingPlaces(): void {
  readingPlaces.clear();
}

/** A hidden scroller (under `display: none`) has no box and reads as scrolled to the top. */
function isShown(scroller: HTMLElement): boolean {
  return scroller.isConnected && scroller.clientHeight > 0;
}

function readPlace(scroller: HTMLElement, following: boolean): ReadingPlace {
  if (following || conversationIsAtEnd(scroller)) return { following: true };
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>(`[${FOLLOW_ANCHOR_ATTRIBUTE}]`)) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top)
      return {
        following: false,
        anchor: row.getAttribute(FOLLOW_ANCHOR_ATTRIBUTE),
        offset: box.top - top,
      };
  }
  return { following: false, anchor: null, offset: scroller.scrollTop };
}

/** Puts the reader back at `place`; false while the row it names is not mounted. */
function returnToPlace(scroller: HTMLElement, place: ReadingPlace): boolean {
  if (place.following) {
    stickToEnd(scroller);
    return true;
  }
  if (place.anchor === null) {
    scroller.scrollTop = place.offset;
    return true;
  }
  const row = scroller.querySelector(`[${FOLLOW_ANCHOR_ATTRIBUTE}="${CSS.escape(place.anchor)}"]`);
  if (row === null) return false;
  scroller.scrollTop +=
    row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - place.offset;
  return true;
}

/**
 * Keeps a conversation at its end only while the reader is there. A reply, a
 * status line or a card that arrives while they read further up leaves them
 * where they are and marks the conversation as having something new below;
 * `jumpToLatest` takes them back and follows again. Their own message, named
 * by `ownSendKey`, always returns to the end. A new `resetKey` (another
 * conversation in the same scroller) opens at the end the first time.
 *
 * Leaving the conversation (its project page hidden for another, or unmounted)
 * keeps the reader's place under `resetKey`, by the `data-follow-anchor` row at
 * the top of the view; coming back returns to it, or to the end if they were
 * following it.
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

  // A place left for another page or project waits here until its row is mounted.
  const pendingPlace = useRef<ReadingPlace | null>(null);
  const restore = useCallback(() => {
    const place = pendingPlace.current;
    if (scroller === null || place === null || !isShown(scroller)) return;
    if (!returnToPlace(scroller, place)) {
      // The history arrives after the page: wait for it. With it in and the row gone, follow.
      if (scroller.querySelector(`[${FOLLOW_ANCHOR_ATTRIBUTE}]`) === null) return;
      stickToEnd(scroller);
    }
    pendingPlace.current = null;
    following.current = place.following || conversationIsAtEnd(scroller);
    setAway(!following.current);
  }, [scroller]);

  // Opening a conversation lands at its end, or where the reader left it, before
  // the first paint. Showing a hidden page runs this again, as does a new scroller.
  const openedKey = useRef<string | null>(null);
  // What was at the end when last seen; another conversation starts from its own.
  const seenContent = useRef(contentKey);
  const latestContent = useRef(contentKey);
  latestContent.current = contentKey;
  useLayoutEffect(() => {
    if (scroller === null) return;
    if (openedKey.current !== resetKey) {
      openedKey.current = resetKey;
      seenContent.current = latestContent.current;
      setUnseen(false);
      setAway(false);
      pendingPlace.current = readingPlaces.get(resetKey) ?? null;
      if (pendingPlace.current === null) returnToEnd();
      else following.current = pendingPlace.current.following;
    } else {
      pendingPlace.current ??= readingPlaces.get(resetKey) ?? null;
    }
    restore();
  }, [restore, returnToEnd, resetKey, scroller]);

  // The person's own message returns to the end; the first value is the history.
  const seenOwnSend = useRef(ownSendKey);
  useLayoutEffect(() => {
    if (seenOwnSend.current === ownSendKey) return;
    seenOwnSend.current = ownSendKey;
    if (ownSendKey !== null) returnToEnd();
  }, [returnToEnd, ownSendKey]);

  useLayoutEffect(() => {
    if (seenContent.current === contentKey) return;
    seenContent.current = contentKey;
    if (pendingPlace.current !== null) {
      // The history the reader's place waited for; nothing new to them.
      restore();
    } else if (following.current) {
      if (scroller !== null) stickToEnd(scroller);
    } else {
      setUnseen(true);
    }
  }, [contentKey, restore, scroller]);

  useEffect(() => {
    if (scroller === null) return;
    // Only the reader's scrolling, or content shrinking under them, fires this:
    // growth below the viewport moves nothing, so it never breaks the follow.
    // Kept as it changes, once a frame, not read on the way out: the page being
    // hidden then shares the window with the page replacing it, and reads squeezed.
    let keepFrame: number | null = null;
    const keepPlace = () => {
      keepFrame = null;
      if (isShown(scroller) && pendingPlace.current === null)
        readingPlaces.set(resetKey, readPlace(scroller, following.current));
    };
    const onScroll = () => {
      // Hidden, it reads as the top and the end at once: not the reader's doing.
      if (!isShown(scroller)) return;
      const atEnd = conversationIsAtEnd(scroller);
      following.current = atEnd;
      setAway(!atEnd);
      if (atEnd) setUnseen(false);
      keepFrame ??= requestAnimationFrame(keepPlace);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (keepFrame !== null) cancelAnimationFrame(keepFrame);
    };
  }, [resetKey, scroller]);

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
