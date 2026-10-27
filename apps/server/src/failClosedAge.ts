/**
 * Age checks for anything that removes data once it is old enough. An unknown
 * time (unparsable text, a failed stat, no readings at all) must never read as
 * "old": `Date.parse("")` is NaN, a missing mtime mapped to 0 is 56 years ago,
 * and `Math.max()` of nothing is -Infinity. Each of these answers "not old".
 *
 * @module failClosedAge
 */

/**
 * Milliseconds from `at` to `now`, or null when either is not a finite time or
 * `at` is in the future (a clock that moved back says nothing about age).
 */
export function elapsedMs(at: number | null | undefined, now: number): number | null {
  if (at == null || !Number.isFinite(at) || !Number.isFinite(now)) return null;
  const elapsed = now - at;
  return elapsed >= 0 ? elapsed : null;
}

/**
 * True only when `at` is a known time at least `ageMs` before `now`. Unknown
 * times, future times and a non-finite `ageMs` are never old.
 */
export function olderThan(at: number | null | undefined, ageMs: number, now: number): boolean {
  if (!Number.isFinite(ageMs)) return false;
  const elapsed = elapsedMs(at, now);
  return elapsed !== null && elapsed >= ageMs;
}

/** The newest finite reading, or null when there is none. */
export function newestFinite(values: Iterable<number | null | undefined>): number | null {
  let newest: number | null = null;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    if (newest === null || value > newest) newest = value;
  }
  return newest;
}
