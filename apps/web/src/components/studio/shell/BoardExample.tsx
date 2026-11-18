/**
 * The example board beside the Board tab's explainer (1396 AC-14). It renders
 * the real groups and the real `BoardCard` over a sample module, so it never
 * drifts from the board. It is `inert` and hidden from assistive technology,
 * and carries the word "Example" on the board itself.
 *
 * It plays once, the first time it is seen in this app session: one card
 * moves from Planned to Active, to In review, to Done. It never loops, waits
 * while the tab is hidden, and is a still last frame under reduced motion and
 * whenever the board is stacked.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";

import {
  BOARD_GROUPS,
  BOARD_GROUPS_WIDE,
  BOARD_GROUP_LABELS,
  boardGroups,
} from "../../../studio/projectBoardModel";
import { BOARD_EXAMPLE_LABEL } from "../specweaveSetup.logic";
import { BoardCard } from "./BoardCard";
import { BoardGroupSection } from "./BoardGroupSection";
import { BOARD_COLUMNS_MIN_WIDTH } from "./BoardPane";
import {
  BOARD_EXAMPLE_FRAMES,
  BOARD_EXAMPLE_LAST_FRAME,
  BOARD_EXAMPLE_MOVER,
  BOARD_EXAMPLE_NOW,
  BOARD_EXAMPLE_STEP_MS,
  boardExampleFrame,
} from "./boardExample.sample";

/** It plays once per app session, however often the tab is opened. */
let playedThisSession = false;

/** Forget that the example played, as a new app session would. For tests and fixtures. */
export function resetBoardExamplePlay(): void {
  playedThisSession = false;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const noop = () => undefined;

export function BoardExample(props: {
  /** Names the layout instead of measuring (tests, fixtures). */
  readonly columns?: boolean | undefined;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (props.columns !== undefined || element === null) return;
    const measure = () => setMeasured(element.clientWidth >= BOARD_COLUMNS_MIN_WIDTH);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, props.columns]);
  const columns = props.columns ?? measured ?? false;
  const known = props.columns !== undefined || measured !== null;

  // Still on the last frame unless it may play: side by side, motion allowed,
  // and not yet played in this session.
  const [frame, setFrame] = useState(() =>
    playedThisSession || prefersReducedMotion() ? BOARD_EXAMPLE_LAST_FRAME : 0,
  );
  const still = !columns || prefersReducedMotion();
  const shownFrame = still ? BOARD_EXAMPLE_LAST_FRAME : frame;
  useEffect(() => {
    if (!known || still || frame >= BOARD_EXAMPLE_LAST_FRAME || element === null) return;
    let timer: number | undefined;
    let seen = false;
    const advance = () => {
      timer = undefined;
      // A hidden tab waits; the next frame comes when it is shown again.
      if (document.visibilityState !== "visible" || !seen) return;
      setFrame((current) => Math.min(BOARD_EXAMPLE_LAST_FRAME, current + 1));
    };
    const schedule = () => {
      if (timer === undefined && seen && document.visibilityState === "visible")
        timer = window.setTimeout(advance, BOARD_EXAMPLE_STEP_MS);
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            seen = entries.some((entry) => entry.isIntersecting);
            if (seen) schedule();
          });
    if (observer) observer.observe(element);
    else {
      seen = true;
      schedule();
    }
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [element, frame, known, still]);
  useEffect(() => {
    if (known && shownFrame === BOARD_EXAMPLE_LAST_FRAME && (frame > 0 || still))
      playedThisSession = true;
  }, [frame, known, shownFrame, still]);

  const sample = useMemo(() => boardExampleFrame(shownFrame), [shownFrame]);
  const groups = useMemo(() => boardGroups(sample.cards), [sample]);
  const order = columns ? BOARD_GROUPS_WIDE : BOARD_GROUPS;
  const viewId = useId();
  return (
    <div
      ref={setElement}
      className="sws-board-example"
      inert
      aria-hidden
      data-layout={columns ? "columns" : "stack"}
      data-frame={shownFrame}
      data-frames={BOARD_EXAMPLE_FRAMES}
    >
      <span className="sws-board-example-label">{BOARD_EXAMPLE_LABEL}</span>
      <div className="sws-board-columns" data-layout={columns ? "columns" : "stack"}>
        {order.map((group) => {
          const cards = groups[group];
          // No sample card is blocked, so no Blocked group shows.
          if (group === "blocked" && cards.length === 0) return null;
          return (
            <BoardGroupSection
              key={group}
              group={group}
              label={BOARD_GROUP_LABELS[group]}
              count={cards.length}
              folded={false}
              locked
              onToggle={noop}
            >
              <div className="sws-board-cards">
                {cards.map((entry) => (
                  <div
                    key={`${entry.incrementId}:${entry.incrementId === BOARD_EXAMPLE_MOVER ? shownFrame : ""}`}
                    className="sws-board-example-card"
                    data-moved={entry.incrementId === BOARD_EXAMPLE_MOVER && !still ? "" : undefined}
                  >
                    <BoardCard
                      card={entry}
                      open={false}
                      threads={sample.threads.get(entry.incrementId) ?? NO_THREADS}
                      threadsAnswered
                      multiMachine={false}
                      now={BOARD_EXAMPLE_NOW}
                      viewId={viewId}
                      onOpen={noop}
                      onOpenThread={noop}
                      onOpenLink={noop}
                    />
                  </div>
                ))}
              </div>
            </BoardGroupSection>
          );
        })}
      </div>
    </div>
  );
}

const NO_THREADS: ReadonlyArray<never> = [];
