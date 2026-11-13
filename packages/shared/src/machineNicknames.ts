import {
  MACHINE_COLOR_IDS,
  MACHINE_NICKNAME_MAX_LENGTH,
  MACHINE_SHORT_NAME_MAX_LENGTH,
  type MachineColorId,
  type MachineNickname,
  type MachineNicknames,
} from "@specweave-studio/contracts";
import { DateTime } from "effect";

import { graphemes } from "./machineShortLabel.ts";

/** Trims, collapses inner whitespace and caps a typed name at 16 characters. */
export function normalizeMachineNickname(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MACHINE_NICKNAME_MAX_LENGTH).trim();
}

/**
 * A typed short label: no spaces, whole visible characters only, and within the
 * stored limit of 3 code units (an accent or emoji is never cut in half). Empty
 * means "derive one".
 */
export function normalizeMachineShortName(short: string): string {
  let out = "";
  for (const part of graphemes(short.replace(/\s+/g, "").normalize("NFC"))) {
    if (out.length + part.length > MACHINE_SHORT_NAME_MAX_LENGTH) break;
    out += part;
  }
  return out;
}

/**
 * A computer name cut to fit the 16-character name field at a word boundary
 * ("Anton M5MAX PROLED" becomes "Anton M5MAX"), so the rename dialog never
 * opens over its limit. A single long word is cut at 16.
 */
export function fitMachineNickname(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length <= MACHINE_NICKNAME_MAX_LENGTH) return clean;
  const cut = clean.slice(0, MACHINE_NICKNAME_MAX_LENGTH + 1).lastIndexOf(" ");
  return (cut > 0 ? clean.slice(0, cut) : clean.slice(0, MACHINE_NICKNAME_MAX_LENGTH)).trim();
}

/**
 * A short name to offer for a machine that has none yet, read from its
 * computer name: the Apple chip in it ("Anton M5MAX PROLED" and "Anton's
 * MacBook M4MAX" offer "M5" and "M4"). Null when the name holds no chip, so
 * nothing is offered that the person would have to undo.
 */
export function suggestMachineNickname(hostLabel: string): string | null {
  for (const word of hostLabel.split(/[\s\-_.'’]+/u)) {
    const chip = /^m(\d{1,2})(?:max|pro|ultra)?$/iu.exec(word);
    if (chip) return `M${chip[1]}`;
  }
  return null;
}

/**
 * The id of another machine already shown under this name, compared without
 * case, or null. `names` maps each known machine id to the name it shows.
 */
export function machineNicknameHolder(
  names: ReadonlyMap<string, string>,
  environmentId: string,
  name: string,
): string | null {
  // Compared as shown, never cut to the 16-character field: a long computer name
  // differs from its first 16 characters.
  const fold = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const wanted = fold(normalizeMachineNickname(name));
  if (wanted === "") return null;
  for (const [id, shown] of names) {
    if (id !== environmentId && fold(shown) === wanted) {
      return id;
    }
  }
  return null;
}

const stamp = (entry: MachineNickname): number => {
  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const identityOf = (entry: MachineNickname) =>
  `${entry.color ?? ""}\u0000${entry.icon ?? ""}\u0000${entry.short ?? ""}`;

/**
 * Last writer wins. Equal stamps fall back to the name, then to the color and
 * icon, so every machine picks the same entry whichever order the changes
 * arrive in.
 *
 * A color, icon or short label is never dropped by a merge: the winner keeps its own, and
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
  const short = winner.short ?? other.short;
  if (color === winner.color && icon === winner.icon && short === winner.short) return winner;
  return {
    ...winner,
    ...(color === undefined ? {} : { color }),
    ...(icon === undefined ? {} : { icon }),
    ...(short === undefined ? {} : { short }),
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
      b[key]?.icon === a[key]!.icon &&
      b[key]?.short === a[key]!.short,
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
