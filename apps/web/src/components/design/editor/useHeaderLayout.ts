import { useLayoutEffect, useState } from "react";

import { headerLayout, type HeaderLayout } from "./editorLayout";

const sameLayout = (left: HeaderLayout, right: HeaderLayout) =>
  left.tools === right.tools &&
  left.crumbs === right.crumbs &&
  left.saveLabel === right.saveLabel &&
  left.roomy === right.roomy;

/** The header's content width, without its padding (the native-controls and sidebar insets). */
const contentWidth = (element: HTMLElement) => {
  const style = getComputedStyle(element);
  return (
    element.getBoundingClientRect().width -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0)
  );
};

/**
 * What the editor header shows, measured from the header itself. State changes
 * only when a threshold is crossed, so the sidebar's padding animation does not
 * re-render the editor every frame.
 */
export function useHeaderLayout() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState(() => headerLayout(Number.POSITIVE_INFINITY));
  useLayoutEffect(() => {
    if (element === null) return;
    const update = (width: number) =>
      setLayout((current) => {
        const next = headerLayout(width);
        return sameLayout(current, next) ? current : next;
      });
    update(contentWidth(element));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, layout] as const;
}
