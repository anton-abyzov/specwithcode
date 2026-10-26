/**
 * Where the "New" divider goes in a thread: above the first message someone
 * other than the person wrote after they last read the thread. The watermark
 * is the thread's last visit as it stood when the person opened it, so the
 * divider stays put while they read, and does not move as the visit is recorded.
 *
 * Nothing is new on a thread never visited, where every message would be.
 * Once the person writes after the watermark they were here, so nothing after
 * their message counts as unread.
 */

interface DividerRow {
  readonly id: string;
  readonly kind: string;
  readonly message?: {
    readonly role: string;
    readonly createdBy?: string;
    readonly createdAt: string;
  };
}

export function firstUnreadRowId(
  rows: ReadonlyArray<DividerRow>,
  since: string | null | undefined,
): string | null {
  if (!since) return null;
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return null;
  for (const row of rows) {
    if (row.kind !== "message" || row.message === undefined) continue;
    const at = Date.parse(row.message.createdAt);
    if (Number.isNaN(at) || at <= sinceMs) continue;
    const ownMessage = row.message.role === "user" && row.message.createdBy !== "agent";
    return ownMessage ? null : row.id;
  }
  return null;
}
