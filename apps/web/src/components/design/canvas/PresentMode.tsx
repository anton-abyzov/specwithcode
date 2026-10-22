import type { DesignDocument, DesignNode, DesignPage } from "@specweave-studio/contracts";
import { ChevronLeftIcon, ChevronRightIcon, PresentationIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "~/components/ui/button";
import { FrameStage } from "./FrameStage";
import { artboards } from "./geometry";
import { PresenterView } from "./PresenterView";

/** Every artboard of every page that is not skipped, in page and paint order. */
export function presentationFrames(
  document: DesignDocument,
): { page: DesignPage; frame: DesignNode }[] {
  return document.pages
    .filter((page) => page.skipped !== true)
    .flatMap((page) => artboards(page).map((frame) => ({ page, frame })));
}

/** How long typed digits wait for the next digit ("1", "2" jumps to 12). */
const DIGIT_WINDOW_MS = 900;

export type PresentKeyAction =
  | { kind: "go"; index: number }
  | { kind: "close" }
  | { kind: "fullscreen" }
  | { kind: "presenter" }
  | { kind: "digits"; digits: string; index: number };

/**
 * What a key does in present mode, as a pure function of the key, the
 * current position and the digits typed just before. Arrows, Space, Page Up
 * and Down, Home and End move; number keys jump (typed digits accumulate);
 * F is full screen; P switches the presenter view; Esc leaves.
 */
export function presentKeyAction(
  key: string,
  state: { index: number; count: number; digits: string },
): PresentKeyAction | null {
  const clamp = (index: number) => Math.max(0, Math.min(state.count - 1, index));
  if (key === "Escape") return { kind: "close" };
  if (key === "ArrowRight" || key === "ArrowDown" || key === " " || key === "PageDown")
    return { kind: "go", index: clamp(state.index + 1) };
  if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp" || key === "Backspace")
    return { kind: "go", index: clamp(state.index - 1) };
  if (key === "Home") return { kind: "go", index: 0 };
  if (key === "End") return { kind: "go", index: clamp(state.count - 1) };
  if (/^[0-9]$/.test(key)) {
    const typed = state.digits + key;
    const number = Number(typed);
    // A longer number than the deck has starts over from this digit.
    const digits = number >= 1 && number <= state.count ? typed : key;
    const target = Number(digits);
    return {
      kind: "digits",
      digits,
      index: target >= 1 && target <= state.count ? target - 1 : state.index,
    };
  }
  if (key === "Enter") return { kind: "go", index: clamp(state.index + 1) };
  if (key === "f" || key === "F") return { kind: "fullscreen" };
  if (key === "p" || key === "P") return { kind: "presenter" };
  return null;
}

/**
 * Makes everything on the page except `dialog` inert, so Tab and the screen
 * reader stay in the presentation; returns the undo. Elements that were
 * already inert stay inert.
 */
export function makeBackgroundInert(dialog: HTMLElement | null): () => void {
  if (dialog === null) return () => undefined;
  const changed = [...globalThis.document.body.children].filter(
    (element) => element !== dialog && !element.hasAttribute("inert"),
  );
  for (const element of changed) element.setAttribute("inert", "");
  return () => {
    for (const element of changed) element.removeAttribute("inert");
  };
}

/**
 * Full-screen presentation of the frames (slides skip skipped pages), with a
 * presenter view that adds the next slide, the notes and a timer.
 */
export function PresentMode({
  document,
  startFrameId,
  presenter: startPresenter = false,
  onClose,
}: {
  document: DesignDocument;
  startFrameId: string | null;
  /** Open in the presenter view. */
  presenter?: boolean;
  onClose: () => void;
}) {
  const frames = useMemo(() => presentationFrames(document), [document]);
  const slides = document.kind === "slides";
  const noun = slides ? "slide" : "frame";
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      frames.findIndex((item) => item.frame.id === startFrameId),
    ),
  );
  const [presenter, setPresenter] = useState(startPresenter);
  const digits = useRef({ value: "", at: 0 });
  const root = useRef<HTMLDivElement>(null);
  const position = Math.min(index, frames.length - 1);
  const current = frames[position];
  const next = frames[position + 1];

  const go = useCallback(
    (target: number) => setIndex(Math.max(0, Math.min(frames.length - 1, target))),
    [frames.length],
  );

  useEffect(() => {
    // Read before moving focus, so leaving returns it to the Present button.
    const previous = globalThis.document.activeElement;
    const restore = makeBackgroundInert(root.current);
    root.current?.focus();
    return () => {
      if (globalThis.document.fullscreenElement)
        void globalThis.document.exitFullscreen?.().catch(() => undefined);
      restore();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKey = (key: string) => {
    const now = Date.now();
    const typed = now - digits.current.at < DIGIT_WINDOW_MS ? digits.current.value : "";
    const action = presentKeyAction(key, {
      index: position,
      count: frames.length,
      digits: typed,
    });
    if (action === null) return false;
    if (action.kind !== "digits") digits.current = { value: "", at: 0 };
    switch (action.kind) {
      case "close":
        onClose();
        break;
      case "go":
        go(action.index);
        break;
      case "digits":
        digits.current = { value: action.digits, at: now };
        go(action.index);
        break;
      case "fullscreen":
        if (!globalThis.document.fullscreenElement)
          void root.current?.requestFullscreen?.().catch(() => undefined);
        else void globalThis.document.exitFullscreen?.().catch(() => undefined);
        break;
      case "presenter":
        setPresenter((value) => !value);
        break;
    }
    return true;
  };

  // Portaled to the body: the page's isolated stacking context would otherwise let the app
  // sidebar paint over the presentation.
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={presenter ? "Presenter view" : "Present"}
      tabIndex={-1}
      data-testid="present-mode"
      data-presenter={presenter ? "true" : undefined}
      className="fixed inset-0 z-[100] flex flex-col bg-black text-white outline-none"
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (
          event.target instanceof HTMLButtonElement &&
          (event.key === " " || event.key === "Enter")
        )
          return;
        if (onKey(event.key)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {current === undefined ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-sm text-white/60">
            {slides
              ? "Every slide is skipped. Show a slide from its menu, then present again."
              : "This design has no frames to present. Add a frame (F), then present again."}
          </p>
        </div>
      ) : presenter ? (
        <PresenterView current={current} next={next} noun={noun} />
      ) : (
        <FrameStage key={current.frame.id} page={current.page} frame={current.frame} fade />
      )}
      <div className="flex items-center gap-2 px-4 pb-3 text-xs text-white/60">
        <Button
          variant="media-close"
          size="icon-sm"
          aria-label={`Previous ${noun}`}
          disabled={position <= 0}
          onClick={() => go(position - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="tabular-nums" aria-live="polite" data-testid="present-position">
          {frames.length === 0 ? "0 / 0" : `${position + 1} / ${frames.length}`}
        </span>
        {current !== undefined && label(current.frame.name, slides) !== null && (
          <span className="truncate">{label(current.frame.name, slides)}</span>
        )}
        <Button
          variant="media-close"
          size="icon-sm"
          aria-label={`Next ${noun}`}
          disabled={position >= frames.length - 1}
          onClick={() => go(position + 1)}
        >
          <ChevronRightIcon />
        </Button>
        <span className="ml-auto hidden sm:inline">
          Arrows to move, P for presenter view, F for full screen, Esc to leave
        </span>
        <Button
          variant="media-close"
          size="icon-sm"
          aria-label={presenter ? "Leave presenter view" : "Presenter view"}
          aria-pressed={presenter}
          className="ml-auto sm:ml-0"
          onClick={() => setPresenter((value) => !value)}
        >
          <PresentationIcon />
        </Button>
        <Button
          variant="media-close"
          size="icon-sm"
          aria-label="Leave present mode"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
    </div>,
    globalThis.document.body,
  );
}

/** The frame's name, except a generated "Slide N" that no longer matches the slide's place. */
function label(name: string | undefined, slides: boolean) {
  if (slides) return name === undefined || /^Slide \d+$/.test(name) ? null : name;
  return name ?? "Frame";
}
