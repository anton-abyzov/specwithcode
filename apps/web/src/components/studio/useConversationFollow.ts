import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { noteReaderScroll, readerScrollAskedAt } from "../../lib/readerScroll";
import { isTimelineScrollTarget } from "../chat/timelineScrollTarget";

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

/**
 * How long after the reader's wheel, key or find a scroll is still theirs. A
 * trackpad keeps sending wheel events through its glide, so this only has to
 * cover the gap between the input and the scroll it causes.
 */
const READER_SCROLL_MS = 400;

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
 * Keeps a conversation at its end only while the reader is there. Only their
 * own upward scroll leaves it; anything else that moves the view (pictures,
 * expansions, a resized panel, the browser's scroll anchoring) keeps following.
 * A reply, a status line or a card that arrives while they read further up
 * leaves them where they are and marks the conversation as having something
 * new below; scrolling back to the end or `jumpToLatest` follows again. Their own message, named
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
    // The reader leaves the end only by moving up themselves: a wheel or
    // trackpad, the scrollbar, a dragged selection, middle-click autoscroll, a
    // finger, the keyboard, or a feature acting for them (find, a link to a
    // heading). Every other scroll away from the end is the browser's (scroll
    // anchoring, a picture or card loading, a resized panel, a row mounted or
    // dropped) and puts a following reader back at the end.
    // `holding`: the scrollbar or middle-click autoscroll, theirs until released
    // (autoscroll: until the next press). `pressed`: a mouse button down on a
    // message, theirs once it moves (a selection dragged past the edge).
    let holding: "scrollbar" | "autoscroll" | null = null;
    let pressed: "still" | "moved" | null = null;
    // Where a finger went down; one moving down scrolls the conversation up.
    let touchY: number | null = null;
    let fingerScrolling = false;
    // Any press, wheel or key ends middle-click autoscroll (or a middle click
    // that never started one); the press is heard before the scroller's own.
    const endAutoscroll = () => {
      if (holding === "autoscroll") holding = null;
    };
    const readerIsScrolling = () =>
      holding !== null ||
      pressed === "moved" ||
      fingerScrolling ||
      performance.now() - readerScrollAskedAt(scroller) < READER_SCROLL_MS;
    const onWheel = (event: WheelEvent) => {
      endAutoscroll();
      if (event.deltaY < 0 && !event.ctrlKey && isTimelineScrollTarget(event.target, scroller, -1))
        noteReaderScroll(scroller);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      endAutoscroll();
      const upward =
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey);
      if (!upward || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
        return;
      const target = event.target;
      if (
        target instanceof Node &&
        (scroller.contains(target) || target === document.body) &&
        !(target instanceof HTMLElement && target.isContentEditable) &&
        !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      )
        noteReaderScroll(scroller);
    };
    // Touch is read from touch events alone: its pointer events are cancelled
    // as soon as the browser takes the pan over.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      // A middle press on a link opens it in a tab; elsewhere it may start autoscroll.
      if (event.button === 1) {
        if (!(event.target instanceof Element && event.target.closest("a"))) holding = "autoscroll";
      }
      // Only the scrollbar (track, thumb, arrows) is the scroller itself; the
      // browser keeps its moves, so it counts from the press.
      else if (event.target === scroller) holding = "scrollbar";
      else pressed = "still";
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && pressed === "still") pressed = "moved";
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (holding === "scrollbar") holding = null;
      pressed = null;
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
      fingerScrolling = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && y - touchY >= 8) fingerScrolling = true;
    };
    // A fling keeps moving after the finger lifts: theirs from the lift on.
    const onTouchEnd = () => {
      if (fingerScrolling) noteReaderScroll(scroller);
      touchY = null;
      fingerScrolling = false;
    };

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
      if (conversationIsAtEnd(scroller)) {
        following.current = true;
        setUnseen(false);
      } else if (following.current && !readerIsScrolling()) {
        stickToEnd(scroller);
      } else {
        following.current = false;
      }
      setAway(!following.current);
      keepFrame ??= requestAnimationFrame(keepPlace);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", endAutoscroll, { capture: true, passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", endAutoscroll, { capture: true });
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
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
