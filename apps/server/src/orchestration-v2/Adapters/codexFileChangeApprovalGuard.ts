const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** A rejected update must never leave an earlier, narrower scope approvable. */
export function makeCodexFileChangeApprovalGuard() {
  const itemRevisions = new Map<string, Map<string, number | null>>();
  const rejectedItems = new Map<string, Set<string>>();
  const rejectedTurns = new Set<string>();
  const rejectedThreads = new Set<string>();
  let unidentifiedRejection = false;
  let revision = 0;

  return {
    record(turnId: string, itemId: string, valid: boolean) {
      const items = itemRevisions.get(turnId) ?? new Map<string, number | null>();
      items.set(itemId, valid ? ++revision : null);
      itemRevisions.set(turnId, items);
    },
    rejectNotification(method: string, params: unknown) {
      const payload = record(params);
      const item = record(payload?.item);
      const patchUpdate = method === "item/fileChange/patchUpdated";
      const threadId = id(payload?.threadId);
      const turnId = id(payload?.turnId);
      const itemId = id(patchUpdate ? payload?.itemId : item?.id);
      // A rejected payload may omit its discriminator and change list entirely.
      // Retain known file identities even when their latest revision is invalid.
      const knownFileItem =
        turnId !== undefined &&
        itemId !== undefined &&
        itemRevisions.get(turnId)?.has(itemId) === true;
      if (
        !patchUpdate &&
        !(
          (method === "item/started" || method === "item/completed") &&
          (knownFileItem || item?.type === "fileChange" || item?.changes !== undefined)
        )
      )
        return;

      if (turnId && itemId) {
        const items = rejectedItems.get(turnId) ?? new Set<string>();
        items.add(itemId);
        rejectedItems.set(turnId, items);
      } else if (turnId) rejectedTurns.add(turnId);
      else if (threadId) rejectedThreads.add(threadId);
      else unidentifiedRejection = true;
    },
    revision(input: { threadId: string; turnId: string; itemId: string }): number | null {
      if (
        unidentifiedRejection ||
        rejectedThreads.has(input.threadId) ||
        rejectedTurns.has(input.turnId) ||
        rejectedItems.get(input.turnId)?.has(input.itemId)
      )
        return null;
      return itemRevisions.get(input.turnId)?.get(input.itemId) ?? null;
    },
  };
}
