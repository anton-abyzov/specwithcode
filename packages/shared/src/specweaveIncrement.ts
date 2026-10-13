/**
 * Ordering for SpecWeave increment folders (`0973-budget`, `10001-export`).
 * Folder numbers grow past 9999, so a plain string sort would put `10000-x`
 * before `9999-x`; these compare the leading number first.
 */

/** The number an increment folder starts with, or null when it starts with no digits. */
export function incrementNumber(name: string): number | null {
  const digits = /^\d+/.exec(name)?.[0];
  return digits === undefined ? null : Number(digits);
}

/** Oldest first: by leading number, then by name. Folders without a number sort first. */
export function compareIncrementFolders(left: string, right: string): number {
  const a = incrementNumber(left) ?? -1;
  const b = incrementNumber(right) ?? -1;
  if (a !== b) return a - b;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Newest first: the reverse of {@link compareIncrementFolders}. */
export function compareIncrementFoldersNewestFirst(left: string, right: string): number {
  return compareIncrementFolders(right, left);
}
