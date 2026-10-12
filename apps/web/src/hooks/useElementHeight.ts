import { useLayoutEffect, useState } from "react";

/**
 * Tracks an element's rendered height. Returns a callback ref and the height
 * (0 until the element mounts, and again after it unmounts).
 */
export function useElementHeight<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (!element) {
      setHeight(0);
      return;
    }

    const update = (nextHeight: number) => {
      const rounded = Math.max(0, Math.round(nextHeight));
      setHeight((current) => (current === rounded ? current : rounded));
    };

    update(element.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      update(element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, height] as const;
}
