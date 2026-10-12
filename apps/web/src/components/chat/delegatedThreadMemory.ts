/**
 * Remembers which threads were delegated (provider subagents and project
 * workers), so a thread's timeline keeps folding long reports while it is
 * still painted after the user has switched to another thread. Whether a
 * thread is delegated never changes, so a key, once seen, stays.
 */
const MAX_REMEMBERED = 500;
const delegatedThreadKeys = new Set<string>();

function remember(threadKey: string): void {
  if (delegatedThreadKeys.has(threadKey)) return;
  delegatedThreadKeys.add(threadKey);
  if (delegatedThreadKeys.size > MAX_REMEMBERED) {
    const oldest = delegatedThreadKeys.values().next().value;
    if (oldest !== undefined) delegatedThreadKeys.delete(oldest);
  }
}

/**
 * Whether the painted timeline folds long reports. While another thread's
 * timeline is still painted, the answer comes from that thread, not the
 * active one.
 */
export function resolveCollapseLongReports(input: {
  readonly displayThreadKey: string | null;
  readonly activeThreadKey: string | null;
  readonly activeIsDelegated: boolean;
  readonly paintOnly: boolean;
}): boolean {
  if (!input.paintOnly && input.activeIsDelegated) {
    if (input.activeThreadKey !== null) remember(input.activeThreadKey);
    return true;
  }
  const key = input.paintOnly ? input.displayThreadKey : input.activeThreadKey;
  return key !== null && delegatedThreadKeys.has(key);
}

export function resetDelegatedThreadMemoryForTests(): void {
  delegatedThreadKeys.clear();
}
