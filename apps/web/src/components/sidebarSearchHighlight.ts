/**
 * The highlighted thread search result after the results reorder by themselves
 * (a thread changes section, server matches arrive): it stays on the same
 * thread, or on the same row when that thread left, never back at the top.
 * Resetting to the first result scrolled the list to the top while it was
 * being scrolled.
 */
export function followSearchHighlight(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  index: number,
): number {
  if (nextKeys.length === 0) return 0;
  const key = previousKeys[index];
  const kept = key === undefined ? -1 : nextKeys.indexOf(key);
  if (kept >= 0) return kept;
  return Math.min(Math.max(index, 0), nextKeys.length - 1);
}
