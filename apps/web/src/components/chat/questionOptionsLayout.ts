import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/**
 * How a question card lays out its options' descriptions.
 * - "all": every description is open. Chosen when they all fit the card's
 *   scroll area, so hovering a row never resizes or scrolls the card.
 * - "compact": one line per option, opened on hover, focus or the details
 *   toggle. The fallback for a panel too short to show everything.
 * - "measure": a single pass with every description open, laid out but never
 *   painted, to pick between the two.
 */
export type QuestionOptionsLayout = "measure" | "all" | "compact";

const SETTLE_MS = 150;

/**
 * Picks the layout again only when the content changes (a new prompt, the
 * next question, the card reopening) or when the space for it does (the
 * scroll area's width or its height cap), never because a row opened.
 */
export function useQuestionOptionsLayout(
  cardRef: RefObject<HTMLElement | null>,
  contentKey: string,
): QuestionOptionsLayout {
  const [measured, setMeasured] = useState<{
    contentKey: string;
    space: string;
    stale: boolean;
    layout: Exclude<QuestionOptionsLayout, "measure">;
  } | null>(null);
  const layout: QuestionOptionsLayout =
    measured && !measured.stale && measured.contentKey === contentKey ? measured.layout : "measure";

  useLayoutEffect(() => {
    if (layout !== "measure") return;
    const viewport = viewportOf(cardRef.current);
    // No box to measure (not rendered, or a DOM without layout): stay compact.
    const fits =
      viewport !== null &&
      viewport.clientHeight > 0 &&
      viewport.scrollHeight <= viewport.clientHeight + 1;
    setMeasured({
      contentKey,
      space: spaceOf(viewport?.parentElement ?? null),
      stale: false,
      layout: fits ? "all" : "compact",
    });
  }, [cardRef, contentKey, layout]);

  // The scroll area's height follows its content, so only its width and its
  // height cap count as a change of space. Neither depends on the layout
  // picked, so a re-measure cannot set off another.
  useEffect(() => {
    const root = viewportOf(cardRef.current)?.parentElement ?? null;
    if (!root) return;
    let timer: number | null = null;
    const settle = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const space = spaceOf(root);
        setMeasured((current) =>
          current && !current.stale && current.space !== space
            ? { ...current, stale: true }
            : current,
        );
      }, SETTLE_MS);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
    observer?.observe(root);
    window.addEventListener("resize", settle);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("resize", settle);
    };
  }, [cardRef, contentKey]);

  return layout;
}

function viewportOf(element: HTMLElement | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-slot='scroll-area-viewport']") ?? null;
}

function spaceOf(root: HTMLElement | null): string {
  return root ? `${Math.round(root.clientWidth)}x${getComputedStyle(root).maxHeight}` : "";
}
