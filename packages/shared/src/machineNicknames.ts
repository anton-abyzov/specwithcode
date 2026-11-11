import {
  MACHINE_COLOR_IDS,
  MACHINE_NICKNAME_MAX_LENGTH,
  type MachineColorId,
  type MachineNickname,
  type MachineNicknames,
} from "@specweave-studio/contracts";
import { DateTime } from "effect";

/** Trims, collapses inner whitespace and caps a typed name at 16 characters. */
export function normalizeMachineNickname(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MACHINE_NICKNAME_MAX_LENGTH).trim();
}

const stamp = (entry: MachineNickname): number => {
  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const identityOf = (entry: MachineNickname) => `${entry.color ?? ""}\u0000${entry.icon ?? ""}`;

/**
 * Last writer wins. Equal stamps fall back to the name, then to the color and
 * icon, so every machine picks the same entry whichever order the changes
 * arrive in.
 *
 * A color or icon is never dropped by a merge: the winner keeps its own, and
 * takes the other entry's where it states none. A paired machine on an older
 * build decodes an entry without them and sends it back stripped; that copy
 * (same stamp, or a newer rename made there) must not erase what was chosen.
 * Choosing the default again writes it out, so "absent" only ever means "not
 * stated".
 */
export function newerMachineNickname(
  current: MachineNickname | undefined,
  incoming: MachineNickname | undefined,
): MachineNickname | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  const difference = stamp(incoming) - stamp(current);
  const incomingWins =
    difference !== 0
      ? difference > 0
      : incoming.name !== current.name
        ? incoming.name > current.name
        : identityOf(incoming) > identityOf(current);
  const [winner, other] = incomingWins ? [incoming, current] : [current, incoming];
  const color = winner.color ?? other.color;
  const icon = winner.icon ?? other.icon;
  if (color === winner.color && icon === winner.icon) return winner;
  return {
    ...winner,
    ...(color === undefined ? {} : { color }),
    ...(icon === undefined ? {} : { icon }),
  };
}

export function mergeMachineNicknames(
  current: MachineNicknames,
  incoming: MachineNicknames | undefined,
): MachineNicknames {
  if (incoming === undefined) return current;
  let merged: Record<string, MachineNickname> | null = null;
  for (const [environmentId, entry] of Object.entries(incoming)) {
    const existing = current[environmentId];
    const winner = newerMachineNickname(existing, entry);
    if (winner === existing) continue;
    merged ??= { ...current };
    merged[environmentId] = winner!;
  }
  return merged ?? current;
}

export function sameMachineNicknames(a: MachineNicknames, b: MachineNicknames): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      b[key]?.name === a[key]!.name &&
      b[key]?.updatedAt === a[key]!.updatedAt &&
      b[key]?.color === a[key]!.color &&
      b[key]?.icon === a[key]!.icon,
  );
}

/** A stable small hash of a machine id (FNV-1a), for its default color. */
function hashMachineId(environmentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash ^= environmentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The color of every known machine: the one chosen for it, else a default from
 * its id, stepping past colors already taken so no two known machines share one
 * while fewer than eight are known. Ids are settled in sorted order, so every
 * device that knows the same machines gives them the same colors.
 */
export function assignMachineColors(
  environmentIds: Iterable<string>,
  nicknames: MachineNicknames,
): ReadonlyMap<string, MachineColorId> {
  const ids = [...new Set([...environmentIds, ...Object.keys(nicknames)])].sort();
  const colors = new Map<string, MachineColorId>();
  const taken = new Set<MachineColorId>();
  for (const id of ids) {
    const chosen = nicknames[id]?.color;
    if (chosen === undefined) continue;
    colors.set(id, chosen);
    taken.add(chosen);
  }
  const count = MACHINE_COLOR_IDS.length;
  for (const id of ids) {
    if (colors.has(id)) continue;
    const start = hashMachineId(id) % count;
    let color = MACHINE_COLOR_IDS[start]!;
    for (let step = 0; step < count; step += 1) {
      const candidate = MACHINE_COLOR_IDS[(start + step) % count]!;
      if (!taken.has(candidate)) {
        color = candidate;
        break;
      }
    }
    colors.set(id, color);
    taken.add(color);
  }
  return colors;
}

/**
 * The stamp for a rename made now. It always beats the entry it replaces, so a
 * device whose clock runs behind the last writer's can still rename.
 */
export function nextMachineNicknameStamp(
  previous: MachineNickname | undefined,
  now: number,
): string {
  const floor = previous === undefined ? 0 : stamp(previous) + 1;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(now, floor)));
}
