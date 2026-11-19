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
 * Picks the layout again only when the content changes (a new prompt or the
 * next question) or when the space for it does (the scroll area's width or its
 * height cap, which follows the thread panel), never because a row opened.
 * Folding and reopening the card keeps the layout it had, so the fold's own
 * height animation measures the card as it will be shown.
 */
export function useQuestionOptionsLayout(
  cardRef: RefObject<HTMLElement | null>,
  folded: boolean,
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
    // No box to measure (folded, or a DOM without layout): compact for now,
    // with no space recorded, so the first real box picks again.
    const measurable = viewport !== null && viewport.clientHeight > 0;
    const fits = measurable && viewport.scrollHeight <= viewport.clientHeight + 1;
    setMeasured({
      contentKey,
      space: measurable ? spaceOf(viewport.parentElement) : "",
      stale: false,
      layout: fits ? "all" : "compact",
    });
  }, [cardRef, contentKey, layout]);

  // The scroll area's height follows its content, so only its width and its
  // height cap count as a change of space. Neither depends on the layout
  // picked, so a re-measure cannot set off another. The cap comes from
  // `--chat-panel-height`, set in an ancestor's style, which can change with
  // no resize of the scroll area or the window.
  useEffect(() => {
    const root = viewportOf(cardRef.current)?.parentElement ?? null;
    if (!root) return;
    let timer: number | null = null;
    const recheck = () => {
      const space = spaceOf(root);
      setMeasured((current) =>
        current && !current.stale && current.space !== space
          ? { ...current, stale: true }
          : current,
      );
    };
    const settle = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        recheck();
      }, SETTLE_MS);
    };
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
    resizes?.observe(root);
    const styles = typeof MutationObserver === "undefined" ? null : new MutationObserver(settle);
    for (let element = root.parentElement; element; element = element.parentElement) {
      styles?.observe(element, { attributes: true, attributeFilter: ["style"] });
    }
    window.addEventListener("resize", settle);
    // Text measured in a fallback font changes height once the web font lands.
    let live = true;
    if (typeof document !== "undefined" && document.fonts?.status === "loading") {
      void document.fonts.ready.then(() => {
        if (!live) return;
        setMeasured((current) => (current && !current.stale ? { ...current, stale: true } : current));
      });
    }
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
      resizes?.disconnect();
      styles?.disconnect();
      window.removeEventListener("resize", settle);
    };
  }, [cardRef, contentKey, folded]);

  return layout;
}

function viewportOf(element: HTMLElement | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-slot='scroll-area-viewport']") ?? null;
}

function spaceOf(root: HTMLElement | null): string {
  return root ? `${Math.round(root.clientWidth)}x${getComputedStyle(root).maxHeight}` : "";
}
