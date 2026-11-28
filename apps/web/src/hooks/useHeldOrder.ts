import { useState } from "react";

/**
 * `items` in the order they had when `keys` was taken: live rows keep their
 * place, new rows go at the end and rows that left drop out.
 */
export function holdOrder<T>(
  keys: readonly string[],
  items: readonly T[],
  keyOf: (item: T) => string,
): readonly T[] {
  const place = new Map(keys.map((key, index) => [key, index] as const));
  const kept: Array<{ readonly item: T; readonly index: number }> = [];
  const added: T[] = [];
  for (const item of items) {
    const index = place.get(keyOf(item));
    if (index === undefined) added.push(item);
    else kept.push({ item, index });
  }
  kept.sort((a, b) => a.index - b.index);
  return [...kept.map((entry) => entry.item), ...added];
}

/**
 * A list sorted by live data (recent activity) keeps its order while `held`
 * is true, so an open menu does not move rows under the pointer or scroll
 * the one being reached for out of view. It re-sorts when `held` ends.
 */
export function useHeldOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  held: boolean,
): readonly T[] {
  const [keys, setKeys] = useState<readonly string[] | null>(null);
  if (held && keys === null) setKeys(items.map(keyOf));
  else if (!held && keys !== null) setKeys(null);
  return held && keys !== null ? holdOrder(keys, items, keyOf) : items;
}
