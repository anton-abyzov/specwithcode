import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect, useRef } from "react";
import { modelPickerOlderVersionsKey, type ModelSearchHeader } from "./modelSearchGroups";

/**
 * Scrolls the older versions into view when a family opens, so a tap on a short phone
 * screen shows what it opened instead of rows below the fold.
 */
export function useRevealOlderVersions(
  listRef: RefObject<LegendListRef | null>,
  keys: readonly string[],
  headers: ReadonlyMap<string, ModelSearchHeader>,
  expanded: ReadonlySet<string>,
): void {
  const previous = useRef(expanded);
  useEffect(() => {
    const opened = [...expanded].filter((family) => !previous.current.has(family));
    previous.current = expanded;
    const family = opened[0];
    if (family === undefined) return;
    const start = keys.indexOf(modelPickerOlderVersionsKey(family));
    const index = keys.findIndex((key, i) => i > start && headers.get(key)?.older === true);
    if (start < 0 || index < 0) return;
    // Keep the last latest-version row above them for context; the list clamps at its end.
    const frame = requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex({ index: index - 1, viewPosition: 0, animated: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, headers, keys, listRef]);
}
