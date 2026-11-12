import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";

/** A join older than this is not announced to a browser that never saw it. */
export const JOIN_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The joins a browser has not announced yet: later than the last one it showed,
 * recent, and of a machine still listed. Oldest first.
 */
export function accountJoinsToAnnounce(
  snapshot: Pick<StudioFleetSnapshot, "machines" | "accountJoins"> | null,
  seenUntil: string | null,
  now: number,
): NonNullable<StudioFleetSnapshot["accountJoins"]> {
  if (!snapshot?.accountJoins?.length) return [];
  const listed = new Set(snapshot.machines.map((machine) => machine.id));
  const seen = seenUntil === null ? Number.NaN : Date.parse(seenUntil);
  return snapshot.accountJoins
    .filter((entry) => {
      const at = Date.parse(entry.joinedAt);
      if (!Number.isFinite(at) || !listed.has(entry.id)) return false;
      if (Number.isFinite(seen) && at <= seen) return false;
      return now - at <= JOIN_NOTICE_WINDOW_MS;
    })
    .toSorted((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
}
