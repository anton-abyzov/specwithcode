import { graphemeLength } from "@specweave-studio/shared/machineShortLabel";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

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
  /** Leading characters that are not the name ("Runs on "): they don't count as shown. */
  prefix = 0,
): boolean {
  if (widths.full <= widths.visible + 1) return false;
  const nameLength = length - prefix;
  if (nameLength <= MIN_VISIBLE_CHARACTERS) return true;
  return (widths.visible / widths.full) * length - prefix < MIN_VISIBLE_CHARACTERS;
}

/**
 * Watches the element holding a machine's full name. The name stays in the
 * layout when the short label shows (only hidden), so the chip keeps the width
 * the row gave it and the choice cannot flip back and forth.
 */
export function useMachineNameFit<Element extends HTMLElement>(name: string, prefix = 0) {
  const ref = useRef<Element>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const length = graphemeLength(name);
    const check = () =>
      setCompact(
        machineNameTooNarrow({ visible: node.clientWidth, full: node.scrollWidth }, length, prefix),
      );
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [name, prefix]);
  return { ref, compact } as const;
}

/**
 * Sizes a machine chip for its short label: its minimum width, and the hidden
 * name's, leave room for every character (`index.css`, `[data-machine-short-chars]`).
 */
export function machineShortCharsProps(short: string): {
  readonly "data-machine-short-chars": "";
  readonly style: CSSProperties;
} {
  const chars = Math.min(3, Math.max(2, graphemeLength(short)));
  return {
    "data-machine-short-chars": "",
    style: { "--machine-short-chars": chars } as CSSProperties,
  };
}
