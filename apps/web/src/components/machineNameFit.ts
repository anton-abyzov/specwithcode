import { useLayoutEffect, useRef, useState } from "react";

/** A cut-off name showing fewer characters than this no longer tells machines apart. */
const MIN_VISIBLE_CHARACTERS = 4;

/**
 * True when a machine's name is cut off so far that it no longer names the
 * machine. The chip then hides its icon and name and shows the machine's short
 * label instead: never the icon alone (AC-27).
 */
export function machineNameTooNarrow(
  widths: { readonly visible: number; readonly full: number },
  length: number,
): boolean {
  if (widths.full <= widths.visible + 1) return false;
  if (length <= MIN_VISIBLE_CHARACTERS) return true;
  return (widths.visible / widths.full) * length < MIN_VISIBLE_CHARACTERS;
}

/**
 * Watches the element holding a machine's full name. The name stays in the
 * layout when the short label shows (only hidden), so the chip keeps the width
 * the row gave it and the choice cannot flip back and forth.
 */
export function useMachineNameFit<Element extends HTMLElement>(name: string) {
  const ref = useRef<Element>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const length = [...name].length;
    const check = () =>
      setCompact(
        machineNameTooNarrow({ visible: node.clientWidth, full: node.scrollWidth }, length),
      );
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [name]);
  return { ref, compact } as const;
}
