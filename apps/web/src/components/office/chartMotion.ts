import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/** True when the person asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function onReducedMotionChange(notify: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_MOTION);
  if (typeof media.addEventListener !== "function") return () => {};
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

/**
 * The same answer as `prefersReducedMotion`, kept current: a chart that is
 * moving when the person turns motion off stops at once.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion, () => false);
}

/** How long a mark waits before its entry, so a chart fills in over about 400 ms. */
export function entryDelay(index: number, count: number): string {
  const step = Math.min(34, 400 / Math.max(1, count));
  return `${Math.round(index * step)}ms`;
}

const REORDER_MS = 360;
const REORDER_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Glide the children of `container` that carry `data-motion-key` from where
 * they were to where they are now, whenever `order` changes: after a sort or a
 * filter the rows move instead of jumping. Does nothing when `enabled` is false.
 */
export function useReorderMotion(
  container: RefObject<HTMLElement | null>,
  order: string,
  enabled: boolean,
): void {
  const tops = useRef<Map<string, number> | null>(null);
  const running = useRef<Animation[]>([]);
  // Motion switched off, or the chart gone: nothing keeps gliding.
  useLayoutEffect(() => {
    if (enabled) return;
    for (const animation of running.current.splice(0)) animation.cancel?.();
  }, [enabled]);
  useEffect(
    () => () => {
      for (const animation of running.current.splice(0)) animation.cancel?.();
    },
    [],
  );
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || typeof element.querySelectorAll !== "function") return;
    const previous = tops.current;
    const next = new Map<string, number>();
    for (const child of element.querySelectorAll<HTMLElement>("[data-motion-key]")) {
      const key = child.dataset.motionKey;
      if (key === undefined) continue;
      const top = child.offsetTop;
      next.set(key, top);
      const before = previous?.get(key);
      if (
        enabled &&
        before !== undefined &&
        before !== top &&
        typeof child.animate === "function"
      ) {
        running.current = running.current.filter((animation) => animation.playState === "running");
        running.current.push(
          child.animate(
            [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }],
            { duration: REORDER_MS, easing: REORDER_EASE },
          ),
        );
      }
    }
    tops.current = next;
  }, [container, order, enabled]);
}

const COUNT_MS = 700;

/**
 * A number that counts from 0 up to `target` once, then follows `target` from
 * where it stands. Returns `target` at once when `enabled` is false or the page
 * cannot animate.
 */
export function useCountUp(target: number, enabled: boolean): number {
  const canAnimate =
    enabled &&
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function" &&
    typeof performance !== "undefined";
  const [shown, setShown] = useState(canAnimate ? 0 : target);
  const from = useRef(canAnimate ? 0 : target);
  useEffect(() => {
    if (!canAnimate) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = from.current;
    if (start === target) return;
    const began = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - began) / COUNT_MS);
      // Ease out: fast at first, settling on the figure.
      const eased = 1 - (1 - progress) ** 4;
      const value = progress >= 1 ? target : start + (target - start) * eased;
      from.current = value;
      setShown(value);
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [canAnimate, target]);
  return canAnimate ? shown : target;
}
