/**
 * Whether a machine's last kept report can stand in for the shown days (1456):
 * it must start by the first shown day and reach it. Its end may fall before
 * today; the merge already flags a report built before the period ended.
 */
export function keptCoversStart(
  kept: { readonly sinceDay: string; readonly untilDay: string },
  sinceDay: string,
): boolean {
  return kept.sinceDay <= sinceDay && kept.untilDay >= sinceDay;
}
