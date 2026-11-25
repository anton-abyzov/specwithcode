/**
 * The guided tour host (1486): opens each step's page, waits for its target,
 * dims the rest and spotlights the target beside a small card with Back,
 * Next and Skip tour. It writes no setting and blocks clicks on the page, so
 * looking around changes nothing. Mounted once in the app shell.
 */
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTx } from "../../../i18n";
import { Button } from "../../ui/button";
import {
  backStepIndex,
  GUIDED_TOUR_BACK,
  GUIDED_TOUR_DONE,
  GUIDED_TOUR_NEXT,
  GUIDED_TOUR_SKIP,
  GUIDED_TOUR_STEP_COUNT,
  GUIDED_TOUR_STEPS,
  nextStepIndex,
  placeCard,
  type GuidedTourStep,
  type TourRect,
} from "./guidedTour.logic";
import { endGuidedTour, showGuidedTourStep, useGuidedTour } from "./guidedTourStore";

/** How long a step waits for its page to draw the target. */
export const TARGET_WAIT_MS = 3000;
const POLL_MS = 100;
const RING_PAD = 6;
const HIDING_ATTRIBUTES = ["aria-hidden", "inert", "data-base-ui-inert"] as const;

type Resolution =
  | { readonly kind: "waiting" }
  | { readonly kind: "found"; readonly element: Element; readonly match: number }
  | { readonly kind: "none" }
  | { readonly kind: "missing" };

function findTarget(step: GuidedTourStep): { element: Element; match: number } | null {
  for (const [match, selector] of step.targets.entries()) {
    const element = document.querySelector(selector);
    // Inside a collapsed section an element still has a box but is not drawn.
    const collapsed = element?.parentElement?.closest("details:not([open])");
    if (element && !collapsed && element.getClientRects().length > 0) return { element, match };
  }
  return null;
}

function rectOf(element: Element): TourRect {
  const { top, left, width, height } = element.getBoundingClientRect();
  return {
    top: top - RING_PAD,
    left: left - RING_PAD,
    width: width + 2 * RING_PAD,
    height: height + 2 * RING_PAD,
  };
}

const sameRect = (a: TourRect | null, b: TourRect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

/**
 * Whether the target needs scrolling back: none of it shows, or it fits the window and is
 * cut off. A target taller than the window stays as it is once part of it shows.
 */
const needsScroll = (rect: TourRect) => {
  const hidden =
    rect.top + rect.height <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left + rect.width <= 0 ||
    rect.left >= window.innerWidth;
  const fits = rect.height <= window.innerHeight && rect.width <= window.innerWidth;
  const cut =
    rect.top < 0 ||
    rect.left < 0 ||
    rect.top + rect.height > window.innerHeight ||
    rect.left + rect.width > window.innerWidth;
  return hidden || (fits && cut);
};

export function GuidedTourHost() {
  const tour = useGuidedTour();
  if (!tour.open) return null;
  return <GuidedTourOverlay index={tour.index} />;
}

function GuidedTourOverlay({ index }: { readonly index: number }) {
  const tx = useTx();
  const navigate = useNavigate();
  const router = useRouter();
  const titleId = useId();
  const bodyId = useId();
  const step = GUIDED_TOUR_STEPS[index]!;
  const total = GUIDED_TOUR_STEPS.length;
  const last = nextStepIndex(index, total) === null;
  const [resolution, setResolution] = useState<Resolution>({ kind: "waiting" });
  const [rect, setRect] = useState<TourRect | null>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 180 });
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  // Settings is a modal dialog that opens after the tour does. The last modal in the page is
  // the one assistive tech and focus treat as active, and it marks the rest hidden, so the
  // tour keeps its container last in the page and takes those marks straight back off.
  const [container] = useState(() => {
    const node = document.createElement("div");
    node.dataset.guidedTourRoot = "";
    return node;
  });
  useEffect(() => {
    const keepLast = () => {
      if (document.body.lastElementChild !== container) {
        const focused = container.contains(document.activeElement) ? document.activeElement : null;
        document.body.append(container);
        if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
      }
    };
    // A modal that opens while Next has focus takes the card for its trigger and hides the
    // card's other parts too; only the dim layer and the ring are meant to be hidden.
    const unhide = () => {
      for (const node of [container, ...container.querySelectorAll("*")])
        if (!(node instanceof HTMLElement && "guidedTourDecor" in node.dataset))
          for (const name of HIDING_ATTRIBUTES)
            if (node.hasAttribute(name)) node.removeAttribute(name);
    };
    keepLast();
    unhide();
    const bodyObserver = new MutationObserver(keepLast);
    bodyObserver.observe(document.body, { childList: true });
    const markObserver = new MutationObserver(unhide);
    markObserver.observe(container, {
      attributes: true,
      subtree: true,
      attributeFilter: [...HIDING_ATTRIBUTES],
    });
    return () => {
      bodyObserver.disconnect();
      markObserver.disconnect();
      container.remove();
    };
  }, [container]);

  // The tour replaces history entries as it goes, so Back afterwards skips its pages.
  const finish = useCallback(() => {
    const returnTo = endGuidedTour();
    router.history.replace(returnTo);
  }, [router]);
  const goNext = useCallback(() => {
    const next = nextStepIndex(index, total);
    if (next === null) finish();
    else showGuidedTourStep(next);
  }, [finish, index, total]);
  const goBack = useCallback(() => showGuidedTourStep(backStepIndex(index)), [index]);

  // Open the step's page, then wait for its target. `attempt` restarts this when something
  // other than the tour moves the page away from the step's route.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setResolution({ kind: "waiting" });
    setRect(null);
    if (window.location.pathname !== step.route) void navigate({ to: step.route, replace: true });
    if (step.targets.length === 0) {
      setResolution({ kind: "none" });
      return;
    }
    // The wait starts once the page is the step's own, not while it is still loading.
    let started: number | null = null;
    let best: number | null = null;
    let timer: number | undefined;
    const poll = () => {
      const onRoute = window.location.pathname === step.route;
      if (onRoute && started === null) started = Date.now();
      const found = onRoute ? findTarget(step) : null;
      // A stand-in (a later selector) can draw first; keep looking for the first one.
      if (found && (best === null || found.match < best)) {
        best = found.match;
        found.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        setResolution({ kind: "found", ...found });
        if (found.match === 0) return;
      }
      if (started !== null && Date.now() - started >= TARGET_WAIT_MS) {
        if (best === null) setResolution({ kind: step.required ? "missing" : "none" });
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    poll();
    return () => window.clearTimeout(timer);
  }, [navigate, step, attempt]);

  // Bring the step's page back if browser Back or a link outside the tour moved away.
  useEffect(() => {
    if (resolution.kind === "waiting") return;
    const check = window.setInterval(() => {
      if (window.location.pathname !== step.route) setAttempt((value) => value + 1);
    }, 250);
    return () => window.clearInterval(check);
  }, [resolution.kind, step.route]);

  // Follow the target while the page scrolls, resizes or redraws.
  useEffect(() => {
    if (resolution.kind !== "found") return;
    let frame = 0;
    let lastScroll = -Infinity;
    const tick = () => {
      const element = resolution.element.isConnected
        ? resolution.element
        : (findTarget(step)?.element ?? null);
      const next = element ? rectOf(element) : null;
      // A page that grows after the target drew can push it off screen; bring it back.
      // The dim layer takes the wheel, so this never fights the person's own scrolling.
      if (element && next && needsScroll(next) && performance.now() - lastScroll > 300) {
        lastScroll = performance.now();
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      }
      setRect((current) => (sameRect(current, next) ? current : next));
      setViewport((current) =>
        current.width === window.innerWidth && current.height === window.innerHeight
          ? current
          : { width: window.innerWidth, height: window.innerHeight },
      );
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [resolution, step]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    setCardSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  });

  // Focus Next once the step has settled.
  useEffect(() => {
    if (resolution.kind !== "waiting") nextRef.current?.focus({ preventScroll: true });
  }, [resolution.kind]);

  // While the tour is open every key belongs to it: app shortcuts, the command palette and
  // dialogs under it never see one, so looking around changes nothing (AC-04). Enter and
  // Space still press the focused tour button, because only propagation is stopped.
  useEffect(() => {
    const swallow = (event: KeyboardEvent) => {
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const onKey = (event: KeyboardEvent) => {
      swallow(event);
      const card = cardRef.current;
      const inCard = card !== null && event.target instanceof Node && card.contains(event.target);
      const buttons = [
        ...(card?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
      ];
      if (event.key === "Tab") {
        event.preventDefault();
        if (buttons.length === 0) return;
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const to = event.shiftKey
          ? at <= 0
            ? buttons.length - 1
            : at - 1
          : (at + 1) % buttons.length;
        buttons[to]!.focus();
        return;
      }
      const action =
        event.key === "Escape"
          ? finish
          : event.key === "ArrowRight"
            ? goNext
            : event.key === "ArrowLeft"
              ? goBack
              : null;
      if (action) {
        event.preventDefault();
        if (!event.repeat || event.key !== "Escape") action();
        return;
      }
      // Typing reaches nothing under the tour; Enter and Space only press a tour button.
      if (!inCard || (event.key !== "Enter" && event.key !== " ")) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", swallow, true);
    window.addEventListener("keypress", swallow, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", swallow, true);
      window.removeEventListener("keypress", swallow, true);
    };
  }, [finish, goBack, goNext]);

  const spotlit = resolution.kind === "found" ? rect : null;
  const placement = placeCard(spotlit, cardSize, viewport);
  const values = Object.fromEntries(
    Object.entries(step.labels ?? {}).map(([name, label]) => [name, tx(label)]),
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[200]"
      data-guided-tour-overlay=""
      data-tour-step={step.id}
      data-tour-target={resolution.kind}
      data-tour-match={resolution.kind === "found" ? resolution.match : undefined}
    >
      {/* Swallows clicks so the tour changes nothing on the page under it. */}
      <div
        className={spotlit ? "absolute inset-0" : "absolute inset-0 bg-black/55"}
        aria-hidden="true"
        data-guided-tour-decor=""
        onPointerDown={(event) => event.preventDefault()}
      />
      {spotlit ? (
        <div
          aria-hidden="true"
          data-guided-tour-decor=""
          data-guided-tour-spotlight=""
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary motion-safe:transition-[top,left,width,height] motion-safe:duration-200"
          style={{
            top: spotlit.top,
            left: spotlit.left,
            width: spotlit.width,
            height: spotlit.height,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)",
          }}
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-guided-tour-card=""
        data-side={placement.side}
        className="absolute flex w-[min(22.5rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
        style={{ top: placement.top, left: placement.left }}
      >
        <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
          {tx(GUIDED_TOUR_STEP_COUNT, { current: index + 1, total })}
        </p>
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            {tx(step.title)}
          </h2>
          <p id={bodyId} className="text-sm leading-relaxed break-words text-muted-foreground">
            {tx(step.body, values)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost-muted" onClick={finish}>
            {tx(GUIDED_TOUR_SKIP)}
          </Button>
          <span className="flex-1" />
          <Button type="button" size="sm" variant="outline" disabled={index === 0} onClick={goBack}>
            {tx(GUIDED_TOUR_BACK)}
          </Button>
          <Button ref={nextRef} type="button" size="sm" onClick={goNext}>
            {tx(last ? GUIDED_TOUR_DONE : GUIDED_TOUR_NEXT)}
          </Button>
        </div>
      </div>
    </div>,
    container,
  );
}
